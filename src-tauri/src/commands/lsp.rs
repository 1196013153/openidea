use crate::state::{AppState, apply_workspace_edit as apply_edit};
use ide_core::{DocId, IdeResult, Location, Pos, Range, RequestId, ServerId, TextEdit, WorkspaceEdit};
use ide_lsp::types::*;
use tauri::{State, Window};

macro_rules! project {
    ($window:expr, $state:expr) => {
        $state.project($window.label())?
    };
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_completion(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    pos: Pos,
    trigger: Option<String>,
) -> IdeResult<CompletionList> {
    let lsp = project!(window, state).lsp.clone();
    let cancel = state.begin_request(request);
    let result = lsp.completion(doc, pos, trigger, cancel).await;
    state.end_request(request);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_resolve_completion(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    item: CompletionItem,
) -> IdeResult<CompletionItem> {
    project!(window, state).lsp.resolve_completion(doc, item).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_hover(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<Hover>> {
    let lsp = project!(window, state).lsp.clone();
    let cancel = state.begin_request(request);
    let result = lsp.hover(doc, pos, cancel).await;
    state.end_request(request);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_signature_help(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<SignatureHelp>> {
    project!(window, state).lsp.signature_help(doc, pos).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_goto(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    kind: GotoKind,
) -> IdeResult<Vec<Location>> {
    project!(window, state).lsp.goto(doc, pos, kind).await
}

/// Contents of a virtual document (library class, decompiled code) that a
/// language server returned a non-`file:` URI for. Cached per project.
#[tauri::command]
#[specta::specta]
pub async fn lsp_virtual_document(
    window: Window,
    state: State<'_, AppState>,
    uri: String,
) -> IdeResult<VirtualDocument> {
    project!(window, state).lsp.virtual_document(&uri).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_references(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    include_declaration: bool,
) -> IdeResult<Vec<Location>> {
    project!(window, state).lsp.references(doc, pos, include_declaration).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_document_highlights(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Vec<Highlight>> {
    project!(window, state).lsp.document_highlights(doc, pos).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_workspace_symbols(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    query: String,
) -> IdeResult<Vec<WorkspaceSymbol>> {
    let lsp = project!(window, state).lsp.clone();
    let cancel = state.begin_request(request);
    let result = lsp.workspace_symbols(&query, cancel).await;
    state.end_request(request);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_code_actions(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<Vec<CodeAction>> {
    project!(window, state).lsp.code_actions(doc, range, only).await
}

/// Cancellable code actions with the kinds the servers advertise (Refactor This, refactoring availability).
#[tauri::command]
#[specta::specta]
pub async fn lsp_code_action_query(
    window: Window,
    state: State<'_, AppState>,
    request: RequestId,
    doc: DocId,
    range: Range,
    only: Vec<String>,
) -> IdeResult<CodeActionQuery> {
    let lsp = project!(window, state).lsp.clone();
    let cancel = state.begin_request(request);
    let result = lsp.code_action_query(doc, range, only, cancel).await;
    state.end_request(request);
    result
}

/// Resolves (if needed), applies the edit, then runs the command of a code action.
#[tauri::command]
#[specta::specta]
pub async fn lsp_apply_code_action(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    action: CodeAction,
) -> IdeResult<()> {
    let project = project!(window, state);
    let action = if action.edit.is_none() && action.command.is_none() {
        project.lsp.resolve_code_action(doc, action).await?
    } else {
        action
    };
    if let Some(edit) = &action.edit {
        apply_edit(&project.documents, edit)?;
    }
    if let Some(command) = action.command {
        project.lsp.execute_command(doc, command).await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_prepare_rename(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<Range>> {
    project!(window, state).lsp.prepare_rename(doc, pos).await
}

/// Computes the rename edit without applying it, so the UI can preview conflicts.
#[tauri::command]
#[specta::specta]
pub async fn lsp_rename(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    new_name: String,
) -> IdeResult<WorkspaceEdit> {
    project!(window, state).lsp.rename(doc, pos, new_name).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_format(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    project!(window, state).lsp.format(doc, range, options).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_inlay_hints(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    range: Range,
) -> IdeResult<Vec<InlayHint>> {
    project!(window, state).lsp.inlay_hints(doc, range).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_semantic_tokens(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
) -> IdeResult<Option<SemanticTokens>> {
    project!(window, state).lsp.semantic_tokens(doc).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_code_lens(window: Window, state: State<'_, AppState>, doc: DocId) -> IdeResult<Vec<CodeLens>> {
    project!(window, state).lsp.code_lens(doc).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_call_hierarchy(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    project!(window, state).lsp.call_hierarchy(doc, pos, direction).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_type_hierarchy(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    pos: Pos,
    direction: HierarchyDirection,
) -> IdeResult<Vec<HierarchyItem>> {
    project!(window, state).lsp.type_hierarchy(doc, pos, direction).await
}

#[tauri::command]
#[specta::specta]
pub fn lsp_servers(window: Window, state: State<'_, AppState>) -> IdeResult<Vec<ServerInfo>> {
    Ok(project!(window, state).lsp.servers())
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_restart(window: Window, state: State<'_, AppState>, server: ServerId) -> IdeResult<()> {
    project!(window, state).lsp.restart(server).await
}

/// Applies a (previewed) workspace edit, e.g. after rename confirmation.
#[tauri::command]
#[specta::specta]
pub fn apply_workspace_edit(window: Window, state: State<'_, AppState>, edit: WorkspaceEdit) -> IdeResult<()> {
    let project = project!(window, state);
    // Multi-file refactorings leave a Local History point to go back to.
    let paths: Vec<&std::path::Path> = edit
        .files
        .iter()
        .filter_map(|f| match f {
            ide_core::FileEdit::Edit { path, .. } => Some(&**path),
            _ => None,
        })
        .collect();
    if edit.files.len() > 1 {
        project.record_before_refactoring(&paths, "Apply changes");
    }
    apply_edit(&project.documents, &edit)
}

/// Runs a server command (`workspace/executeCommand`), e.g. a completion item's
/// follow-up command. Edits the server requests arrive via `workspace/applyEdit`.
#[tauri::command]
#[specta::specta]
pub async fn lsp_execute_command(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    command: Command,
) -> IdeResult<()> {
    project!(window, state).lsp.execute_command(doc, command).await
}
