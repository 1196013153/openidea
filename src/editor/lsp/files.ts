/** Reading other files' text for previews (definitions, choosers). */
import { editorsFor } from "@/editor/api";
import { call, commands, isTauri } from "@/platform/ipc";
import { isVirtualUri, virtualDocument } from "@/platform/virtualDocs";

/**
 * Lines of `path`: from an open editor when there is one (includes unsaved
 * edits), otherwise a read-only backend read.
 */
export async function readFileLines(path: string): Promise<string[] | null> {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.doc.toJSON();
  if (!isTauri()) return null;
  if (isVirtualUri(path))
    return virtualDocument(path).then(
      (d) => d.text.split(/\r\n?|\n/),
      () => null,
    );
  try {
    const text = await call(commands.fsReadText(path));
    return text.split(/\r\n?|\n/);
  } catch {
    return null;
  }
}

/** Reads several files with bounded concurrency; missing files map to `null`. */
export async function readManyFileLines(paths: readonly string[], concurrency = 4): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  const queue = [...new Set(paths)];
  const worker = async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) out.set(p, await readFileLines(p));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}
