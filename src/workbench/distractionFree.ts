/**
 * Distraction Free Mode (View › Appearance), IDEA semantics: tool windows,
 * stripes, main toolbar contents, status bar, editor tabs, breadcrumbs and
 * the editor gutter are hidden and the text column is centred at Settings ›
 * Editor › General › Appearance "Distraction free mode text width". The same
 * action enters and exits; Esc does not exit. Kept per window across reloads
 * (sessionStorage), not across restarts. Published as the `distractionFree`
 * context key; components read `useDistractionFree`.
 */
import { create } from "zustand";
import { registerAction, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { enterDistractionFreeLayout, exitDistractionFreeLayout, useToolWindowLayout } from "./toolwindows/store";

/** Kept from the original id so keymaps (VS Code's ⌘K Z, user bindings) stay bound. */
export const DISTRACTION_FREE_ACTION = "editor.toggleZen";
export const DISTRACTION_FREE_CONTEXT = "distractionFree";
export const DEFAULT_DISTRACTION_FREE_WIDTH = 80;
const SESSION_KEY = "openidea.distractionFree";

export const useDistractionFree = create<{ active: boolean }>(() => ({ active: false }));

export function isDistractionFree(): boolean {
  return useDistractionFree.getState().active;
}

/** Text width in columns (Settings › Editor › General › Appearance), clamped like IDEA's field. */
export function distractionFreeWidth(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(500, Math.max(20, Math.round(raw))) : DEFAULT_DISTRACTION_FREE_WIDTH;
}

export function distractionFreeTitle(active: boolean): string {
  return active ? "Exit Distraction Free Mode" : "Enter Distraction Free Mode";
}

function writeSession(active: boolean) {
  try {
    if (active) sessionStorage.setItem(SESSION_KEY, "1");
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

function readSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDistractionFree(active: boolean) {
  if (active === isDistractionFree()) return;
  useDistractionFree.setState({ active });
  setContext(DISTRACTION_FREE_CONTEXT, active);
  writeSession(active);
  if (active) enterDistractionFreeLayout();
  else exitDistractionFreeLayout();
}

export function toggleDistractionFree() {
  setDistractionFree(!isDistractionFree());
}

function action(active: boolean): Action {
  return {
    id: DISTRACTION_FREE_ACTION,
    title: distractionFreeTitle(active),
    category: "View",
    keywords: ["zen", "distraction free", "toggle distraction free mode"],
    run: toggleDistractionFree,
  };
}

/**
 * Registers the action (its title follows the mode, like IDEA's
 * Enter / Exit Distraction Free Mode), restores the mode of this window
 * and re-applies the hidden tool window layout when a project's layout loads.
 */
export function installDistractionFree(): () => void {
  let dispose = registerAction(action(isDistractionFree()));
  const unsubMode = useDistractionFree.subscribe((s, prev) => {
    if (s.active === prev.active) return;
    const previous = dispose;
    dispose = registerAction(action(s.active));
    previous();
  });
  const unsubLayout = useToolWindowLayout.subscribe((s, prev) => {
    if (s.scope !== prev.scope && isDistractionFree()) enterDistractionFreeLayout();
  });
  setContext(DISTRACTION_FREE_CONTEXT, isDistractionFree());
  if (readSession()) setDistractionFree(true);
  return () => {
    unsubMode();
    unsubLayout();
    dispose();
  };
}

/** Test helper. */
export function resetDistractionFree() {
  useDistractionFree.setState({ active: false });
  setContext(DISTRACTION_FREE_CONTEXT, false);
  writeSession(false);
}
