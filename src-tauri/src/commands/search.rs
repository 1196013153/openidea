use crate::state::AppState;
use ide_core::{IdeResult, Pos, RequestId, TextEdit};
use ide_search::{
    FileMatches, ProjectFileSet, ReplaceEvent, ReplaceHost, ReplacePreview, ReplaceTarget, SearchQuery, SearchSummary,
};
use ide_workspace::Documents;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{State, Window};

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    File { file: FileMatches },
    Done { summary: SearchSummary },
}

/// Find in Files. Results stream through `on_event`; ends with `Done`.
/// Cancel with `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn search_start(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    mut query: SearchQuery,
    on_event: Channel<SearchEvent>,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    // Excluded roots (Project Structure marks and detected `target`, `node_modules`, …) and
    // ignored names are never searched.
    query.exclude.extend(project.search_excludes());
    let roots = project.roots();
    let set = match query.scope {
        ide_search::SearchScope::FileSet { set } => Some(set),
        _ => None,
    };
    let cancel = state.begin_request(request);
    let documents = project.documents.clone();
    let root = project.root.clone();
    let events = on_event.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let filter = |rel: &str| match set {
            Some(ProjectFileSet::Production) => !roots.is_test(rel),
            Some(ProjectFileSet::Test) => roots.is_test(rel),
            Some(ProjectFileSet::All) | None => true,
        };
        ide_search::search_filtered(&root, &query, Some(&filter), &|p| documents.text_of(p), &cancel, &|file| {
            let _ = events.send(SearchEvent::File { file });
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
    state.end_request(request);
    let _ = on_event.send(SearchEvent::Done { summary: summary? });
    Ok(())
}

/// Replace in Files. Runs off the command thread; progress streams through
/// `on_event` and ends with `Done`. Cancel with `cancel_request(request)`.
///
/// Edits go through the document layer as one patch per file, so open editors
/// update live and undo the whole file's replacements in one step. Unsaved
/// editor buffers are replaced in place and left unsaved; files that were not
/// open are opened transiently, saved and closed.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn replace_in_files(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    targets: Vec<ReplaceTarget>,
    on_event: Channel<ReplaceEvent>,
) -> IdeResult<()> {
    let project = state.project(window.label())?;
    let cancel = state.begin_request(request);
    let events = on_event.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let host = DocumentsHost(&project.documents);
        ide_search::replace_files(&host, &query, &replacement, preserve_case, &targets, &cancel, &|e| {
            let _ = events.send(e);
        })
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()));
    state.end_request(request);
    let summary = summary??;
    let _ = on_event.send(ReplaceEvent::Done { summary });
    Ok(())
}

/// Before / after text of `path` for Replace › Preview (unsaved buffer included).
#[tauri::command]
#[specta::specta]
pub async fn replace_preview(
    window: Window,
    state: State<'_, AppState>,
    query: SearchQuery,
    replacement: String,
    preserve_case: bool,
    path: PathBuf,
    only: Option<Vec<Pos>>,
) -> IdeResult<ReplacePreview> {
    let project = state.project(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = project.text_of(&path)?;
        ide_search::preview(&text, &query, &replacement, preserve_case, only.as_deref())
    })
    .await
    .map_err(|e| ide_core::IdeError::internal(e.to_string()))?
}

struct DocumentsHost<'a>(&'a Documents);

impl ReplaceHost for DocumentsHost<'_> {
    fn edit_file(&self, path: &Path, compute: &mut dyn FnMut(&str) -> IdeResult<Vec<TextEdit>>) -> IdeResult<u32> {
        let docs = self.0;
        let (doc, transient) = match docs.by_path(path) {
            Some(doc) => (doc, false),
            None => (docs.open(path)?.id, true),
        };
        let result = (|| {
            // Recompute if the user typed between reading the text and applying.
            for _ in 0..3 {
                let snap = docs.text_snapshot(doc)?;
                let edits = compute(&snap.text)?;
                if edits.is_empty() {
                    return Ok(0);
                }
                if docs.text_snapshot(doc)?.version != snap.version {
                    continue;
                }
                docs.apply_edits(doc, &edits)?;
                if transient {
                    docs.save(doc)?;
                }
                return Ok(edits.len() as u32);
            }
            Err(ide_core::IdeError::unavailable("the file kept changing during Replace"))
        })();
        if transient {
            docs.close(doc);
        }
        result
    }
}

/// Validates a query (e.g. regex syntax) while the user types.
#[tauri::command]
#[specta::specta]
pub fn search_validate(query: SearchQuery) -> IdeResult<()> {
    ide_search::validate_query(&query)
}
