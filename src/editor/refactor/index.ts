/**
 * Refactorings: Refactor This and the Refactor menu over LSP code actions,
 * Safe Delete, and the syntax-based fallbacks used when the language server
 * is not usable (see `@/editor/structure`).
 */
export { introduceFallback, type FallbackReason, type IntroduceKind } from "./introduce";
export { refactorThis, runRefactoring, showNothingHere } from "./refactorThis";
export {
  askUsagesDetected,
  fileUsages,
  safeDelete,
  viewUsages,
  type FileUsages,
  type UsagesAnswer,
} from "./safeDelete";
