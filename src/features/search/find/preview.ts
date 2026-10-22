import { editorsFor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";

const cache = new Map<string, Promise<string>>();

/**
 * File text for the preview pane: the live buffer of an open editor, else a
 * read-only backend read (doesn't open a document or touch recent files).
 */
export function loadPreviewText(path: string): Promise<string> {
  const view = editorsFor(path)[0]?.view;
  if (view) return Promise.resolve(view.state.doc.toString());
  let p = cache.get(path);
  if (!p) {
    p = (async () => {
      return call(commands.fsReadText(path));
    })();
    p.catch(() => cache.delete(path));
    cache.set(path, p);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export function clearPreviewCache() {
  cache.clear();
}
