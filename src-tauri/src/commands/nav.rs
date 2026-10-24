use super::doc::blocking;
use crate::state::AppState;
use ide_core::{DocId, IdeResult, Location, Pos};
use ide_index::{FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use ide_language::WebReference;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn index_status(window: Window, state: State<'_, AppState>) -> IdeResult<IndexStatus> {
    Ok(state.project(window.label())?.index.status())
}

#[tauri::command]
#[specta::specta]
pub fn find_files(window: Window, state: State<'_, AppState>, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    Ok(state.project(window.label())?.index.find_files(&query, limit as usize))
}

#[tauri::command]
#[specta::specta]
pub fn find_symbols(
    window: Window,
    state: State<'_, AppState>,
    query: String,
    filter: SymbolFilter,
    limit: u32,
) -> IdeResult<Vec<SymbolMatch>> {
    Ok(state.project(window.label())?.index.find_symbols(&query, filter, limit as usize))
}

#[tauri::command]
#[specta::specta]
pub fn mark_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.project(window.label())?.index.mark_recent(&path);
    Ok(())
}

/// Recently opened files, most recent first (⌘E).
#[tauri::command]
#[specta::specta]
pub fn recent_files(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ide_core::IpcPath>> {
    Ok(state.project(window.label())?.index.recent_files().into_iter().map(Into::into).collect())
}

/// A web reference no language server resolves and where it points: `class="card"` →
/// `.card` selectors, `id` → `#id` selectors, `href="#top"` → the element, `var(--x)` →
/// `--x:` declarations.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebGoto {
    pub reference: WebReference,
    pub targets: Vec<Location>,
}

const MAX_WEB_TARGETS: usize = 200;

/// The web reference at `pos` of `doc` and its targets; `None` when there is no reference.
#[tauri::command]
#[specta::specta]
pub async fn web_goto(window: Window, state: State<'_, AppState>, doc: DocId, pos: Pos) -> IdeResult<Option<WebGoto>> {
    let project = state.project(window.label())?;
    let syntax = state.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large {
            return Ok(None);
        }
        let Some(reference) = syntax.web_reference_at(&snap.language, &snap.text, pos) else { return Ok(None) };
        let here = |range| Location { path: snap.path.clone(), range, uri: None };
        let targets = match reference.symbol() {
            None => syntax.web_anchors(&snap.language, &snap.text, &reference.name).into_iter().map(here).collect(),
            Some((name, kind)) => {
                // The open document from its (possibly unsaved) text, other files from the index.
                let mut targets: Vec<Location> = syntax
                    .web_definitions(&snap.language, &snap.text)
                    .into_iter()
                    .filter(|t| t.name == name && t.kind == kind)
                    .map(|t| here(t.range))
                    .collect();
                targets.extend(
                    project
                        .index
                        .symbols_named(&name, Some(kind), MAX_WEB_TARGETS)
                        .into_iter()
                        .filter(|m| *m.path != *snap.path)
                        .map(|m| Location { path: m.path, range: m.range, uri: None }),
                );
                targets
            }
        };
        Ok(Some(WebGoto { reference, targets }))
    })
    .await
}
