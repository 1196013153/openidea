/** Pure breakpoint list operations (0-based lines). */
import type { ChangeDesc, Text } from "@codemirror/state";
import type { Breakpoint } from "@/platform/ipc";

export interface BreakpointEntry {
  id: string;
  line: number;
  enabled: boolean;
  condition: string | null;
  logMessage: string | null;
  hitCondition: string | null;
  /** Temporary line breakpoint (⌥⇧⌘F8): removed after the first hit. */
  temporary?: boolean;
}

export interface BreakpointStatus {
  verified: boolean;
  message: string | null;
  /** Line the adapter actually bound to (may differ from the requested one). */
  line: number;
}

let seq = 0;
export function newBreakpointId(): string {
  seq += 1;
  return `bp${Date.now().toString(36)}-${seq}`;
}

export function makeBreakpoint(
  line: number,
  props: Partial<Omit<BreakpointEntry, "id" | "line">> = {},
): BreakpointEntry {
  return {
    id: newBreakpointId(),
    line,
    enabled: props.enabled ?? true,
    condition: props.condition ?? null,
    logMessage: props.logMessage ?? null,
    hitCondition: props.hitCondition ?? null,
    ...(props.temporary ? { temporary: true } : {}),
  };
}

export function sortByLine<T extends { line: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.line - b.line);
}

/** Adds a breakpoint on `line`, or removes the one there. */
export function toggleLine(list: readonly BreakpointEntry[], line: number): BreakpointEntry[] {
  return list.some((b) => b.line === line)
    ? list.filter((b) => b.line !== line)
    : sortByLine([...list, makeBreakpoint(line)]);
}

/** True when the breakpoint has a condition, hit condition or log message. */
export function isConditional(b: BreakpointEntry): boolean {
  return !!(b.condition?.trim() || b.hitCondition?.trim() || b.logMessage?.trim());
}

/**
 * Maps breakpoint lines through an edit. A breakpoint follows the start of
 * its line; when lines merge, the first breakpoint on a line wins.
 */
export function mapLines<T extends { line: number }>(
  list: readonly T[],
  oldDoc: Text,
  changes: ChangeDesc,
  newDoc: Text,
): T[] {
  if (changes.empty) return [...list];
  const out: T[] = [];
  const seen = new Set<number>();
  for (const b of sortByLine(list)) {
    if (b.line >= oldDoc.lines) {
      if (!seen.has(b.line)) out.push(b);
      seen.add(b.line);
      continue;
    }
    const lineStart = oldDoc.line(b.line + 1).from;
    // assoc 1: text inserted at the very start of the line pushes the breakpoint down with it.
    const pos = changes.mapPos(lineStart, 1);
    const line = newDoc.lineAt(Math.min(pos, newDoc.length)).number - 1;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line === b.line ? b : { ...b, line });
  }
  return out;
}

/** The list sent to the backend; muting disables everything without touching the stored flags. */
export function toBackend(list: readonly BreakpointEntry[], muted: boolean): Breakpoint[] {
  return list.map((b) => ({
    line: b.line,
    condition: b.condition?.trim() || null,
    hitCondition: b.hitCondition?.trim() || null,
    logMessage: b.logMessage?.trim() || null,
    enabled: b.enabled && !muted,
  }));
}

export function sameEntries(a: readonly BreakpointEntry[], b: readonly BreakpointEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.id === y.id &&
      x.line === y.line &&
      x.enabled === y.enabled &&
      x.condition === y.condition &&
      x.logMessage === y.logMessage &&
      x.hitCondition === y.hitCondition &&
      !!x.temporary === !!y.temporary
    );
  });
}
