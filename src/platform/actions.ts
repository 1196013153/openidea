/**
 * The action system ("everything is an action"), modelled on IDEA's ActionManager.
 *
 * Menus, keybindings, toolbar buttons, context menus and the Actions tab of
 * Search Everywhere all resolve to the same registry, so a feature registers
 * its behaviour once:
 *
 *   registerAction({ id: "editor.formatDocument", title: "Reformat Code",
 *                    category: "Code", when: "editorFocus", run: () => … });
 *
 * Default keybindings live in keymaps (`keymap.ts`), not on the action.
 */
import { create } from "zustand";
import { evaluateWhen, getContext, type ContextKeys } from "./context";

export interface ActionContext {
  ctx: ContextKeys;
  /** Optional argument from the invoker (e.g. a menu passing a file path). */
  arg?: unknown;
}

export interface Action {
  /** Dotted, stable id, e.g. `navigate.searchEverywhere`. */
  id: string;
  title: string;
  /** Group shown in Search Everywhere and the keymap editor, e.g. `Navigate`. */
  category?: string;
  description?: string;
  /** Icon name from `ui/icons`. */
  icon?: string;
  /** Enablement; evaluated against context keys. */
  when?: string;
  /**
   * Extra condition for keyboard shortcuts only (menus and Find Action ignore
   * it), e.g. to yield a shared shortcut to an editor action while typing.
   */
  keyWhen?: string;
  /** Extra search terms for the Actions tab. */
  keywords?: string[];
  /** Hidden from Search Everywhere (internal / parameterised actions). */
  hidden?: boolean;
  /**
   * Marks a toggle action (IDEA's ToggleAction): returns the current state.
   * Search Everywhere shows an ON/OFF switch and keeps the popup open.
   */
  toggled?: () => boolean;
  run: (c: ActionContext) => void | Promise<void>;
}

interface ActionStore {
  actions: Map<string, Action>;
}

export const useActions = create<ActionStore>(() => ({ actions: new Map() }));

/** Registers an action; returns a disposer. Re-registering an id replaces it. */
export function registerAction(action: Action): () => void {
  useActions.setState((s) => ({ actions: new Map(s.actions).set(action.id, action) }));
  return () =>
    useActions.setState((s) => {
      if (s.actions.get(action.id) !== action) return s;
      const actions = new Map(s.actions);
      actions.delete(action.id);
      return { actions };
    });
}

export function registerActions(actions: Action[]): () => void {
  const disposers = actions.map(registerAction);
  return () => disposers.forEach((d) => d());
}

export function getAction(id: string): Action | undefined {
  return useActions.getState().actions.get(id);
}

export function allActions(): Action[] {
  return [...useActions.getState().actions.values()];
}

export function isActionEnabled(action: Action, ctx: ContextKeys = getContext()): boolean {
  return evaluateWhen(action.when, ctx);
}

/** Whether a keyboard shortcut may run `action` (`when` and `keyWhen`). */
export function isActionKeyEnabled(action: Action, ctx: ContextKeys = getContext()): boolean {
  return isActionEnabled(action, ctx) && evaluateWhen(action.keyWhen, ctx);
}

/** Current state of a toggle action, or `undefined` for plain actions. */
export function actionToggled(action: Action | undefined): boolean | undefined {
  if (!action?.toggled) return undefined;
  try {
    return action.toggled();
  } catch {
    return false;
  }
}

/** Runs an action if registered and enabled. Returns whether it ran. */
export async function executeAction(id: string, arg?: unknown): Promise<boolean> {
  const action = getAction(id);
  if (!action) {
    console.warn(`unknown action: ${id}`);
    return false;
  }
  const ctx = getContext();
  if (!isActionEnabled(action, ctx)) return false;
  try {
    await action.run({ ctx, arg });
  } catch (e) {
    console.error(`action ${id} failed`, e);
  }
  return true;
}
