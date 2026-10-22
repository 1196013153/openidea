/** Pure mapping from backend completion items to CodeMirror completions. */
import type { Completion } from "@codemirror/autocomplete";
import type { CompletionItem, CompletionKind } from "@/bindings";

/** Completion kind → the design system's symbol badge kind (`ui/icons` `SymbolBadge`). */
const KIND_TO_SYMBOL: Record<CompletionKind, string> = {
  text: "text",
  method: "method",
  function: "function",
  constructor: "constructor",
  field: "field",
  variable: "variable",
  class: "class",
  interface: "interface",
  module: "module",
  property: "property",
  unit: "constant",
  value: "constant",
  enum: "enum",
  keyword: "keyword",
  snippet: "snippet",
  color: "constant",
  file: "file",
  reference: "variable",
  folder: "package",
  enumMember: "constant",
  constant: "constant",
  struct: "struct",
  event: "field",
  operator: "keyword",
  typeParameter: "type",
};

export function completionSymbolKind(kind: CompletionKind | null): string {
  return kind ? KIND_TO_SYMBOL[kind] : "text";
}

/**
 * Maps the declarative fields. `label` is what CodeMirror filters on, so an
 * LSP `filterText` that differs from the label becomes the label and the
 * original label is shown through `displayLabel`.
 */
export function toCmCompletion(item: CompletionItem): Completion {
  const filter = item.filterText && item.filterText !== item.label ? item.filterText : null;
  const c: Completion = {
    label: filter ?? item.label,
    type: completionSymbolKind(item.kind),
  };
  if (filter) c.displayLabel = item.label;
  if (item.labelDetail) c.detail = item.labelDetail;
  if (item.sortText) c.sortText = item.sortText;
  if (item.preselect) c.boost = 99;
  else if (item.deprecated) c.boost = -20;
  if (item.commitCharacters.length) c.commitCharacters = item.commitCharacters;
  return c;
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** End of the identifier starting at `pos` in `line` (for ⇥ Replace without a server range). */
export function identifierEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
  return i;
}

/** Completion trigger character for the text just before the caret, if any. */
export function triggerCharacter(before: string): string | null {
  const last = before.slice(-1);
  if (last === ".") return before.slice(-2) === ".." ? null : ".";
  if (last === ":") return before.slice(-2) === "::" ? ":" : null;
  if (last === ">") return before.slice(-2) === "->" ? ">" : null;
  if (last === "@") return "@";
  return null;
}
