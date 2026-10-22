/** Summaries of workspace edits for rename / refactoring previews. */
import type { WorkspaceEdit } from "@/bindings";

export interface WorkspaceEditFileSummary {
  path: string;
  /** Text edits in this file. */
  edits: number;
  /** Non-text operations (create/rename/delete) touching this path. */
  operation?: "create" | "rename" | "delete";
  /** Rename target, for `operation: "rename"`. */
  to?: string;
}

export interface WorkspaceEditSummary {
  /** Distinct files touched (text edits or operations). */
  files: number;
  /** Total text edits. */
  occurrences: number;
  /** Whether the edit creates, renames or deletes files. */
  hasFileOperations: boolean;
  entries: WorkspaceEditFileSummary[];
}

export function summarizeWorkspaceEdit(edit: WorkspaceEdit): WorkspaceEditSummary {
  const byPath = new Map<string, WorkspaceEditFileSummary>();
  const entry = (path: string) => {
    let e = byPath.get(path);
    if (!e) byPath.set(path, (e = { path, edits: 0 }));
    return e;
  };
  let occurrences = 0;
  let hasFileOperations = false;
  for (const f of edit.files) {
    switch (f.kind) {
      case "edit": {
        entry(f.path).edits += f.edits.length;
        occurrences += f.edits.length;
        break;
      }
      case "create":
        hasFileOperations = true;
        entry(f.path).operation = "create";
        break;
      case "delete":
        hasFileOperations = true;
        entry(f.path).operation = "delete";
        break;
      case "rename": {
        hasFileOperations = true;
        const e = entry(f.from);
        e.operation = "rename";
        e.to = f.to;
        break;
      }
    }
  }
  const entries = [...byPath.values()].filter((e) => e.edits > 0 || e.operation);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { files: entries.length, occurrences, hasFileOperations, entries };
}

/** "3 occurrences in 2 files". */
export function describeSummary(s: WorkspaceEditSummary): string {
  const occ = `${s.occurrences} ${s.occurrences === 1 ? "occurrence" : "occurrences"}`;
  const files = `${s.files} ${s.files === 1 ? "file" : "files"}`;
  return `${occ} in ${files}`;
}

/** Whether applying needs confirmation (IDEA previews multi-file refactorings). */
export function needsPreview(s: WorkspaceEditSummary): boolean {
  return s.files > 1 || s.hasFileOperations;
}
