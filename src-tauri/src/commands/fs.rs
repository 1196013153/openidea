use crate::commands::doc::blocking;
use crate::state::AppState;
use ide_core::IdeResult;
use ide_vfs::FileEntry;
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
#[specta::specta]
pub fn fs_read_dir(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<FileEntry>> {
    let excludes = state
        .project(window.label())
        .map(|p| {
            let globs = p.exclude_globs();
            // `read_dir` matches relative to the enclosing repository: re-anchor
            // project-root patterns (`/build`) when the project is a repo subfolder.
            let repo = p.root.ancestors().find(|d| d.join(".git").exists());
            match repo.and_then(|r| p.root.strip_prefix(r).ok()).filter(|rel| !rel.as_os_str().is_empty()) {
                Some(rel) => {
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    globs.into_iter().map(|g| if g.starts_with('/') { format!("/{rel}{g}") } else { g }).collect()
                }
                None => globs,
            }
        })
        .unwrap_or_default();
    ide_vfs::read_dir(&path, &excludes)
}

/// Creates an empty file; inside a project, honours the EditorConfig
/// `charset` (writes the BOM for `utf-8-bom` / UTF-16).
#[tauri::command]
#[specta::specta]
pub fn fs_create_file(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    match state.project(window.label()) {
        Ok(p) => {
            let defaults = p.documents.file_defaults();
            if defaults.editorconfig {
                ide_workspace::editorconfig::create_file(p.documents.editorconfig(), &path)?;
            } else {
                ide_vfs::create_file(&path)?;
            }
            // No EditorConfig charset: File Encodings › "Create UTF-8 files with BOM".
            let empty = std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(false);
            let bom = defaults.new_file_bytes();
            if empty && !bom.is_empty() {
                std::fs::write(&path, bom)?;
            }
            Ok(())
        }
        Err(_) => ide_vfs::create_file(&path),
    }
}

#[tauri::command]
#[specta::specta]
pub fn fs_create_dir(path: PathBuf) -> IdeResult<()> {
    ide_vfs::create_dir(&path)
}

#[tauri::command]
#[specta::specta]
pub fn fs_rename(from: PathBuf, to: PathBuf) -> IdeResult<()> {
    ide_vfs::rename(&from, &to)
}

/// Toggle Read-only Attribute: sets the writable bit (and the open document's
/// state). Returns whether the file is read-only now.
#[tauri::command]
#[specta::specta]
pub fn fs_set_writable(window: Window, state: State<'_, AppState>, path: PathBuf, writable: bool) -> IdeResult<bool> {
    match state.project(window.label()) {
        Ok(p) => p.documents.set_writable(&path, writable),
        Err(_) => ide_vfs::set_writable(&path, writable).map(|()| !writable),
    }
}

/// Moving to the trash can take a while (large trees): kept off the main thread.
#[tauri::command]
#[specta::specta]
pub async fn fs_delete(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<()> {
    // Local History keeps the contents so deleted files can be restored.
    let history = state.project(window.label()).ok().map(|p| p.history.clone());
    blocking(move || {
        if let Some(h) = history {
            h.record_deletion(&path, DELETE_SNAPSHOT_LIMIT);
        }
        ide_vfs::delete(&path)
    })
    .await
}

/// Files of a deleted folder snapshotted in Local History.
const DELETE_SNAPSHOT_LIMIT: usize = 2000;

#[tauri::command]
#[specta::specta]
pub async fn fs_copy(from: PathBuf, to: PathBuf) -> IdeResult<()> {
    blocking(move || ide_vfs::copy(&from, &to)).await
}

/// Reads a text file without opening it as a document (previews, quick
/// definition). Prefers the unsaved buffer when the file is open.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_text(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<String> {
    let project = state.project(window.label()).ok();
    blocking(move || match project {
        Some(p) => p.text_of(&path),
        None => Ok(ide_vfs::load_text(&path)?.text),
    })
    .await
}
