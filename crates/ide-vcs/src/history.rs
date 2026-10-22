//! Commit history (topological walk) and per-commit changed files via gitoxide.

use crate::repo::{gx, resolve, to_string};
use crate::{ChangeKind, ChangedFile, Commit, LogQuery, Repo};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use ide_core::{IdeError, IdeResult};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Log "Text or hash" filter: the message (substring or regex), or a hash prefix.
enum TextFilter {
    Plain { needle: String, match_case: bool },
    Regex(regex_lite::Regex),
}

impl TextFilter {
    fn new(text: &str, regex: bool, match_case: bool) -> IdeResult<Option<Self>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        if regex {
            let re = regex_lite::RegexBuilder::new(text)
                .case_insensitive(!match_case)
                .multi_line(true)
                .build()
                .map_err(|e| IdeError::invalid(format!("invalid regular expression: {e}")))?;
            return Ok(Some(Self::Regex(re)));
        }
        let needle = if match_case { text.to_string() } else { text.to_lowercase() };
        Ok(Some(Self::Plain { needle, match_case }))
    }

    fn matches(&self, message: &str, id: &ObjectId) -> bool {
        match self {
            Self::Regex(re) => re.is_match(message),
            Self::Plain { needle, match_case } => {
                let hash = needle.len() >= 4 && needle.bytes().all(|b| b.is_ascii_hexdigit());
                if hash && id.to_string().starts_with(&needle.to_ascii_lowercase()) {
                    return true;
                }
                if *match_case {
                    message.contains(needle.as_str())
                } else {
                    message.to_lowercase().contains(needle.as_str())
                }
            }
        }
    }
}

pub(crate) fn log(r: &Repo, q: &LogQuery) -> IdeResult<Vec<Commit>> {
    let repo = r.gix()?;
    let range = q.range.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let tips = if range.is_some() { Vec::new() } else { tips(&repo, q.branch.as_deref())? };
    if tips.is_empty() && range.is_none() {
        return Ok(Vec::new());
    }
    let decorations = decorations(&repo)?;
    let path_filter = match q.path.as_deref() {
        Some(p) => {
            let rel = r.rel_path(p)?;
            if rel.is_empty() { None } else { Some(rel) }
        }
        None => None,
    };
    let author = q.author.as_deref().map(str::to_lowercase).filter(|s| !s.is_empty());
    let text = q.text.as_deref().map(|t| TextFilter::new(t, q.text_regex, q.text_match_case)).transpose()?.flatten();
    let limit = if q.limit == 0 { usize::MAX } else { q.limit as usize };
    let mut to_skip = q.skip as usize;

    type Walk<'a> = Box<dyn Iterator<Item = IdeResult<(ObjectId, Vec<ObjectId>)>> + 'a>;
    let walk: Walk<'_> = if let Some(range) = range {
        let ids = range_ids(r, range, path_filter.as_deref())?;
        let repo = &repo;
        Box::new(ids.into_iter().map(move |id| {
            let commit = repo.find_commit(id).map_err(gx)?;
            Ok((id, commit.parent_ids().map(|p| p.detach()).collect()))
        }))
    } else if let Some(rel) = path_filter {
        Box::new(PathWalk::new(&repo, tips, rel)?)
    } else if repo.is_shallow().unwrap_or(false) {
        // Topological order needs complete history; shallow clones fall back to date order.
        let walk = repo
            .rev_walk(tips)
            .sorting(gix::revision::walk::Sorting::ByCommitTime(Default::default()))
            .all()
            .map_err(gx)?;
        Box::new(walk.map(|info| info.map(|i| (i.id, i.parent_ids.to_vec())).map_err(gx)))
    } else {
        let graph = repo.commit_graph_if_enabled().ok().flatten();
        let topo = gix::traverse::commit::topo::Builder::from_iters(&repo.objects, tips, None::<Vec<ObjectId>>)
            .sorting(gix::traverse::commit::topo::Sorting::TopoOrder)
            .with_commit_graph(graph)
            .build()
            .map_err(gx)?;
        Box::new(topo.map(|info| info.map(|i| (i.id, i.parent_ids.to_vec())).map_err(gx)))
    };

    let mut out = Vec::new();
    for item in walk {
        let (id, parents) = item?;
        let commit = repo.find_commit(id).map_err(gx)?;
        let sig = commit.author().map_err(gx)?;
        let name = to_string(sig.name.trim().as_bstr());
        let email = to_string(sig.email.trim().as_bstr());
        if let Some(needle) = author.as_deref()
            && !name.to_lowercase().contains(needle)
            && !email.to_lowercase().contains(needle)
        {
            continue;
        }
        let message = to_string(commit.message_raw_sloppy());
        if let Some(filter) = text.as_ref()
            && !filter.matches(&message, &id)
        {
            continue;
        }
        if to_skip > 0 {
            to_skip -= 1;
            continue;
        }
        let time_ms = sig.time().map(|t| t.seconds as f64 * 1000.0).unwrap_or(0.0);
        let summary = message.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        let hex = id.to_string();
        out.push(Commit {
            short_id: hex[..hex.len().min(8)].to_string(),
            id: hex,
            parents: parents.iter().map(ToString::to_string).collect(),
            author: name,
            email,
            time_ms,
            summary,
            message: message.trim_end().to_string(),
            refs: decorations.get(&id).cloned().unwrap_or_default(),
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Commit ids of a revision range (`A..B`, `A...B`, `^A B`…), topologically ordered, via
/// `git rev-list` so every rev syntax git understands (`@{u}`, `HEAD~3`) works.
fn range_ids(r: &Repo, range: &str, path: Option<&str>) -> IdeResult<Vec<ObjectId>> {
    let mut args: Vec<&str> = vec!["rev-list", "--topo-order", "--end-of-options"];
    for part in range.split_whitespace() {
        if part.starts_with('-') {
            return Err(ide_core::IdeError::invalid(format!("invalid revision range '{range}'")));
        }
        args.push(part);
    }
    if let Some(rel) = path {
        args.extend(["--", rel]);
    }
    let out = crate::cli::run(r.root(), &args, None)?;
    out.stdout_str()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| ObjectId::from_hex(l.trim().as_bytes()).map_err(gx))
        .collect()
}

/// Starting points of the walk: the given revision, or HEAD + all branches.
fn tips(repo: &gix::Repository, branch: Option<&str>) -> IdeResult<Vec<ObjectId>> {
    if let Some(rev) = branch.filter(|b| !b.trim().is_empty()) {
        let id = resolve(repo, rev)?;
        let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
        return Ok(vec![commit.id]);
    }
    let mut tips = Vec::new();
    if let Ok(id) = repo.head_id() {
        tips.push(id.detach());
    }
    let platform = repo.references().map_err(gx)?;
    for iter in [platform.local_branches().map_err(gx)?, platform.remote_branches().map_err(gx)?] {
        for reference in iter {
            let Ok(mut reference) = reference else { continue };
            if let Ok(id) = reference.peel_to_id() {
                let id = id.detach();
                if !tips.contains(&id) && repo.find_commit(id).is_ok() {
                    tips.push(id);
                }
            }
        }
    }
    Ok(tips)
}

/// Commit id → decoration labels.
fn decorations(repo: &gix::Repository) -> IdeResult<HashMap<ObjectId, Vec<String>>> {
    let mut map: HashMap<ObjectId, Vec<String>> = HashMap::new();
    if let Ok(id) = repo.head_id() {
        map.entry(id.detach()).or_default().push("HEAD".to_string());
    }
    let platform = repo.references().map_err(gx)?;
    for reference in platform.all().map_err(gx)? {
        let Ok(mut reference) = reference else { continue };
        let full = reference.name().as_bstr().to_owned();
        let label = if let Some(n) = full.strip_prefix(b"refs/heads/") {
            to_string(n.as_bstr())
        } else if let Some(n) = full.strip_prefix(b"refs/remotes/") {
            if n.ends_with(b"/HEAD") {
                continue;
            }
            to_string(n.as_bstr())
        } else if let Some(n) = full.strip_prefix(b"refs/tags/") {
            format!("tag: {}", to_string(n.as_bstr()))
        } else {
            continue;
        };
        let Ok(id) = reference.peel_to_id() else { continue };
        map.entry(id.detach()).or_default().push(label);
    }
    Ok(map)
}

/// Commits touching a path, newest first, with git's default history simplification:
/// a commit is shown when its entry for the path differs from every parent, and at a
/// merge that kept one parent's version only that parent's line of history is followed.
struct PathWalk<'r> {
    repo: &'r gix::Repository,
    rel: String,
    queue: std::collections::BinaryHeap<(i64, u64, ObjectId)>,
    seen: HashSet<ObjectId>,
    memo: HashMap<ObjectId, Option<ObjectId>>,
    seq: u64,
}

impl<'r> PathWalk<'r> {
    fn new(repo: &'r gix::Repository, tips: Vec<ObjectId>, rel: String) -> IdeResult<Self> {
        let mut walk = PathWalk {
            repo,
            rel,
            queue: Default::default(),
            seen: Default::default(),
            memo: Default::default(),
            seq: 0,
        };
        for tip in tips {
            walk.push(tip)?;
        }
        Ok(walk)
    }

    fn push(&mut self, id: ObjectId) -> IdeResult<()> {
        if !self.seen.insert(id) || !self.repo.has_object(id) {
            return Ok(());
        }
        let time = self.repo.find_commit(id).map_err(gx)?.time().map(|t| t.seconds).unwrap_or(0);
        // Max-heap on time; among equal times, earlier insertion first.
        self.seq += 1;
        self.queue.push((time, u64::MAX - self.seq, id));
        Ok(())
    }

    fn step(&mut self) -> IdeResult<Option<(ObjectId, Vec<ObjectId>)>> {
        while let Some((_, _, id)) = self.queue.pop() {
            let commit = self.repo.find_commit(id).map_err(gx)?;
            let parents: Vec<ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
            // Parents cut off by a shallow boundary are treated as absent.
            let present: Vec<ObjectId> = parents.iter().copied().filter(|p| self.repo.has_object(p)).collect();
            let mine = path_entry(self.repo, id, &self.rel, &mut self.memo)?;
            let mut same_parent = None;
            for p in &present {
                if path_entry(self.repo, *p, &self.rel, &mut self.memo)? == mine {
                    same_parent = Some(*p);
                    break;
                }
            }
            match same_parent {
                Some(p) => self.push(p)?,
                None => {
                    for p in &present {
                        self.push(*p)?;
                    }
                    if !present.is_empty() || mine.is_some() {
                        return Ok(Some((id, parents)));
                    }
                }
            }
        }
        Ok(None)
    }
}

impl Iterator for PathWalk<'_> {
    type Item = IdeResult<(ObjectId, Vec<ObjectId>)>;
    fn next(&mut self) -> Option<Self::Item> {
        self.step().transpose()
    }
}

/// Id of the tree entry at `rel` in `commit` (memoised).
fn path_entry(
    repo: &gix::Repository,
    commit: ObjectId,
    rel: &str,
    memo: &mut HashMap<ObjectId, Option<ObjectId>>,
) -> IdeResult<Option<ObjectId>> {
    if let Some(v) = memo.get(&commit) {
        return Ok(*v);
    }
    let commit_obj = repo.find_commit(commit).map_err(gx)?;
    let tree = commit_obj.tree().map_err(gx)?;
    let id = tree.lookup_entry_by_path(Path::new(rel)).map_err(gx)?.map(|e| e.object_id());
    memo.insert(commit, id);
    Ok(id)
}

pub(crate) fn commit_files(r: &Repo, rev: &str) -> IdeResult<Vec<ChangedFile>> {
    let repo = r.gix()?;
    let id = resolve(&repo, rev)?;
    let commit = repo.find_object(id).map_err(gx)?.peel_to_commit().map_err(gx)?;
    let new_tree = commit.tree().map_err(gx)?;
    let old_tree = match commit.parent_ids().next() {
        Some(p) => Some(repo.find_commit(p.detach()).map_err(gx)?.tree().map_err(gx)?),
        None => None,
    };
    let mut opts = gix::diff::Options::default();
    opts.track_path().track_rewrites(Some(gix::diff::Rewrites::default()));
    let changes = repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(opts)).map_err(gx)?;
    let mut out = Vec::new();
    for change in changes {
        use gix::object::tree::diff::ChangeDetached as C;
        let file = match change {
            C::Addition { location, entry_mode, .. } if !entry_mode.is_tree() => {
                ChangedFile { path: to_string(location.as_ref()), kind: ChangeKind::Added, old_path: None }
            }
            C::Deletion { location, entry_mode, .. } if !entry_mode.is_tree() => {
                ChangedFile { path: to_string(location.as_ref()), kind: ChangeKind::Deleted, old_path: None }
            }
            C::Modification { location, entry_mode, .. } if !entry_mode.is_tree() => {
                ChangedFile { path: to_string(location.as_ref()), kind: ChangeKind::Modified, old_path: None }
            }
            C::Rewrite { source_location, location, entry_mode, copy, .. } if !entry_mode.is_tree() => ChangedFile {
                path: to_string(location.as_ref()),
                kind: if copy { ChangeKind::Added } else { ChangeKind::Renamed },
                old_path: Some(to_string(source_location.as_ref())),
            },
            _ => continue,
        };
        out.push(file);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}
