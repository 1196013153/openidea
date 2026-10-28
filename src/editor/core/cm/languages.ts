/**
 * Language support: backend `LanguageInfo` (from `languages()`, fetched once)
 * maps a document's language id to the exact `@codemirror/language-data` name
 * (`uiMode`); the CodeMirror mode is loaded lazily and cached. Comment tokens
 * and indentation fall back to the backend definition when the mode lacks them.
 */
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { LRLanguage, LanguageDescription, LanguageSupport } from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { languages as languageData } from "@codemirror/language-data";
import type { DocBackend, LanguageInfo } from "../backend";
import { _languageMode } from "@/editor/api";

let infos: Map<string, LanguageInfo> | null = null;
let infosPromise: Promise<Map<string, LanguageInfo>> | null = null;

export function loadLanguageInfos(backend: DocBackend): Promise<Map<string, LanguageInfo>> {
  return (infosPromise ??= backend
    .languages()
    .then((list) => (infos = new Map(list.map((l) => [l.id, l]))))
    .catch((e) => {
      console.warn("languages() failed", e);
      infosPromise = null;
      return (infos = new Map());
    }));
}

export function languageInfo(id: string): LanguageInfo | undefined {
  return infos?.get(id);
}

/** Test hook. */
export function _resetLanguages() {
  infos = null;
  infosPromise = null;
}

/**
 * `uiMode` of the backend language for a file name (longest extension first,
 * like the backend's detection); `undefined` when the languages are not loaded
 * or none matches.
 */
export function uiModeForPath(path: string): string | null | undefined {
  if (!infos) return undefined;
  let rest = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  for (let dot = rest.indexOf("."); dot >= 0; dot = rest.indexOf(".")) {
    rest = rest.slice(dot + 1);
    for (const info of infos.values()) if (info.extensions.includes(rest)) return info.uiMode;
  }
  return undefined;
}

const supports = new Map<string, Promise<LanguageSupport | null>>();

export function findLanguageDescription(uiMode: string | null, path: string): LanguageDescription | null {
  if (uiMode) {
    const contributed = _languageMode(uiMode);
    if (contributed) return contributed;
    const exact = languageData.find((l) => l.name === uiMode);
    if (exact) return exact;
    const loose = LanguageDescription.matchLanguageName(languageData, uiMode, false);
    if (loose) return loose;
  }
  return uiMode === null && infos
    ? null
    : LanguageDescription.matchFilename(languageData, path.slice(path.lastIndexOf("/") + 1));
}

/** Loads (once) the CodeMirror language for `desc`. */
export function loadSupport(desc: LanguageDescription): Promise<LanguageSupport | null> {
  let p = supports.get(desc.name);
  if (!p) {
    p = desc
      .load()
      .then((support) => patchSupport(desc, support))
      .catch((e) => {
        console.warn(`failed to load language ${desc.name}`, e);
        supports.delete(desc.name);
        return null;
      });
    supports.set(desc.name, p);
  }
  return p;
}

/**
 * PyCharm CSS colours: selectors fall back to HTML tag name, property names to
 * HTML attribute name, values and units to HTML attribute value.
 */
const CSS_TAGS: Parameters<typeof styleTags>[0] = {
  "FeatureName PropertyName": t.attributeName,
  "ValueName FontName Unit": t.attributeValue,
  "ClassName IdName PseudoClassName ColorLiteral CallTag": t.tagName,
};

/** Highlighting the stock grammars lack or colour unlike IntelliJ. */
const EXTRA_TAGS: Record<string, Parameters<typeof styleTags>[0]> = {
  // @lezer/java tags annotations as plain identifiers.
  Java: { "MarkerAnnotation/Identifier Annotation/Identifier MarkerAnnotation Annotation": t.annotation },
  CSS: CSS_TAGS,
  SCSS: CSS_TAGS,
  Sass: CSS_TAGS,
  // YAML keys are keywords in IntelliJ.
  YAML: { "Key/Literal Key/QuotedLiteral": t.keyword },
};

function patchSupport(desc: LanguageDescription, support: LanguageSupport): LanguageSupport {
  const extra = EXTRA_TAGS[desc.name];
  if (!extra || !(support.language instanceof LRLanguage)) return support;
  const patched = new LanguageSupport(support.language.configure({ props: [styleTags(extra)] }), support.support);
  // `loadedSupport` reads `desc.support` synchronously; keep it on the patched instance.
  (desc as { support: LanguageSupport | undefined }).support = patched;
  return patched;
}

/** Already-loaded support (synchronous), so reopening a file paints highlighted at once. */
export function loadedSupport(desc: LanguageDescription | null): LanguageSupport | null {
  return desc?.support ?? null;
}

/** Comment tokens from the backend definition, below the mode's own data. */
export function commentTokens(info: LanguageInfo | undefined): Extension {
  if (!info || (!info.lineComment && !info.blockComment)) return [];
  const tokens: { line?: string; block?: { open: string; close: string } } = {};
  if (info.lineComment) tokens.line = info.lineComment;
  if (info.blockComment) tokens.block = { open: info.blockComment[0], close: info.blockComment[1] };
  return Prec.lowest(EditorState.languageData.of(() => [{ commentTokens: tokens }]));
}
