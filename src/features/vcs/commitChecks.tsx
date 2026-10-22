/**
 * Commit checks (Settings › Version Control › Commit / Git): before-commit
 * modifications (Reformat code, Optimize imports, Cleanup) applied through
 * the language servers, then the checks (Analyze code, Check TODO) and the Git
 * warnings (detached HEAD / rebase, CRLF line separators).
 */
import type { ReactNode } from "react";
import type { Diagnostic } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { Dialog } from "@/ui";
import { maybeEditorService, toolWindowService } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import { baseName, relTo } from "./model";
import { logConsole } from "./ops";
import { useVcs } from "./store";
import styles from "./common.module.css";

// ---------------------------------------------------------------------------
// Diagnostics seen per file (Analyze code)

const diagnostics = new Map<string, Map<string, Diagnostic[]>>();
/** Paths that received at least one diagnostics event. */
const analyzed = new Set<string>();
const waiters = new Set<() => void>();

export function installDiagnosticsTracking(): () => void {
  return onIdeEvent("diagnostics", (e) => {
    let sources = diagnostics.get(e.path);
    if (!sources) diagnostics.set(e.path, (sources = new Map()));
    if (e.items.length) sources.set(e.source, e.items);
    else sources.delete(e.source);
    analyzed.add(e.path);
    waiters.forEach((w) => w());
  });
}

export function problemCounts(paths: readonly string[]): { errors: number; warnings: number; files: number } {
  let errors = 0;
  let warnings = 0;
  let files = 0;
  for (const p of paths) {
    const items = [...(diagnostics.get(p)?.values() ?? [])].flat();
    const e = items.filter((d) => d.severity === "error").length;
    const w = items.filter((d) => d.severity === "warning").length;
    errors += e;
    warnings += w;
    if (e + w) files++;
  }
  return { errors, warnings, files };
}

/** Waits until every path was analysed (or `timeout`). */
function waitForAnalysis(paths: readonly string[], timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (paths.every((p) => analyzed.has(p))) finish();
    };
    const timer = setTimeout(() => finish(), timeout);
    const finish = () => {
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
}

// ---------------------------------------------------------------------------
// TODO items in added lines

const TODO_RE = /\b(TODO|FIXME)\b/i;

export interface TodoHit {
  path: string;
  /** 0-based line in the working text. */
  line: number;
  text: string;
}

/** TODO / FIXME in lines added or changed relative to `oldText`. */
export async function todosInChanges(path: string, oldText: string, newText: string): Promise<TodoHit[]> {
  const hunks = await commands.vcsDiffHunks(oldText, newText);
  const lines = newText.split("\n");
  const out: TodoHit[] = [];
  for (const h of hunks) {
    for (let l = h.start; l < h.start + h.lines; l++) {
      const text = lines[l] ?? "";
      if (TODO_RE.test(text)) out.push({ path, line: l, text: text.trim() });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Headless modifications through the language server

function wholeRange(text: string) {
  const lines = text.split("\n");
  return { start: { line: 0, col: 0 }, end: { line: lines.length - 1, col: lines[lines.length - 1]!.length } };
}

async function applyKind(doc: number, text: string, kind: string): Promise<boolean> {
  const actions = (await call(commands.lspCodeActions(doc, wholeRange(text), [kind]))).filter(
    (a) => a.kind?.startsWith(kind) && !a.disabledReason,
  );
  const action = actions.find((a) => a.isPreferred) ?? actions[0];
  if (!action) return false;
  await call(commands.lspApplyCodeAction(doc, action));
  return true;
}

export interface Modifications {
  reformat: boolean;
  optimizeImports: boolean;
  cleanup: boolean;
}

/** Applies the enabled modifications to one file and saves it. Errors are logged, not thrown. */
async function modifyFile(path: string, mods: Modifications) {
  let info;
  try {
    info = await call(commands.docOpen(path));
  } catch {
    return;
  }
  try {
    const step = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        logConsole("info", `${label} skipped for ${baseName(path)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    if (mods.optimizeImports) await step("Optimize imports", async () => applyKind(info.id, (await call(commands.docSnapshot(info.id))).text, "source.organizeImports"));
    if (mods.cleanup) await step("Cleanup", async () => applyKind(info.id, (await call(commands.docSnapshot(info.id))).text, "source.fixAll"));
    if (mods.reformat)
      await step("Reformat code", async () => {
        const editor = useProject.getState().settings?.editor as { tabSize?: number; insertSpaces?: boolean } | undefined;
        const edits = await call(
          commands.lspFormat(info.id, null, { tabSize: editor?.tabSize ?? 4, insertSpaces: editor?.insertSpaces ?? true }),
        );
        if (edits.length) await call(commands.applyWorkspaceEdit({ files: [{ kind: "edit", path, edits }] }));
      });
    await call(commands.docSave(info.id));
  } finally {
    void commands.docClose(info.id);
  }
}

// ---------------------------------------------------------------------------
// Dialogs

type Choice = "commit" | "review" | "cancel";

function choiceDialog(title: string, body: ReactNode, reviewLabel?: string): Promise<Choice> {
  return new Promise((resolve) => {
    const close = openDialog(() => {
      const done = (c: Choice) => {
        close();
        resolve(c);
      };
      return (
        <Dialog
          open
          title={title}
          onClose={() => done("cancel")}
          width={520}
          buttons={[
            ...(reviewLabel ? [{ label: reviewLabel, onClick: () => done("review") }] : []),
            { label: "Commit Anyway", role: "default", autoFocus: true, onClick: () => done("commit") },
            { label: "Cancel", role: "cancel", onClick: () => done("cancel") },
          ]}
        >
          <div className={styles.message}>{body}</div>
        </Dialog>
      );
    });
  });
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------

export interface CommitCandidate {
  /** Absolute path. */
  path: string;
  /** False for deletions. */
  exists: boolean;
}

/**
 * Runs the configured before-commit modifications and checks for the files
 * about to be committed. Resolves false when the user cancels the commit.
 */
export async function runCommitChecks(files: readonly CommitCandidate[], amend: boolean): Promise<boolean> {
  const { commit, git } = workflowSettings().vcs;
  const branch = useVcs.getState().branch;

  if (git.warnDetachedHead && branch && (!branch.head || branch.operation === "rebase")) {
    const rebase = branch.operation === "rebase";
    const choice = await choiceDialog(
      rebase ? "Commit During Rebase" : "Commit in Detached HEAD",
      rebase
        ? "A rebase is in progress. The commit will become part of the rebased history; usually you continue the rebase instead."
        : "HEAD is detached: the commit won't belong to any branch and may be lost after checking out another branch. Create a branch first to keep it.",
    );
    if (choice !== "commit") return false;
  }

  const existing = files.filter((f) => f.exists).map((f) => f.path);
  if (!isTauri() || !existing.length) return true;

  const mods: Modifications = { reformat: commit.reformat, optimizeImports: commit.optimizeImports, cleanup: commit.cleanup };
  if (mods.reformat || mods.optimizeImports || mods.cleanup) {
    logConsole("info", `Before commit: ${[mods.optimizeImports && "optimize imports", mods.cleanup && "cleanup", mods.reformat && "reformat code"].filter(Boolean).join(", ")}`);
    for (const p of existing) await modifyFile(p, mods);
    try {
      await maybeEditorService()?.saveAll();
    } catch {
      // best effort
    }
  }

  if (commit.analyzeCode) {
    // Opening the files makes their language servers analyse them.
    const opened: number[] = [];
    for (const p of existing.filter((p) => !analyzed.has(p))) {
      try {
        opened.push((await call(commands.docOpen(p))).id);
      } catch {
        // binary / unreadable
      }
    }
    try {
      await waitForAnalysis(existing, opened.length ? 2000 : 0);
    } finally {
      opened.forEach((id) => void commands.docClose(id));
    }
    const { errors, warnings, files: n } = problemCounts(existing);
    if (errors + warnings > 0) {
      const parts = [errors && plural(errors, "error"), warnings && plural(warnings, "warning")].filter(Boolean).join(" and ");
      const choice = await choiceDialog("Code Analysis", `${parts} found in ${plural(n, "file")}.`, "Review");
      if (choice === "review") {
        try {
          toolWindowService().show("problems", true);
        } catch {
          // no Problems tool window
        }
        return false;
      }
      if (choice === "cancel") return false;
    }
  }

  if (commit.checkTodo) {
    const root = useVcs.getState().root ?? "";
    const hits: TodoHit[] = [];
    for (const p of existing) {
      try {
        const [oldText, newText] = await Promise.all([
          call(commands.vcsFileAt(p, amend ? "HEAD~1" : "HEAD")).catch(() => null),
          call(commands.fsReadText(p)),
        ]);
        hits.push(...(await todosInChanges(p, oldText ?? "", newText)));
      } catch {
        // unreadable / binary
      }
    }
    if (hits.length) {
      const choice = await choiceDialog(
        "TODO",
        <>
          <div>{plural(hits.length, "TODO item")} found in the changed lines:</div>
          <ul className={styles.todoList}>
            {hits.slice(0, 20).map((h, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => void maybeEditorService()?.openFile(h.path, { selection: { line: h.line, col: 0 }, focus: true })}
                >
                  {relTo(root, h.path)}:{h.line + 1}
                </button>{" "}
                {h.text}
              </li>
            ))}
            {hits.length > 20 && <li>…</li>}
          </ul>
        </>,
      );
      if (choice !== "commit") return false;
    }
  }

  if (git.warnCrlf) {
    const autocrlf = (await call(commands.vcsConfigGet("core.autocrlf")).catch(() => null))?.toLowerCase();
    if (autocrlf !== "true" && autocrlf !== "input") {
      const crlf: string[] = [];
      for (const p of existing) {
        try {
          if ((await call(commands.fsReadText(p))).includes("\r\n")) crlf.push(p);
        } catch {
          // skip
        }
      }
      if (crlf.length) {
        const choice = await choiceDialog(
          "Line Separators Warning",
          <>
            {plural(crlf.length, "file")} ({crlf.slice(0, 5).map(baseName).join(", ")}
            {crlf.length > 5 ? ", …" : ""}) contain CRLF line separators and core.autocrlf is not set, so they would be
            committed with CRLF. Convert them with the line separator widget in the status bar, or set{" "}
            <code>git config core.autocrlf input</code>.
          </>,
        );
        if (choice !== "commit") return false;
      }
    }
  }
  return true;
}
