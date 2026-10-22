/** Page context for the form components: which page / scope they edit and the search query. */
import { createContext, useCallback, useContext } from "react";
import { stage, stagedValue, useSettingsDialog, type Scope } from "../model/staging";
import { labelMatches } from "../model/pages";

export interface PageContextValue {
  pageId: string;
  scope: Scope;
}

export const PageContext = createContext<PageContextValue>({ pageId: "", scope: "global" });

export function usePageContext(): PageContextValue {
  return useContext(PageContext);
}

/** Staged value of a settings key plus a setter that stages edits for this page's scope. */
export function useSetting<T>(key: string, scopeOverride?: Scope): [T, (value: T) => void] {
  const { pageId, scope: pageScope } = usePageContext();
  const scope = scopeOverride ?? pageScope;
  const value = useSettingsDialog((s) => stagedValue(s, scope, key)) as T;
  const set = useCallback((v: T) => stage(pageId, scope, key, v), [pageId, scope, key]);
  return [value, set];
}

export function useSearchQuery(): string {
  return useSettingsDialog((s) => s.query);
}

/** Whether `label` should be highlighted for the current search. */
export function useLabelMatch(label: string | undefined): boolean {
  const q = useSearchQuery();
  return !!label && labelMatches(label, q);
}
