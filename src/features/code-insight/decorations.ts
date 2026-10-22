/** "problems" file decorations: files with errors (and their folders) get IDEA's red underline. */
import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";
import { countSeverities, fileDiagnostics, useProblems, type ProblemsMap } from "./problemsStore";

export function problemDecorations(map: ProblemsMap): Map<string, FileDecoration> {
  const out = new Map<string, FileDecoration>();
  for (const path of map.keys()) {
    const c = countSeverities(fileDiagnostics(map, path));
    if (!c.error) continue;
    out.set(path, {
      error: true,
      propagate: true,
      tooltip: `${c.error} ${c.error === 1 ? "error" : "errors"}${c.warning ? `, ${c.warning} ${c.warning === 1 ? "warning" : "warnings"}` : ""}`,
    });
  }
  return out;
}

export function installProblemDecorations(): () => void {
  let scheduled = false;
  const push = () => {
    if (scheduled) return;
    scheduled = true;
    // Diagnostics often arrive in bursts (one event per file); coalesce.
    setTimeout(() => {
      scheduled = false;
      setFileDecorations("problems", problemDecorations(useProblems.getState().map));
    }, 50);
  };
  const unsub = useProblems.subscribe((s, prev) => {
    if (s.map !== prev.map) push();
  });
  return () => {
    unsub();
    setFileDecorations("problems", new Map());
  };
}
