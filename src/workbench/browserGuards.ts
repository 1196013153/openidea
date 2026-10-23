/**
 * Makes the webview behave like a desktop app: never the browser context menu
 * (its Reload/AutoFill items would act on the webview), no reload/print/
 * save-page/history shortcuts, no navigation on file drop. Copy/paste/undo
 * shortcuts stay untouched.
 */

const BLOCKED = new Set([
  "Meta+P",
  "Ctrl+P",
  "Meta+S",
  "Meta+Shift+S",
  "Meta+O",
  "Meta+G",
  "Meta+Shift+G",
  "Meta+[",
  "Meta+]",
  "Meta+Alt+I",
  "Meta+U",
]);
const RELOAD = new Set(["Meta+R", "Meta+Shift+R", "Ctrl+R", "Ctrl+Shift+R", "F5", "Shift+F5"]);

function keyId(e: KeyboardEvent) {
  const key = e.code.startsWith("Key")
    ? e.code.slice(3)
    : e.code === "BracketLeft"
      ? "["
      : e.code === "BracketRight"
        ? "]"
        : e.key;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", key]
    .filter(Boolean)
    .join("+");
}

export function installBrowserGuards(opts: { blockReload?: boolean } = {}): () => void {
  const blockReload = opts.blockReload ?? import.meta.env.PROD;
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  const onKeyDown = (e: KeyboardEvent) => {
    const id = keyId(e);
    if (BLOCKED.has(id) || (blockReload && RELOAD.has(id))) e.preventDefault();
  };
  const onDrag = (e: DragEvent) => {
    if (!(e.target as Element | null)?.closest?.("[data-drop-target]")) e.preventDefault();
  };
  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("dragover", onDrag);
  window.addEventListener("drop", onDrag);
  return () => {
    window.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("dragover", onDrag);
    window.removeEventListener("drop", onDrag);
  };
}
