/**
 * Go to declaration / implementation / type declaration (⌘B, ⌥⌘B, ⇧⌘B and
 * ⌘-click with a link underline while ⌘ is held), the multiple-targets
 * chooser, and document highlights (occurrences of the symbol at the caret,
 * plus the sticky find.highlightUsages variant).
 */
import { EditorSelection, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  commands,
  isCancelled,
  type GotoKind,
  type Highlight,
  type Location,
  type Pos,
  type WebReferenceKind,
} from "@/platform/ipc";
import {
  CONTRIBUTED_DEFINITION,
  activeEditor,
  contributedAt,
  whenSynced,
  type ContributedDefinition,
  type EditorDocContext,
} from "@/editor/api";
import { structure } from "@/editor/structure";
import { executeAction } from "@/platform/actions";
import { basename, relativePath, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { fileIconName } from "@/ui";
import { NO_SERVER, debounce, docOf, isUnavailable, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, rangeToOffsets } from "./positions";
import { SYNTAX_NOTE, declarationFallback, isSelfTarget, localHighlights, type DeclarationTarget } from "./syntaxFallback";
import { showHint } from "./hint";
import { caretAnchor, openPopup, type ListPopupItem } from "./popupStore";
import { readManyFileLines } from "./files";
import { documentLinks, followReference, knownLinks, linkReference, referenceAt, textReference } from "./links";
import { serverBackoff } from "./availability";
import { editorPrefs } from "@/platform/editorSettings";
import { isVirtualUri, virtualContainer } from "@/platform/virtualDocs";
import { hasPrimaryModifier, isMacHost } from "@/platform/keymap";

export async function navigateTo(loc: Location) {
  await editorService().openFile(loc.path, {
    selection: { line: loc.range.start.line, col: loc.range.start.col },
    focus: true,
  });
}

const NOT_FOUND: Record<GotoKind, string> = {
  definition: "Cannot find declaration to go to",
  declaration: "Cannot find declaration to go to",
  implementation: "No implementations found",
  typeDefinition: "Cannot find type declaration",
};

const TITLES: Record<GotoKind, string> = {
  definition: "Choose Declaration",
  declaration: "Choose Declaration",
  implementation: "Choose Implementation",
  typeDefinition: "Choose Type Declaration",
};

export function dedupeLocations<T extends Location>(locs: readonly T[]): T[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${l.path}:${l.range.start.line}:${l.range.start.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Popup items for locations, with a one-line source preview each. */
export async function locationItems(locs: readonly DeclarationTarget[]): Promise<ListPopupItem[]> {
  const files = await readManyFileLines(locs.map((l) => l.path));
  const root = useProject.getState().project?.root ?? "";
  return locs.map((l, i) => {
    const where = `${isVirtualUri(l.path) ? virtualContainer(l.path) : relativePath(root, l.path)}:${l.range.start.line + 1}`;
    const preview = files.get(l.path)?.[l.range.start.line]?.trim();
    // Index symbols (syntax fallback): "name  container · file:line", like IDEA's chooser.
    if (l.kind && l.name)
      return {
        id: `${i}`,
        label: l.name,
        detail: l.container ? `${l.container} · ${where}` : where,
        preview,
        symbol: l.kind,
        run: () => navigateTo(l),
      };
    return {
      id: `${i}`,
      label: basename(l.path),
      detail: where,
      preview,
      icon: fileIconName(basename(l.path)),
      run: () => navigateTo(l),
    };
  });
}

export async function gotoTargets(view: EditorView, kind: GotoKind, at?: number) {
  const offset = at ?? view.state.selection.main.head;
  if (kind === "definition" || kind === "declaration") {
    const own = contributedAt<ContributedDefinition>(view.state, CONTRIBUTED_DEFINITION, offset);
    if (own?.(view, offset)) return;
  }
  const doc = docOf(view);
  if (!doc) return;
  const pos = offsetToPos(view.state.doc, offset);
  let locs: DeclarationTarget[];
  let fromSyntax = false;
  const declaration = kind === "definition" || kind === "declaration";
  let serverDown = false;
  try {
    locs = dedupeLocations(await lspRequest(() => commands.lspGoto(doc.doc, pos, kind)));
  } catch (e) {
    if (isCancelled(e) || !declaration) {
      reportLspError(view, e, true);
      return;
    }
    // Web references and links need no server.
    if ((await gotoWebReference(view, doc, pos, offset)) || (await followReferenceAt(view, doc, offset))) return;
    serverDown = isUnavailable(e);
    // Dumb mode: the server is not ready / failing — answer from the syntax tree.
    const fb = await gotoFallback(view, doc, pos);
    if (!fb) {
      reportLspError(view, e, true);
      return;
    }
    locs = fb;
    fromSyntax = true;
  }
  if (!locs.length) {
    // The server has no definition here: a link (`href`, `#include`, Markdown) or a file path.
    if (
      declaration &&
      !fromSyntax &&
      ((await gotoWebReference(view, doc, pos, offset)) || (await followReferenceAt(view, doc, offset)))
    )
      return;
    showHint(view, serverDown ? `${NOT_FOUND[kind]}: no language server is running for this file` : NOT_FOUND[kind]);
    return;
  }
  // IDEA: ⌘B on a declaration shows its usages.
  if (kind === "definition" && isSelfTarget(locs, doc.path, pos)) {
    if (!(await executeAction("find.showUsages"))) showHint(view, "No usages found");
    return;
  }
  if (locs.length === 1) {
    await navigateTo(locs[0]!);
    // After the editor applied the navigation's selection (which dismisses hints).
    if (fromSyntax)
      setTimeout(() => {
        const target = activeEditor()?.view;
        if (target) showHint(target, SYNTAX_NOTE, { timeout: 2500 });
      }, 150);
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, offset),
    title: `${TITLES[kind]} (${locs.length} found${fromSyntax ? ", based on syntax" : ""})`,
    items: await locationItems(locs),
  });
}

const WEB_LANGUAGES = new Set(["html", "css", "scss", "less", "vue", "svelte"]);

const WEB_SIGIL: Record<WebReferenceKind, string> = { class: ".", id: "#", anchor: "#", cssVariable: "" };

/**
 * `class` / `id` attributes to their CSS selectors, `href="#x"` to the element,
 * `var(--x)` to its declarations (no language server resolves these); false
 * when there is no such reference at `pos`.
 */
async function gotoWebReference(view: EditorView, doc: EditorDocContext, pos: Pos, offset: number): Promise<boolean> {
  if (!WEB_LANGUAGES.has(doc.language) || doc.virtual) return false;
  let found;
  try {
    await whenSynced(view);
    found = await lspRequest(() => commands.webGoto(doc.doc, pos));
  } catch (e) {
    console.debug("[web] goto", e);
    return false;
  }
  if (!found) return false;
  const { reference, targets } = found;
  const label = `${WEB_SIGIL[reference.kind]}${reference.name}`;
  if (!targets.length) showHint(view, `Cannot find declaration of '${label}'`);
  else if (targets.length === 1) await navigateTo(targets[0]!);
  else
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, offset),
      title: `Choose Declaration of '${label}' (${targets.length} found)`,
      items: await locationItems(targets),
    });
  return true;
}

/** Follows the link, URL or file path at `offset`; false when there is none. */
async function followReferenceAt(view: EditorView, doc: EditorDocContext, offset: number): Promise<boolean> {
  const ref = await referenceAt(view, doc, offset);
  if (!ref) return false;
  try {
    await followReference(ref);
  } catch (e) {
    showHint(view, e instanceof Error ? e.message : String(e), { tone: "error" });
  }
  return true;
}

/** Declaration targets from the structure service; null when it cannot answer for this file. */
async function gotoFallback(view: EditorView, doc: EditorDocContext, pos: Pos): Promise<DeclarationTarget[] | null> {
  try {
    await whenSynced(view);
    const text = view.state.doc;
    const fb = await declarationFallback(doc, text, pos);
    return fb.kind === "unsupported" ? null : fb.targets;
  } catch (e) {
    console.debug("[syntax] declaration fallback", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// ⌘-hover link + ⌘-click

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects)
      if (e.is(setLink)) return e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** What ⌘-hover underlines: a whole link, URL or path, else the word. */
function linkAt(view: EditorView, x: number, y: number) {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos == null) return null;
  const links = knownLinks(view);
  const ref = (links && linkReference(view.state.doc, links, pos)) ?? textReference(view.state.doc, pos);
  if (ref) return ref;
  const word = view.state.wordAt(pos);
  return word && word.from < word.to ? word : null;
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    last: { x: number; y: number } | null = null;
    constructor(readonly view: EditorView) {}
    show(meta: boolean) {
      const doc = meta ? docOf(this.view) : null;
      // Underline whole links once the server's links are in.
      if (doc && !doc.virtual && !knownLinks(this.view))
        void documentLinks(this.view, doc).then(() => {
          if (this.view.state.field(linkField).size) this.show(true);
        });
      const current = this.view.state.field(linkField);
      const target = meta && this.last ? linkAt(this.view, this.last.x, this.last.y) : null;
      let same = false;
      current.between(0, this.view.state.doc.length, (from, to) => {
        same = !!target && target.from === from && target.to === to;
      });
      if (same || (!target && current.size === 0)) return;
      this.view.dispatch({ effects: setLink.of(target) });
    }
  },
  {
    eventHandlers: {
      mousemove(e) {
        this.last = { x: e.clientX, y: e.clientY };
        this.show(hasPrimaryModifier(e) && !e.altKey && !e.shiftKey);
      },
      mouseleave() {
        this.last = null;
        this.show(false);
      },
      keydown(e) {
        if (e.key === (isMacHost() ? "Meta" : "Control")) this.show(true);
      },
      keyup(e) {
        if (e.key === (isMacHost() ? "Meta" : "Control")) this.show(false);
      },
      blur() {
        this.show(false);
      },
      mousedown(e, view) {
        if (e.button !== 0 || !hasPrimaryModifier(e) || e.altKey || e.shiftKey) return false;
        if (isMacHost() ? e.ctrlKey : e.metaKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        if (pos == null) return false;
        e.preventDefault();
        view.dispatch({ selection: EditorSelection.cursor(pos), effects: setLink.of(null) });
        view.focus();
        void gotoTargets(view, "definition", pos);
        return true;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// Document highlights

interface HighlightState {
  deco: DecorationSet;
  sticky: boolean;
}

const setHighlights = StateEffect.define<{ items: Array<{ from: number; to: number; kind: Highlight["kind"] }>; sticky: boolean }>();

const marks = {
  text: Decoration.mark({ class: "cm-lsp-occurrence" }),
  read: Decoration.mark({ class: "cm-lsp-occurrence cm-lsp-occurrence-read" }),
  write: Decoration.mark({ class: "cm-lsp-occurrence cm-lsp-occurrence-write" }),
};

const highlightField = StateField.define<HighlightState>({
  create: () => ({ deco: Decoration.none, sticky: false }),
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setHighlights))
        return {
          deco: Decoration.set(
            e.value.items.filter((i) => i.from < i.to).map((i) => marks[i.kind].range(i.from, i.to)),
            true,
          ),
          sticky: e.value.sticky,
        };
    if (tr.docChanged) return { deco: Decoration.none, sticky: false };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

async function fetchHighlights(view: EditorView, sticky: boolean) {
  const doc = docOf(view);
  if (!doc) return;
  const state = view.state;
  const head = state.selection.main.head;
  const stale = () => view.state.doc !== state.doc || view.state.selection.main.head !== head;
  const apply = (items: Array<{ from: number; to: number; kind: Highlight["kind"] }>) =>
    view.dispatch({ effects: setHighlights.of({ items, sticky }) });
  let lspError: unknown = null;
  if (!serverBackoff.active(doc.doc)) {
    try {
      const items = await lspRequest(() => commands.lspDocumentHighlights(doc.doc, offsetToPos(state.doc, head)));
      if (stale()) return;
      if (sticky && !items.length) showHint(view, "No usages found in file");
      apply(items.map((h) => ({ ...rangeToOffsets(state.doc, h.range), kind: h.kind })));
      return;
    } catch (e) {
      if (isCancelled(e)) return;
      if (isUnavailable(e)) serverBackoff.mark(doc.doc);
      lspError = e;
    }
  }
  // No usable server: only a certain local's same-scope occurrences (anything wider is too noisy to guess).
  const local = await syntaxHighlights(view, doc, head);
  if (stale()) return;
  if (local) {
    if (sticky) showHint(view, SYNTAX_NOTE, { timeout: 2500 });
    apply(local.map((h) => ({ ...rangeToOffsets(state.doc, h.range), kind: h.kind })));
    return;
  }
  if (lspError) reportLspError(view, lspError, sticky);
  else if (sticky) showHint(view, NO_SERVER);
  // Drop stale marks from an earlier caret position.
  if (view.state.field(highlightField).deco.size) apply([]);
}

async function syntaxHighlights(view: EditorView, doc: EditorDocContext, head: number) {
  try {
    if (!(await structure.support(doc.language)).locals) return null;
    await whenSynced(view);
    if (view.state.selection.main.head !== head) return null;
    return localHighlights(await structure.locals(doc.doc, offsetToPos(view.state.doc, head)));
  } catch (e) {
    if (!isCancelled(e)) console.debug("[syntax] highlight fallback", e);
    return null;
  }
}

/** ⌘⇧F7: highlight usages of the symbol at the caret until Escape. */
export function highlightUsages(view: EditorView) {
  void fetchHighlights(view, true);
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    private request = debounce(() => void fetchHighlights(this.view, false), 300);
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      if (u.docChanged) this.request.cancel();
      if (!u.selectionSet || u.docChanged) return;
      const st = u.state.field(highlightField);
      if (st.sticky) return;
      // Code Editing › "Usages of element at caret".
      if (!editorPrefs().codeEditing.highlightUsages) {
        if (st.deco.size) queueMicrotask(() => this.view.dispatch({ effects: setHighlights.of({ items: [], sticky: false }) }));
        return;
      }
      const sel = u.state.selection.main;
      if (!sel.empty) {
        this.request.cancel();
        if (st.deco.size) queueMicrotask(() => this.view.dispatch({ effects: setHighlights.of({ items: [], sticky: false }) }));
        return;
      }
      this.request();
    }
    destroy() {
      this.request.cancel();
    }
  },
);

export function navigationExtension(): Extension {
  return [
    linkField,
    linkPlugin,
    highlightField,
    highlightPlugin,
    Prec.high(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            const st = view.state.field(highlightField, false);
            if (!st?.sticky) return false;
            view.dispatch({ effects: setHighlights.of({ items: [], sticky: false }) });
            return true;
          },
        },
      ]),
    ),
  ];
}
