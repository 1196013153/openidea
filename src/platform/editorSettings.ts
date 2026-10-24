/**
 * Frontend shape of the Editor settings added for IDEA's Editor group
 * (mirrors `ide-core::editor_settings`). Validation is structural: every
 * value is coerced to the type of its default, so a malformed TOML entry
 * falls back to the default instead of reaching the editor.
 */
import { useProject } from "./project";

export interface TextAttributesOverride {
  foreground?: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  effect?: "underline" | "wave" | "strikeout" | "none";
  effectColor?: string;
}

export interface LanguageCodeStyle {
  useTab?: boolean;
  tabSize?: number;
  indent?: number;
  hardWrapAt?: number;
  /** Code Generation › Comment Code (unset: the language's default, see `lineCommentDefaults`). */
  lineCommentAtFirstColumn?: boolean;
  lineCommentAddSpace?: boolean;
}

/**
 * IDEA's per-language Comment Code defaults: line comments at the first column
 * without a space, except where the language's code
 * style says otherwise (Python's indented `# `; Go and Rust's indented `// `).
 */
const LINE_COMMENT_DEFAULTS: Record<string, { atFirstColumn: boolean; addSpace: boolean }> = {
  python: { atFirstColumn: false, addSpace: true },
  go: { atFirstColumn: false, addSpace: true },
  rust: { atFirstColumn: false, addSpace: true },
};

export function lineCommentDefaults(language: string | undefined): { atFirstColumn: boolean; addSpace: boolean } {
  return (language && LINE_COMMENT_DEFAULTS[language]) || { atFirstColumn: true, addSpace: false };
}

/** Effective Comment Code style of a language: Code Style override, else the language default. */
export function lineCommentStyleFor(prefs: EditorExtras, language: string | undefined): { atFirstColumn: boolean; addSpace: boolean } {
  const base = lineCommentDefaults(language);
  const own = language ? prefs.codeStyle.languages[language] : undefined;
  return {
    atFirstColumn: typeof own?.lineCommentAtFirstColumn === "boolean" ? own.lineCommentAtFirstColumn : base.atFirstColumn,
    addSpace: typeof own?.lineCommentAddSpace === "boolean" ? own.lineCommentAddSpace : base.addSpace,
  };
}

export const EDITOR_EXTRA_DEFAULTS = {
  colorOverrides: {} as Record<string, Record<string, TextAttributesOverride>>,
  ligatures: false,
  fallbackFont: "",
  general: {
    wheelZoom: false,
    dragAndDrop: true,
    caretScroll: "minimize",
    softWrapFiles: "*.md; *.txt; *.rst; *.adoc",
    softWrapIndent: true,
    scrollPastEnd: true,
    stripTrailingScope: "modified",
    keepTrailingOnCaretLine: true,
    removeTrailingBlankLines: false,
    richTextCopy: true,
  },
  appearance: {
    caretBlinking: true,
    caretBlinkPeriod: 500,
    blockCaret: false,
    lineNumbers: true,
    methodSeparators: false,
    whitespaceLeading: true,
    whitespaceInner: true,
    whitespaceTrailing: true,
    indentGuides: true,
    hardWrapGuides: true,
    intentionBulb: true,
    distractionFreeWidth: 80,
  },
  breadcrumbs: { show: true, placement: "bottom", disabledLanguages: [] as string[] },
  completion: {
    matchCase: true,
    caseSensitivity: "first",
    autoPopup: true,
    insertOnSpecialKeys: false,
    showDocumentation: false,
    documentationDelay: 500,
    parameterInfo: true,
    parameterInfoDelay: 1000,
  },
  autoImport: { addUnambiguous: false, optimizeOnTheFly: false },
  folding: { showOutline: true, fileHeader: true, imports: true, docComments: false },
  tabs: {
    placement: "top",
    multipleRows: false,
    showExtension: true,
    markModified: false,
    showCloseButton: true,
    previewTab: true,
    openAtEnd: false,
    tabLimit: 30,
    closingPolicy: "lru",
    activateOnClose: "left",
  },
  smartKeys: {
    smartHome: true,
    camelHumps: false,
    pairBrackets: true,
    pairQuotes: true,
    surroundSelection: true,
    tabOutOfPair: true,
    reformatOnPaste: "indentBlock",
    smartIndent: true,
    backspaceUnindent: "autoindent",
  },
  codeEditing: {
    highlightUsages: true,
    highlightBraces: true,
    highlightSelection: true,
    quickDocOnHover: true,
    quickDocDelay: 500,
    nextErrorErrorsOnly: true,
    stickyLinesMax: 5,
  },
  inlay: { types: true, parameters: true, other: true, disabledLanguages: [] as string[], codeVisionUsages: true },
  gutterIconsDisabled: [] as string[],
  showGutterIcons: true,
  codeStyle: {
    lineSeparator: "system",
    hardWrapAt: 120,
    visualGuides: [] as number[],
    detectIndents: true,
    editorconfig: true,
    languages: {} as Record<string, LanguageCodeStyle>,
  },
  encodings: { global: "utf-8", project: "utf-8", properties: "iso-8859-1", utf8Bom: "never" },
};

export type EditorExtras = typeof EDITOR_EXTRA_DEFAULTS;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Coerces `raw` to the shape of `def`; `{}` defaults are free-form maps kept as given. */
export function coerceLike<T>(raw: unknown, def: T): T {
  if (Array.isArray(def)) {
    if (!Array.isArray(raw)) return [...def] as T;
    const sample = def[0];
    return raw.filter((x) =>
      sample === undefined ? typeof x === "string" || typeof x === "number" : typeof x === typeof sample,
    ) as T;
  }
  if (isObj(def)) {
    const keys = Object.keys(def);
    if (!keys.length) return (isObj(raw) ? { ...raw } : {}) as T;
    const src = isObj(raw) ? raw : {};
    const out: Obj = {};
    for (const k of keys) out[k] = coerceLike(src[k], (def as Obj)[k]);
    return out as T;
  }
  if (typeof def === "number") return (typeof raw === "number" && Number.isFinite(raw) ? raw : def) as T;
  if (typeof def === "boolean") return (typeof raw === "boolean" ? raw : def) as T;
  if (typeof def === "string") return (typeof raw === "string" ? raw : def) as T;
  return def;
}

export function validateEditorExtras(raw: unknown): EditorExtras {
  return coerceLike(raw, EDITOR_EXTRA_DEFAULTS);
}

let cache: { raw: unknown; value: EditorExtras } | null = null;

/** Effective Editor-group settings (validated, memoised per settings object). */
export function editorPrefs(settings: unknown = useProject.getState().settings): EditorExtras {
  const raw = settings && typeof settings === "object" ? (settings as Obj).editor : undefined;
  if (cache && cache.raw === raw) return cache.value;
  const value = validateEditorExtras(raw);
  cache = { raw, value };
  return value;
}

/** Reactive variant of `editorPrefs`. */
export function useEditorPrefs(): EditorExtras {
  return editorPrefs(useProject((s) => s.settings));
}

/** Encodings offered by File Encodings and the status-bar widget (WHATWG label, display name). */
export const ENCODING_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ["utf-8", "UTF-8"],
  ["utf-16le", "UTF-16LE"],
  ["utf-16be", "UTF-16BE"],
  ["gbk", "GBK"],
  ["gb18030", "GB18030"],
  ["big5", "Big5"],
  ["shift_jis", "Shift_JIS"],
  ["euc-kr", "EUC-KR"],
  ["windows-1252", "windows-1252"],
  ["iso-8859-1", "ISO-8859-1"],
  ["koi8-r", "KOI8-R"],
];
