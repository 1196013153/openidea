use super::doc::blocking;
use crate::state::{AppState, Project};
use ide_core::{DocId, IdeResult, IpcPath, Location, Pos};
use ide_index::{FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use ide_language::{FileReference, WebReference};
use ide_workspace::file_refs::{self, PathCompletion};
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

#[tauri::command]
#[specta::specta]
pub fn remove_recent(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    state.project(window.label())?.index.remove_recent(&path);
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

/// The project root and its resource roots (served at `/`), for file references.
fn reference_roots(project: &Project) -> (PathBuf, Vec<PathBuf>) {
    let resources = project.roots().resource_dirs().iter().map(|d| project.root.join(d)).collect();
    (project.root.clone(), resources)
}

/// The existing file or directory a path written in `from` names (`href`, `url()`, a string literal).
#[tauri::command]
#[specta::specta]
pub async fn fs_resolve_reference(
    window: Window,
    state: State<'_, AppState>,
    from: IpcPath,
    value: String,
) -> IdeResult<Option<IpcPath>> {
    let project = state.project(window.label()).ok();
    blocking(move || {
        let (root, resources) = project.as_deref().map(reference_roots).unzip();
        let resources = resources.unwrap_or_default();
        Ok(file_refs::resolve(&value, &from, root.as_deref(), &resources).map(Into::into))
    })
    .await
}

/// Files and folders that continue `prefix`, a path being typed in `from`.
#[tauri::command]
#[specta::specta]
pub async fn path_completions(
    window: Window,
    state: State<'_, AppState>,
    from: IpcPath,
    prefix: String,
) -> IdeResult<Vec<PathCompletion>> {
    let project = state.project(window.label()).ok();
    blocking(move || {
        let (root, resources) = project.as_deref().map(reference_roots).unzip();
        let resources = resources.unwrap_or_default();
        Ok(file_refs::complete(&prefix, &from, root.as_deref(), &resources))
    })
    .await
}

/// Paths in an HTML document or stylesheet that name no existing file.
#[tauri::command]
#[specta::specta]
pub async fn web_unresolved_references(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
) -> IdeResult<Vec<FileReference>> {
    let project = state.project(window.label())?;
    let syntax = state.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        let (root, resources) = reference_roots(&project);
        Ok(syntax
            .web_file_references(&snap.language, &snap.text)
            .into_iter()
            .filter(|r| {
                file_refs::is_file_reference(&r.value)
                    && !file_refs::path_part(&r.value).is_empty()
                    && file_refs::resolve(&r.value, &snap.path, Some(&root), &resources).is_none()
            })
            .collect())
    })
    .await
}
