//! File move / rename refactoring: reference updates from the language
//! servers, the move itself (one undoable step) and its undo.

use crate::state::{AppState, apply_workspace_edit};
use ide_core::{IdeResult, RequestId, WorkspaceEdit};
use ide_lsp::types::FileRenameEdits;
use ide_workspace::{FileMove, UndoOutcome};
use std::path::PathBuf;
use tauri::{State, Window};

use super::doc::blocking;

fn pairs(moves: &[FileMove]) -> Vec<(PathBuf, PathBuf)> {
    moves.iter().map(|m| (m.from.to_path_buf(), m.to.to_path_buf())).collect()
}

/// `workspace/willRenameFiles` on every interested server (before the move). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn refactor_file_move_edits(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    let project = state.project(window.label())?;
    let token = state.begin_request(request);
    let result = project.lsp.will_rename_files(&pairs(&moves), token).await;
    state.end_request(request);
    result
}

/// Applies `edit` (from [`refactor_file_move_edits`], possibly empty), moves the
/// files and notifies the servers. Returns the id for [`refactor_undo_file_move`].
#[tauri::command]
#[specta::specta]
pub async fn refactor_move_files(
    window: Window,
    state: State<'_, AppState>,
    moves: Vec<FileMove>,
    edit: WorkspaceEdit,
    label: String,
) -> IdeResult<u32> {
    let project = state.project(window.label())?;
    let p = project.clone();
    let moved = moves.clone();
    let id = blocking(move || {
        let apply = |e: &WorkspaceEdit| apply_workspace_edit(&p.documents, e);
        p.moves.perform(&p.documents, Some(&p.history), &moved, &edit, &label, &apply)
    })
    .await?;
    project.lsp.did_rename_files(&pairs(&moves));
    Ok(id)
}

/// Undoes a file move: moves back and reverts the reference updates.
#[tauri::command]
#[specta::specta]
pub async fn refactor_undo_file_move(window: Window, state: State<'_, AppState>, id: u32) -> IdeResult<UndoOutcome> {
    let project = state.project(window.label())?;
    let p = project.clone();
    let outcome = blocking(move || p.moves.undo(&p.documents, id)).await?;
    project.lsp.did_rename_files(&pairs(&outcome.moves));
    Ok(outcome)
}

/// Whether the file move `id` can still be undone.
#[tauri::command]
#[specta::specta]
pub fn refactor_can_undo_file_move(window: Window, state: State<'_, AppState>, id: u32) -> IdeResult<bool> {
    Ok(state.project(window.label())?.moves.can_undo(id))
}

/// "Search in comments and strings": textual occurrences of the moved files'
/// names, qualified names and paths (before the move). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn refactor_file_move_text_edits(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<WorkspaceEdit> {
    let project = state.project(window.label())?;
    let token = state.begin_request(request);
    let cancel = token.clone();
    let result = blocking(move || {
        let replacements = ide_workspace::text_refs::move_replacements(&project.root, &project.roots(), &moves);
        let edit = ide_workspace::text_refs::find_text_occurrences(
            &project.root,
            &project.exclude_globs(),
            &replacements,
            &|| cancel.is_cancelled(),
        );
        if cancel.is_cancelled() { Err(ide_core::IdeError::cancelled()) } else { Ok(edit) }
    })
    .await;
    state.end_request(request);
    result
}
