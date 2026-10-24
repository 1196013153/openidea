use crate::state::AppState;
use ide_core::{ChangeSet, DocId, IdeError, IdeResult, OutlineItem, Range};
use ide_language::{FoldRange, SyntaxHighlights};
use ide_text::LineEnding;
use ide_workspace::{DocumentInfo, HistoryEntry};
use std::path::PathBuf;
use tauri::{State, Window};

/// Runs blocking work (disk I/O, parsing, large copies) on the blocking pool,
/// keeping it off the main thread and the async runtime's workers.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Opens a document. Async: reading and decoding a large file must not block
/// the main thread (synchronous commands run on it).
#[tauri::command]
#[specta::specta]
pub async fn doc_open(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<DocumentInfo> {
    let project = state.project(window.label())?;
    blocking(move || {
        let info = project.documents.open(&path)?;
        project.index.mark_recent(&path);
        Ok(info)
    })
    .await
}

/// Opens a read-only virtual document (see `lsp_virtual_document`) as an
/// editor buffer, so syntax features and language-server requests work in it.
#[tauri::command]
#[specta::specta]
pub async fn doc_open_virtual(window: Window, state: State<'_, AppState>, uri: String) -> IdeResult<DocumentInfo> {
    let project = state.project(window.label())?;
    let vd = project.lsp.virtual_document(&uri).await?;
    blocking(move || project.documents.open_virtual(&vd.uri, vd.language_id, &vd.text)).await
}

#[tauri::command]
#[specta::specta]
pub fn doc_close(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<()> {
    state.project(window.label())?.documents.close(doc);
    Ok(())
}

/// Applies a CodeMirror change set; returns the new version. Rejects with
/// `outOfSync` when `base_version` is stale; the UI then calls `doc_snapshot`.
#[tauri::command]
#[specta::specta]
pub fn doc_edit(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    base_version: u32,
    changes: ChangeSet,
) -> IdeResult<u32> {
    state.project(window.label())?.documents.edit(doc, base_version, changes)
}

#[tauri::command]
#[specta::specta]
pub async fn doc_save(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.documents.save(doc)).await
}

#[tauri::command]
#[specta::specta]
pub async fn doc_save_all(window: Window, state: State<'_, AppState>) -> IdeResult<()> {
    let project = state.project(window.label())?;
    blocking(move || project.documents.save_all()).await
}

#[tauri::command]
#[specta::specta]
pub async fn doc_snapshot(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<DocumentInfo> {
    let project = state.project(window.label())?;
    blocking(move || project.documents.snapshot(doc)).await
}

/// "Reload with Encoding" (`reload`) or "Convert to Encoding"; returns the new encoding label.
#[tauri::command]
#[specta::specta]
pub fn doc_set_encoding(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    encoding: String,
    reload: bool,
) -> IdeResult<String> {
    state.project(window.label())?.documents.set_encoding(doc, &encoding, reload)
}

#[tauri::command]
#[specta::specta]
pub fn doc_set_line_ending(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    line_ending: LineEnding,
) -> IdeResult<()> {
    state.project(window.label())?.documents.set_line_ending(doc, line_ending)
}

/// Structure view: LSP document symbols when available, tree-sitter otherwise.
/// Tree-sitter answers come from the per-document tree cache (incremental
/// re-parse); large documents get no syntax structure.
#[tauri::command]
#[specta::specta]
pub async fn doc_outline(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<OutlineItem>> {
    let project = state.project(window.label())?;
    if let Ok(Some(items)) = project.lsp.document_symbols(doc).await {
        return Ok(items);
    }
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        Ok(project.syntax.outline(doc, &snap.language, snap.version, &snap.text))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn doc_folding(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<FoldRange>> {
    let project = state.project(window.label())?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        Ok(project.syntax.folding(doc, &snap.language, snap.version, &snap.text))
    })
    .await
}

/// Tree-sitter highlighting for languages the UI has no CodeMirror mode for;
/// empty when the grammar has no highlights query or the document is large.
#[tauri::command]
#[specta::specta]
pub async fn doc_highlights(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<SyntaxHighlights> {
    let project = state.project(window.label())?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(SyntaxHighlights::default());
        }
        Ok(project.syntax.highlights(doc, &snap.language, snap.version, &snap.text))
    })
    .await
}

/// Extend Selection (⌥↑): syntax ranges around `offset`, innermost first.
/// Large documents fall back to word / line / document ranges.
#[tauri::command]
#[specta::specta]
pub async fn doc_selection_ranges(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    offset: u32,
) -> IdeResult<Vec<Range>> {
    let project = state.project(window.label())?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        let language = if snap.large { ide_core::LanguageId::plain_text() } else { snap.language };
        Ok(project.syntax.selection_ranges(doc, &language, snap.version, &snap.text, offset))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn history_list(window: Window, state: State<'_, AppState>, path: PathBuf) -> IdeResult<Vec<HistoryEntry>> {
    state.project(window.label())?.history.list(&path)
}

#[tauri::command]
#[specta::specta]
pub fn history_content(window: Window, state: State<'_, AppState>, id: String) -> IdeResult<String> {
    state.project(window.label())?.history.content(&id)
}
