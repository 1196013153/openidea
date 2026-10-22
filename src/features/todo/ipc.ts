import { commands } from "@/platform/ipc";
import type { RequestId } from "@/platform/ipc";

export { call, commands, isTauri, nextRequestId, onIdeEvent } from "@/platform/ipc";

export function cancelRequestSafe(id: RequestId) {
  try {
    void commands.cancelRequest(id).catch(() => {});
  } catch {
    // not running under Tauri
  }
}
