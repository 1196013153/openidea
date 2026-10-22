//! Which paths belong in the index: `.gitignore`/`.ignore` rules (via the
//! `ignore` crate) plus the user's `files.exclude` globs.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{WalkBuilder, WalkState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::UNIX_EPOCH;

/// VCS metadata directories are never indexed.
const ALWAYS_SKIP: &[&str] = &[".git", ".hg", ".svn", ".jj", ".DS_Store"];

pub(crate) struct PathFilter {
    root: PathBuf,
    excludes: GlobSet,
    /// Root-level ignore files, for paths reported by the watcher (the walker
    /// applies nested ignore files itself).
    gitignore: Gitignore,
}

#[derive(Clone, Debug)]
pub(crate) struct Found {
    pub path: PathBuf,
    pub mtime: u64,
    pub size: u64,
}

pub(crate) fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64)
}

impl PathFilter {
    pub(crate) fn new(root: &Path, excludes: &[String]) -> Self {
        let mut set = GlobSetBuilder::new();
        for raw in excludes {
            let p = raw.trim().trim_end_matches('/');
            let anchored = p.starts_with('/');
            let p = p.trim_start_matches("./").trim_start_matches('/');
            if p.is_empty() {
                continue;
            }
            let mut patterns = vec![p.to_owned()];
            if !anchored && !p.contains('/') {
                patterns.push(format!("**/{p}"));
            }
            for pat in patterns {
                match GlobBuilder::new(&pat).literal_separator(true).build() {
                    Ok(g) => {
                        set.add(g);
                    }
                    Err(e) => tracing::warn!("invalid exclude glob {raw:?}: {e}"),
                }
            }
        }
        let excludes = set.build().unwrap_or_else(|_| GlobSet::empty());
        let mut gi = GitignoreBuilder::new(root);
        for f in [".gitignore", ".ignore", ".git/info/exclude"] {
            let path = root.join(f);
            if path.is_file()
                && let Some(e) = gi.add(&path)
            {
                tracing::debug!("{}: {e}", path.display());
            }
        }
        let gitignore = gi.build().unwrap_or_else(|_| Gitignore::empty());
        Self { root: root.to_owned(), excludes, gitignore }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// `/`-separated path relative to the root.
    pub(crate) fn rel(&self, path: &Path) -> Option<String> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let mut out = String::new();
        for c in rel.components() {
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&c.as_os_str().to_string_lossy());
        }
        (!out.is_empty()).then_some(out)
    }

    fn excluded_rel(&self, rel: &str) -> bool {
        self.excludes.is_match(rel)
    }

    fn skip_name(name: &str) -> bool {
        ALWAYS_SKIP.contains(&name)
    }

    /// Whether a path reported by the watcher should be ignored (outside the
    /// root, inside an excluded/ignored directory, or ignored itself).
    pub(crate) fn is_excluded(&self, path: &Path, is_dir: bool) -> bool {
        let Some(rel) = self.rel(path) else { return true };
        let mut prefix = String::new();
        for seg in rel.split('/') {
            if Self::skip_name(seg) {
                return true;
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(seg);
            if self.excluded_rel(&prefix) {
                return true;
            }
        }
        self.gitignore.matched_path_or_any_parents(path, is_dir).is_ignore()
    }

    /// All indexable files at or below `dir`, walked in parallel.
    /// Stops early (returning what was found so far) once `cancel` is set.
    pub(crate) fn walk(&self, dir: &Path, cancel: &AtomicBool) -> Vec<Found> {
        let (tx, rx) = mpsc::channel::<Vec<Found>>();
        let root = self.root.clone();
        let excludes = self.excludes.clone();
        let walker = WalkBuilder::new(dir)
            .hidden(false)
            .parents(true)
            .ignore(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .require_git(false)
            .follow_links(false)
            .filter_entry(move |e| {
                let name = e.file_name().to_string_lossy();
                if Self::skip_name(&name) {
                    return false;
                }
                match e.path().strip_prefix(&root) {
                    Ok(rel) if !rel.as_os_str().is_empty() => {
                        let rel = rel.to_string_lossy();
                        let rel = if std::path::MAIN_SEPARATOR == '/' { rel } else { rel.replace('\\', "/").into() };
                        !excludes.is_match(rel.as_ref())
                    }
                    _ => true,
                }
            })
            .build_parallel();
        walker.run(|| {
            let mut batch = Batch { tx: tx.clone(), items: Vec::with_capacity(256) };
            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if entry.file_type().is_some_and(|t| t.is_file())
                    && let Ok(meta) = entry.metadata()
                {
                    batch.items.push(Found { path: entry.into_path(), mtime: mtime_of(&meta), size: meta.len() });
                    if batch.items.len() >= 256 && batch.tx.send(std::mem::take(&mut batch.items)).is_err() {
                        return WalkState::Quit;
                    }
                }
                WalkState::Continue
            })
        });
        drop(tx);
        rx.into_iter().flatten().collect()
    }
}

/// Per-walker-thread buffer; the remainder is sent when the walker drops the visitor.
struct Batch {
    tx: mpsc::Sender<Vec<Found>>,
    items: Vec<Found>,
}

impl Drop for Batch {
    fn drop(&mut self) {
        if !self.items.is_empty() {
            let _ = self.tx.send(std::mem::take(&mut self.items));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }

    #[test]
    fn walk_honours_gitignore_and_excludes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for f in [
            "src/a.rs",
            "src/deep/b.rs",
            "node_modules/x/index.js",
            "target/debug/out.rs",
            "build/gen.rs",
            ".git/config",
            ".github/workflows/ci.yml",
            "docs/skip.md",
        ] {
            touch(&root, f);
        }
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        let filter = PathFilter::new(&root, &["**/node_modules".into(), "target".into(), "docs/**".into()]);
        let mut found: Vec<String> =
            filter.walk(&root, &AtomicBool::new(false)).iter().filter_map(|f| filter.rel(&f.path)).collect();
        found.sort();
        assert_eq!(found, vec![".github/workflows/ci.yml", ".gitignore", "src/a.rs", "src/deep/b.rs"]);

        assert!(filter.is_excluded(&root.join("node_modules/y.js"), false));
        assert!(filter.is_excluded(&root.join("a/target/z.rs"), false));
        assert!(filter.is_excluded(&root.join("build/new.rs"), false));
        assert!(filter.is_excluded(&root.join(".git/HEAD"), false));
        assert!(filter.is_excluded(Path::new("/elsewhere/x.rs"), false));
        assert!(!filter.is_excluded(&root.join("src/new.rs"), false));
    }
}
