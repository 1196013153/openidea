/**
 * Code completion backed by `lsp_completion`, rendered in IDEA's style: mono
 * rows with a kind letter, the label with the matched prefix emphasised, the
 * label detail, the type right-aligned and a footer hint bar. ↵ inserts, ⇥
 * replaces the rest of the identifier, documentation resolves lazily into the
 * side panel. Without a language server the editor's language-data sources
 * (keywords, local words) are used instead.
 */
import {
  acceptCompletion,
  autocompletion,
  completeFromList,
  completionStatus,
  pickedCompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionInfo,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorSelection, Prec, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { commands, isTauri, nextRequestId, type CompletionItem, type RequestId } from "@/platform/ipc";
import { completionSymbolKind, identifierEnd, toCmCompletion, triggerCharacter } from "./completionItems";
import { lspSnippetToCm, snippetVariables } from "./snippet";
import { docOf, isUnavailable, lspDoc, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, posToOffset, textEditsToChanges } from "./positions";
import { isEmptyMarkup, renderCode, renderMarkup } from "./markdown";
import { iconNode } from "./iconMarkup";
import { triggerSignatureHelp } from "./signature";
import { serverBackoff } from "./availability";
import { pathCompletionSource } from "./fileReferences";
import { editorPrefs } from "@/platform/editorSettings";

interface RequestContext {
  doc: number;
  path: string;
  language: string | null;
  /** Caret offset and document at request time; item ranges refer to these. */
  pos: number;
  text: Text;
}

interface LspCompletion extends Completion {
  lsp: CompletionItem;
  req: RequestContext;
  resolved?: CompletionItem;
}

const isLsp = (c: Completion): c is LspCompletion => "lsp" in c;

// ---------------------------------------------------------------------------
// Resolve (documentation, lazily computed edits)

const resolving = new WeakMap<CompletionItem, Promise<CompletionItem>>();

function resolveItem(doc: number, item: CompletionItem): Promise<CompletionItem> {
  if (item.data == null && !isEmptyMarkup(item.documentation)) return Promise.resolve(item);
  let p = resolving.get(item);
  if (!p) {
    p = lspRequest(() => commands.lspResolveCompletion(doc, item)).catch(() => item);
    resolving.set(item, p);
  }
  return p;
}

function renderInfo(c: LspCompletion): Promise<CompletionInfo> {
  const prefs = editorPrefs().completion;
  if (!prefs.showDocumentation) return Promise.resolve(null);
  const delay = Math.max(0, prefs.documentationDelay);
  const wait = delay ? new Promise<void>((r) => setTimeout(r, delay)) : Promise.resolve();
  return Promise.all([resolveItem(c.req.doc, c.lsp), wait]).then(([item]) => {
    c.resolved = item;
    const hasDoc = !isEmptyMarkup(item.documentation);
    if (!hasDoc && !item.detail) return null;
    const dom = document.createElement("div");
    dom.className = "cm-lsp-completion-doc";
    if (item.detail) dom.appendChild(renderCode(item.detail, c.req.language, "cm-lsp-code cm-lsp-doc-signature"));
    if (hasDoc) dom.appendChild(renderMarkup(item.documentation!, c.req.language));
    return dom;
  });
}

// ---------------------------------------------------------------------------
// Apply

/** Set by the ⇥ binding for the duration of `acceptCompletion`. */
let replaceMode = false;

function applyLsp(view: EditorView, completion: Completion, from: number, to: number) {
  applyLspCompletion(view, completion, from, to, replaceMode ? "replace" : "insert");
}

/** ↵ (`insert`) or ⇥ (`replace`: also overwrites the rest of the identifier). */
export function applyLspCompletion(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  mode: "insert" | "replace",
) {
  if (!isLsp(completion)) return;
  const { req } = completion;
  const item = completion.resolved ?? completion.lsp;
  const state = view.state;
  const delta = to - req.pos;
  const mapOld = (offset: number) => Math.max(0, Math.min(state.doc.length, offset < req.pos ? offset : offset + delta));

  let start = from;
  let end = to;
  if (item.replaceRange) {
    start = Math.min(mapOld(posToOffset(req.text, item.replaceRange.start)), to);
    end = Math.max(mapOld(posToOffset(req.text, item.replaceRange.end)), to);
  }
  if (mode === "replace") {
    if (item.replaceRangeTab) end = Math.max(end, mapOld(posToOffset(req.text, item.replaceRangeTab.end)));
    else {
      const line = state.doc.lineAt(end);
      end = line.from + identifierEnd(line.text, end - line.from);
    }
  }

  const extra = textEditsToChanges(req.text, item.additionalEdits)
    .map((c) => ({ from: mapOld(c.from), to: mapOld(c.to), insert: c.insert }))
    .filter((c) => c.to <= start || c.from >= end);

  if (item.isSnippet) {
    if (extra.length) {
      const tr = state.update({ changes: extra, userEvent: "input.complete" });
      view.dispatch(tr);
      start = tr.changes.mapPos(start, 1);
      end = tr.changes.mapPos(end, 1);
    }
    snippet(lspSnippetToCm(item.insertText, snippetVariables(req.path)))(view, completion, start, end);
  } else {
    const changes = state.changes([...extra, { from: start, to: end, insert: item.insertText }]);
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(changes.mapPos(end, 1)),
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
    });
  }

  if (!completion.resolved && !item.additionalEdits.length && item.data != null) void applyLateEdits(view, completion, start);
  runCommand(view, item);
}

/**
 * Some servers (tsserver auto-imports) only compute additional edits on
 * resolve. Apply those that lie before the insertion once they arrive, if the
 * text before it is unchanged.
 */
async function applyLateEdits(view: EditorView, c: LspCompletion, insertedAt: number) {
  const item = await resolveItem(c.req.doc, c.lsp);
  if (!item.additionalEdits.length || !view.dom.isConnected) return;
  const edits = textEditsToChanges(c.req.text, item.additionalEdits).filter((e) => e.to <= Math.min(insertedAt, c.req.pos));
  if (!edits.length) return;
  const limit = Math.max(...edits.map((e) => e.to));
  if (view.state.doc.sliceString(0, limit) !== c.req.text.sliceString(0, limit)) return;
  view.dispatch({ changes: edits, userEvent: "input.complete" });
}

/** Client-side commands handled by the editor itself (VS Code ids servers commonly send). */
const CLIENT_COMMANDS = new Set(["editor.action.triggerParameterHints", "editor.action.triggerSuggest"]);

function runCommand(view: EditorView, item: CompletionItem) {
  const command = item.command;
  if (!command?.command) return;
  const cmd = command.command;
  if (cmd === "editor.action.triggerParameterHints") setTimeout(() => triggerSignatureHelp(view), 0);
  else if (cmd === "editor.action.triggerSuggest") setTimeout(() => startCompletion(view), 0);
  else if (!CLIENT_COMMANDS.has(cmd) && !cmd.startsWith("editor.")) {
    const doc = docOf(view);
    // Server commands (auto-import, postfix…); resulting edits come back as workspace/applyEdit.
    if (doc) void lspRequest(() => commands.lspExecuteCommand(doc.doc, command)).catch((e: unknown) => reportLspError(view, e, false));
  }
}

// ---------------------------------------------------------------------------
// Source

const WORD_BEFORE = /[\p{L}\p{N}_$]+$/u;
const VALID_FOR = /^[\p{L}\p{N}_$]*$/u;

let inflight: RequestId | null = null;

function cancelInflight() {
  if (inflight !== null && isTauri()) void commands.cancelRequest(inflight);
  inflight = null;
}

/** Language-data completion sources (keywords etc.), used when no server answers. */
async function fallback(ctx: CompletionContext): Promise<CompletionResult | null> {
  const sources = ctx.state.languageDataAt<CompletionSource | readonly (string | Completion)[]>("autocomplete", ctx.pos);
  for (const s of sources) {
    const source = typeof s === "function" ? s : completeFromList(s);
    const r = await source(ctx);
    if (r) return r;
  }
  return null;
}

export function makeCompletion(item: CompletionItem, req: RequestContext): LspCompletion {
  return Object.assign(toCmCompletion(item), {
    lsp: item,
    req,
    apply: applyLsp,
    info: (c: Completion) => renderInfo(c as LspCompletion),
  });
}

/**
 * Sources other features contribute via the `openideaCompletion` language-data
 * key (live templates, postfix, SQL). Results starting where the first one
 * does are merged into one list. Options may carry `icon` (an icon name, `null`
 * for none) and `typeText` (the right-aligned type column), like LSP items.
 */
const contributedSource: CompletionSource = async (ctx) => {
  const results: CompletionResult[] = [];
  for (const source of ctx.state.languageDataAt<CompletionSource>("openideaCompletion", ctx.pos)) {
    const result = await source(ctx);
    if (result) results.push(result);
  }
  return mergeResults(results);
};

export function mergeResults(results: readonly CompletionResult[]): CompletionResult | null {
  const [first] = results;
  if (!first || results.length === 1) return first ?? null;
  const same = results.filter((r) => r.from === first.from);
  const validFor = same.every((r) => r.validFor instanceof RegExp && r.validFor.source === (first.validFor as RegExp | undefined)?.source)
    ? first.validFor
    : undefined;
  return { from: first.from, to: first.to, options: same.flatMap((r) => r.options), validFor };
}

/** Rendering extras of contributed (non-LSP) options. */
interface RichCompletion extends Completion {
  icon?: string | null;
  typeText?: string;
}

async function lspCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  const doc = ctx.state.facet(lspDoc);
  if (!doc || doc.readOnly) return null;
  const word = ctx.matchBefore(WORD_BEFORE);
  const trigger = triggerCharacter(ctx.state.sliceDoc(Math.max(0, ctx.pos - 2), ctx.pos));
  if (!ctx.explicit && !word && !trigger) return null;
  if (!ctx.explicit && word && !trigger && /^\d/.test(word.text)) return null;
  if (serverBackoff.active(doc.doc)) return fallback(ctx);

  cancelInflight();
  const id = nextRequestId();
  inflight = id;
  ctx.addEventListener("abort", () => {
    if (inflight === id) cancelInflight();
  });
  let list;
  try {
    list = await lspRequest(() => commands.lspCompletion(id, doc.doc, offsetToPos(ctx.state.doc, ctx.pos), trigger));
  } catch (e) {
    if (isUnavailable(e)) {
      serverBackoff.mark(doc.doc);
      return fallback(ctx);
    }
    return null;
  } finally {
    if (inflight === id) inflight = null;
  }
  if (ctx.aborted || !list.items.length) return list.items.length ? null : fallback(ctx);
  const req: RequestContext = { doc: doc.doc, path: doc.path, language: doc.uiMode, pos: ctx.pos, text: ctx.state.doc };
  const prefs = editorPrefs().completion;
  const typed = word?.text ?? "";
  const items = prefs.matchCase ? list.items.filter((it) => matchesCase(it.filterText ?? it.label, typed, prefs.caseSensitivity)) : list.items;
  return {
    from: word ? word.from : ctx.pos,
    options: items.map((item) => makeCompletion(item, req)),
    // "All letters" must re-check case on every keystroke.
    validFor: list.isIncomplete || (prefs.matchCase && prefs.caseSensitivity === "all") ? undefined : VALID_FOR,
    filter: true,
    ...(prefs.insertOnSpecialKeys ? { commitCharacters: [" ", ".", "(", ",", ";"] } : {}),
  };
}

/** Code Completion › Match case: first letter only, or every typed letter (as a subsequence). */
export function matchesCase(label: string, typed: string, mode: string): boolean {
  if (!typed) return true;
  if (mode !== "all") {
    const first = typed[0]!;
    const head = label[0] ?? "";
    return head.toLowerCase() !== first.toLowerCase() || head === first;
  }
  let i = 0;
  for (const ch of label) if (ch === typed[i]) i++;
  return i >= typed.length;
}

/** Show suggestions as you type: sources only answer explicit requests when it is off. */
function gated(source: CompletionSource): CompletionSource {
  return (ctx) => (!ctx.explicit && !editorPrefs().completion.autoPopup ? null : source(ctx));
}

// ---------------------------------------------------------------------------
// Rendering

function kindBadge(c: Completion): Node | null {
  if (!isLsp(c) && "icon" in c) {
    const icon = (c as RichCompletion).icon;
    if (icon) return iconNode(icon, 16, "cm-lsp-kind");
    const blank = document.createElement("span");
    blank.className = "cm-lsp-kind";
    return blank;
  }
  const kind = isLsp(c) ? completionSymbolKind(c.lsp.kind) : (c.type ?? "text");
  const span = iconNode(`symbol-${kind}`, 16, "cm-lsp-kind");
  span.dataset.kind = kind;
  return span;
}

function typeColumn(c: Completion): Node | null {
  const detail = isLsp(c) ? c.lsp.detail : (c as RichCompletion).typeText;
  if (!detail) return null;
  const span = document.createElement("span");
  span.className = "cm-lsp-type";
  span.textContent = detail.replace(/\s+/g, " ");
  return span;
}

/** IDEA's advertiser bar under the list (one tip: "Press ↵ to insert, ⇥ to replace"). */
const completionFooter = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      if (completionStatus(u.state) !== "active") return;
      this.view.requestMeasure({
        read: () => null,
        write: () => {
          const scope = this.view.dom.ownerDocument;
          const tooltips = [
            ...this.view.dom.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete"),
            ...scope.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete"),
          ];
          for (const t of tooltips) {
            if (t.querySelector(":scope > .cm-lsp-completion-footer")) continue;
            const footer = document.createElement("div");
            footer.className = "cm-lsp-completion-footer";
            footer.textContent = "Press ↵ to insert, ⇥ to replace";
            t.appendChild(footer);
          }
        },
      });
    }
  },
);

export function completionExtension() {
  return [
    autocompletion({
      override: [gated(lspCompletionSource), gated(contributedSource), gated(pathCompletionSource)],
      icons: false,
      addToOptions: [
        { render: kindBadge, position: 20 },
        { render: typeColumn, position: 90 },
      ],
      optionClass: (c) => {
        // IDEA shows keywords in bold.
        const keyword = (isLsp(c) ? c.lsp.kind : c.type) === "keyword" ? " cm-lsp-keyword-option" : "";
        return (isLsp(c) ? (c.lsp.deprecated ? "cm-lsp-option cm-lsp-deprecated-option" : "cm-lsp-option") : "") + keyword;
      },
      tooltipClass: () => "cm-lsp-completion",
    }),
    completionFooter,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            if (completionStatus(view.state) !== "active") return false;
            replaceMode = true;
            try {
              return acceptCompletion(view);
            } finally {
              replaceMode = false;
            }
          },
        },
      ]),
    ),
  ];
}

export { startCompletion };
