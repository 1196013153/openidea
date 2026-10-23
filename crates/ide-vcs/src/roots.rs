//! The repositories of a project (IDEA's VCS roots): the one containing the project
//! root plus those nested below it (separate clones side by side, submodules).

use crate::{FileStatus, Repo};
use ide_core::IdeResult;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// How deep below the project root nested repositories are looked for.
const MAX_DEPTH: usize = 4;

/// Folders never searched for nested repositories (dependencies, build output).
const SKIPPED: &[&str] = &["node_modules", "target", "build", "dist", "out", "vendor", "venv", "__pycache__"];

/// The repositories of a project, sorted by root; lookups pick the innermost one.
#[derive(Clone, Default)]
pub struct Repos {
    repos: Vec<Arc<Repo>>,
    primary: Option<usize>,
}

impl Repos {
    /// The repository containing `project_root` and every repository whose worktree
    /// root lies below it (up to [`MAX_DEPTH`] levels; hidden and dependency folders and
    /// folders `skip` rejects are not searched).
    pub fn discover(project_root: &Path, skip: &dyn Fn(&Path) -> bool) -> IdeResult<Self> {
        let mut repos: Vec<Repo> = Vec::new();
        if let Some(r) = Repo::discover(project_root)? {
            repos.push(r);
        }
        let mut stack: Vec<(PathBuf, usize)> = vec![(project_root.to_path_buf(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let path = entry.path();
                if name.starts_with('.') || SKIPPED.contains(&name.as_ref()) || skip(&path) {
                    continue;
                }
                if path.join(".git").exists()
                    && let Ok(Some(r)) = Repo::discover(&path)
                    && r.root() == path
                    && !repos.iter().any(|x| x.root() == r.root())
                {
                    repos.push(r);
                }
                if depth + 1 < MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
            }
        }
        Ok(Self::new(repos, project_root))
    }

    /// Only the repository containing `project_root` (the quick lookup on project open).
    pub fn enclosing(project_root: &Path) -> IdeResult<Self> {
        Ok(Self::new(Repo::discover(project_root)?.into_iter().collect(), project_root))
    }

    /// Worktree roots, sorted.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.repos.iter().map(|r| r.root().to_path_buf()).collect()
    }

    fn new(mut repos: Vec<Repo>, project_root: &Path) -> Self {
        repos.sort_by(|a, b| a.root().cmp(b.root()));
        let repos: Vec<Arc<Repo>> = repos.into_iter().map(Arc::new).collect();
        let primary = Self::innermost(&repos, project_root).or((!repos.is_empty()).then_some(0));
        Self { repos, primary }
    }

    fn innermost(repos: &[Arc<Repo>], path: &Path) -> Option<usize> {
        repos
            .iter()
            .enumerate()
            .filter(|(_, r)| path.starts_with(r.root()))
            .max_by_key(|(_, r)| r.root().as_os_str().len())
            .map(|(i, _)| i)
    }

    pub fn is_empty(&self) -> bool {
        self.repos.is_empty()
    }

    pub fn all(&self) -> &[Arc<Repo>] {
        &self.repos
    }

    /// The repository of the project root, else the first one.
    pub fn primary(&self) -> Option<&Arc<Repo>> {
        self.primary.map(|i| &self.repos[i])
    }

    /// The innermost repository containing `path` (a file, folder or repository root).
    pub fn for_path(&self, path: &Path) -> Option<&Arc<Repo>> {
        Self::innermost(&self.repos, path).map(|i| &self.repos[i]).or_else(|| {
            // Another spelling of the same location (symlinks, /var vs /private/var).
            let canon = dunce::canonicalize(path).ok()?;
            self.repos
                .iter()
                .filter(|r| dunce::canonicalize(r.root()).is_ok_and(|root| canon.starts_with(root)))
                .max_by_key(|r| r.root().as_os_str().len())
        })
    }

    /// `paths` grouped by the repository each belongs to (paths outside every repository are dropped).
    pub fn group(&self, paths: &[PathBuf]) -> Vec<(Arc<Repo>, Vec<PathBuf>)> {
        let mut out: Vec<(Arc<Repo>, Vec<PathBuf>)> = Vec::new();
        for p in paths {
            let Some(repo) = self.for_path(p) else { continue };
            match out.iter_mut().find(|(r, _)| Arc::ptr_eq(r, repo)) {
                Some((_, list)) => list.push(p.clone()),
                None => out.push((repo.clone(), vec![p.clone()])),
            }
        }
        out
    }

    /// Changes of every repository. A nested repository reports its own files, so the
    /// enclosing one's "untracked folder" entry for it is dropped.
    pub fn status(&self) -> IdeResult<Vec<FileStatus>> {
        let mut out = Vec::new();
        for repo in &self.repos {
            let nested: Vec<&Path> = self
                .repos
                .iter()
                .map(|r| r.root())
                .filter(|r| *r != repo.root() && r.starts_with(repo.root()))
                .collect();
            out.extend(repo.status()?.into_iter().filter(|f| {
                let untracked_root =
                    f.unstaged == Some(crate::ChangeKind::Untracked) && nested.iter().any(|n| f.path.0 == *n);
                !untracked_root
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let ok = Command::new("git").args(["init", "-q"]).current_dir(dir).status().is_ok_and(|s| s.success());
        assert!(ok, "git init in {}", dir.display());
    }

    #[test]
    fn finds_nested_repositories_and_routes_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        git_init(&root);
        git_init(&root.join("services/api"));
        git_init(&root.join("web"));
        git_init(&root.join("node_modules/dep"));
        git_init(&root.join(".cache/repo"));
        std::fs::write(root.join("services/api/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();

        let repos = Repos::discover(&root, &|_| false).unwrap();
        let roots: Vec<&Path> = repos.all().iter().map(|r| r.root()).collect();
        assert_eq!(roots, [root.as_path(), &root.join("services/api"), &root.join("web")]);
        assert_eq!(repos.primary().unwrap().root(), root);
        assert_eq!(repos.for_path(&root.join("services/api/main.rs")).unwrap().root(), root.join("services/api"));
        assert_eq!(repos.for_path(&root.join("services/other.txt")).unwrap().root(), root);

        let status = repos.status().unwrap();
        let paths: Vec<String> =
            status.iter().map(|f| f.path.0.strip_prefix(&root).unwrap().to_string_lossy().into_owned()).collect();
        assert!(paths.contains(&"README.md".to_owned()), "{paths:?}");
        assert!(paths.contains(&"services/api/main.rs".to_owned()), "{paths:?}");
        assert!(
            !paths.iter().any(|p| p.trim_end_matches('/') == "web"),
            "nested root is not an untracked folder: {paths:?}"
        );

        let groups = repos.group(&[root.join("README.md"), root.join("services/api/main.rs"), root.join("web/x")]);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[1].1, [root.join("services/api/main.rs")]);

        let skipped = Repos::discover(&root, &|p| p.ends_with("services")).unwrap();
        assert_eq!(skipped.all().len(), 2);
    }

    #[test]
    fn side_by_side_repositories_without_an_enclosing_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        git_init(&root.join("a"));
        git_init(&root.join("b"));
        let repos = Repos::discover(&root, &|_| false).unwrap();
        assert_eq!(repos.all().len(), 2);
        assert_eq!(repos.primary().unwrap().root(), root.join("a"), "the first when none contains the project root");
        assert!(repos.for_path(&root.join("c.txt")).is_none());
    }
}
