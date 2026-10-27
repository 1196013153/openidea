/** File › Remote Development…: state of the connect dialog and the folder browser helpers. */
import { create } from "zustand";
import type { RemoteEntry } from "@/platform/ipc";

export const useConnectDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openConnectDialog() {
  useConnectDialog.setState({ open: true });
}

export function closeConnectDialog() {
  useConnectDialog.setState({ open: false });
}

/** The parent of absolute POSIX path `path` (`/` stays `/`). */
export function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** The folders of a listing, sorted by name (hidden ones last). */
export function browsableFolders(entries: readonly RemoteEntry[]): RemoteEntry[] {
  const hidden = (e: RemoteEntry) => e.name.startsWith(".");
  return entries
    .filter((e) => e.isDir)
    .sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.name.localeCompare(b.name));
}

/** The directory a listing of `requested` stands for (`~` resolves on the server). */
export function listedDirectory(requested: string, entries: readonly RemoteEntry[]): string {
  if (requested.startsWith("/")) return requested.replace(/(.)\/+$/, "$1");
  const first = entries[0];
  return first ? remoteParent(first.path) : requested;
}
