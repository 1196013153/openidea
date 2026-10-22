/** Commit tool window state shared with actions (selection, message draft). */
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import type { CheckState } from "./changes";
import { useVcs } from "./store";

interface CommitState {
  message: string;
  amend: boolean;
  signOff: boolean;
  groupByDir: boolean;
  /** User overrides of the inclusion checkboxes (absolute path → state). */
  checks: Map<string, CheckState>;
  /** Absolute paths selected in the changes tree. */
  selection: string[];
  /** Bumped to focus the message field. */
  focusTick: number;
  tab: CommitTab;
  /** Change list of the selected tree node (list actions without an argument). */
  selectedList: string | null;
  /** Selected entry of the Shelf tab. */
  selectedShelf: string | null;
}

export type CommitTab = "changes" | "shelf" | "stashes";

export const useCommit = create<CommitState>(() => ({
  message: "",
  amend: false,
  signOff: false,
  groupByDir: readBool("openidea.vcs.groupByDir", false),
  checks: new Map(),
  selection: [],
  focusTick: 0,
  tab: "changes",
  selectedList: null,
  selectedShelf: null,
}));

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}

export function setGroupByDir(v: boolean) {
  useCommit.setState({ groupByDir: v });
  try {
    localStorage.setItem("openidea.vcs.groupByDir", String(v));
  } catch {
    // ignore
  }
}

const historyKey = () => `openidea.vcs.commitMessages:${useVcs.getState().root ?? ""}`;
const MAX_HISTORY = 20;

export function messageHistory(): string[] {
  try {
    const raw = localStorage.getItem(historyKey());
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberMessage(message: string) {
  const m = message.trim();
  if (!m) return;
  try {
    const list = [m, ...messageHistory().filter((x) => x !== m)].slice(0, MAX_HISTORY);
    localStorage.setItem(historyKey(), JSON.stringify(list));
  } catch {
    // ignore
  }
}

/** Operations whose commit message git prepares in `.git/MERGE_MSG`. */
const PREPARED_MESSAGE_OPS = new Set(["merge", "cherry-pick", "revert"]);

/** `MERGE_MSG` without git's `#` comment lines (the conflict list etc.). */
export function preparedMessageText(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

/**
 * Like IDEA, pre-fills an empty commit message with the message git prepared
 * for a merge / cherry-pick / revert that stopped (e.g. on conflicts).
 */
export function installPreparedMessage(): () => void {
  const load = async () => {
    const root = useVcs.getState().root;
    if (!root || useCommit.getState().message.trim()) return;
    try {
      const text = preparedMessageText(await call(commands.fsReadText(`${root}/.git/MERGE_MSG`)));
      if (text && !useCommit.getState().message.trim()) useCommit.setState({ message: text });
    } catch {
      // No prepared message (or `.git` is a worktree file): leave the field empty.
    }
  };
  const op = (s = useVcs.getState()) => s.branch?.operation ?? null;
  if (PREPARED_MESSAGE_OPS.has(op() ?? "")) void load();
  return useVcs.subscribe((s, prev) => {
    const now = op(s);
    if (now !== op(prev) && PREPARED_MESSAGE_OPS.has(now ?? "")) void load();
  });
}
