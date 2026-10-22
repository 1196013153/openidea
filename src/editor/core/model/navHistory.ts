/**
 * Back / Forward navigation history (⌘[ / ⌘]), like IDEA's: the current
 * place is continuously updated while the caret moves locally; a file switch
 * or a jump of more than `JUMP_LINES` lines starts a new entry and drops the
 * forward stack.
 */
import type { NavigationLocation } from "@/editor/api";

export const JUMP_LINES = 10;
const MAX_ENTRIES = 100;

export class NavigationHistory {
  entries: NavigationLocation[] = [];
  index = -1;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  get current(): NavigationLocation | null {
    return this.entries[this.index] ?? null;
  }

  canGoBack() {
    return this.index > 0;
  }

  canGoForward() {
    return this.index < this.entries.length - 1;
  }

  /** Records the caret position after a selection change / tab switch. */
  update(loc: Omit<NavigationLocation, "time">) {
    const entry = { ...loc, time: this.now() };
    const cur = this.current;
    if (cur && cur.path === loc.path && Math.abs(cur.line - loc.line) <= JUMP_LINES) {
      this.entries[this.index] = entry;
      return;
    }
    this.entries = this.entries.slice(0, this.index + 1);
    // Revisiting the place we came from shouldn't stutter the history.
    const prev = this.entries[this.entries.length - 1];
    if (prev && prev.path === loc.path && prev.line === loc.line) this.entries.pop();
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.index = this.entries.length - 1;
    this.emit();
  }

  /** Moves back; returns the location to navigate to. */
  back(): NavigationLocation | null {
    if (!this.canGoBack()) return null;
    this.index--;
    this.emit();
    return this.current;
  }

  forward(): NavigationLocation | null {
    if (!this.canGoForward()) return null;
    this.index++;
    this.emit();
    return this.current;
  }

  /** Drops entries of a deleted file. */
  removePath(path: string) {
    const before = this.entries.length;
    const cur = this.current;
    this.entries = this.entries.filter((e) => e.path !== path);
    if (this.entries.length === before) return;
    this.index = cur && cur.path !== path ? this.entries.indexOf(cur) : this.entries.length - 1;
    this.emit();
  }

  clear() {
    this.entries = [];
    this.index = -1;
    this.emit();
  }

  snapshot() {
    return { entries: this.entries.map((e) => ({ ...e })), index: this.index };
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}
