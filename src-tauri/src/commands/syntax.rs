//! Tree-sitter structure queries (`ide-syntax`): the fallback editor features
//! use when the language server is unavailable, not ready or failing.
//!
//! All positions are 0-based lines / UTF-16 columns. Document queries run on
//! the blocking pool against the document's cached, incrementally re-parsed
//! tree; an optional `request` id makes them cancellable via `cancel_request`.
//! Languages without a grammar (and documents too large to parse) reject with
//! `unavailable`.

use super::doc::blocking;
use crate::state::{AppState, Project};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, LanguageId, Pos, Range, RequestId};
use ide_syntax::{
    ExpressionAt, FileIdentifiers, IdentifierOccurrence, Locals, NodeAt, Snapshot, StructuralRanges, StructureResult,
    StructureService, StructureSupport, SyntaxErrors,
};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{State, Window};

/// Runs `f` on the current snapshot of `doc` off the command thread.
async fn on_doc<T: Send + 'static>(
    state: &AppState,
    window: &Window,
    doc: DocId,
    request: Option<RequestId>,
    f: impl FnOnce(&StructureService, &Snapshot, &CancellationToken) -> StructureResult<T> + Send + 'static,
) -> IdeResult<T> {
    let project: Arc<Project> = state.project(window.label())?;
    let cancel = request.map_or_else(CancellationToken::new, |id| state.begin_request(id));
    let result = blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Err(IdeError::unavailable("file is too large for syntax analysis"));
        }
        let s = Snapshot::doc(doc, snap.version, &snap.language, &snap.text);
        Ok(f(&project.structure, &s, &cancel)?)
    })
    .await;
    if let Some(id) = request {
        state.end_request(id);
    }
    result
}

/// What the structure service supports for a language (`tree`: every query,
/// `locals`: scope analysis).
#[tauri::command]
#[specta::specta]
pub fn syntax_support(window: Window, state: State<'_, AppState>, language: LanguageId) -> IdeResult<StructureSupport> {
    Ok(state.project(window.label())?.structure.support(&language))
}

/// The smallest named node covering `range`, with its ancestors (parent first).
#[tauri::command]
#[specta::specta]
pub async fn syntax_node_at(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
    request: Option<RequestId>,
) -> IdeResult<Option<NodeAt>> {
    on_doc(&state, &window, doc, request, move |s, snap, c| s.node_at(snap, range, c)).await
}

/// The expression a selection denotes (exact or minimally enclosing), with its
/// statement, block and caret candidates.
#[tauri::command]
#[specta::specta]
pub async fn syntax_expression_at(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
    request: Option<RequestId>,
) -> IdeResult<ExpressionAt> {
    on_doc(&state, &window, doc, request, move |s, snap, c| s.expression_at(snap, range, c)).await
}

/// `ERROR` / `MISSING` nodes (e.g. a missing `;`) in document order.
#[tauri::command]
#[specta::specta]
pub async fn syntax_errors(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    request: Option<RequestId>,
) -> IdeResult<SyntaxErrors> {
    on_doc(&state, &window, doc, request, |s, snap, c| s.syntax_errors(snap, c)).await
}

/// Scope analysis of the identifier at `pos`: its local definition and
/// references, or why it is not a local.
#[tauri::command]
#[specta::specta]
pub async fn syntax_locals(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    request: Option<RequestId>,
) -> IdeResult<Locals> {
    on_doc(&state, &window, doc, request, move |s, snap, c| s.locals(snap, pos, c)).await
}

/// Identifier tokens spelled `name` in a document, excluding comments and strings.
#[tauri::command]
#[specta::specta]
pub async fn syntax_identifiers(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    name: String,
    request: Option<RequestId>,
) -> IdeResult<Vec<IdentifierOccurrence>> {
    on_doc(&state, &window, doc, request, move |s, snap, c| s.identifiers_named(snap, &name, c)).await
}

/// [`syntax_identifiers`] over files (open buffers win over disk); files
/// without occurrences or without a grammar are left out. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn syntax_identifiers_in_files(
    window: Window,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    name: String,
    request: RequestId,
) -> IdeResult<Vec<FileIdentifiers>> {
    let project = state.project(window.label())?;
    let languages = state.languages.clone();
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        let load = |path: &std::path::Path| {
            if let Some(doc) = project.documents.by_path(path) {
                let snap = project.documents.text_snapshot(doc).ok()?;
                return (!snap.large).then_some((snap.language, Some((doc, snap.version)), snap.text));
            }
            let text = ide_vfs::load_text(path).ok()?.text;
            let first_line = text.lines().next();
            Some((languages.detect(path, first_line), None, text))
        };
        Ok(project.structure.identifiers_in_files(&paths, &name, load, &cancel)?)
    })
    .await;
    state.end_request(request);
    result
}

/// Extend Selection chain plus statement / declaration ranges at `pos`
/// (Move Statement, Complete Statement for languages without a Lezer grammar).
#[tauri::command]
#[specta::specta]
pub async fn syntax_structural_ranges(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    request: Option<RequestId>,
) -> IdeResult<StructuralRanges> {
    on_doc(&state, &window, doc, request, move |s, snap, c| s.structural_ranges(snap, pos, c)).await
}
