/**
 * Desktop shell integration: native menu bridge, multi-window, window title,
 * close / quit guards, About, Keymap Reference, logs, update check and i18n wiring.
 */
import { registerOverlay } from "@/workbench/contributions";
import { AboutOverlay } from "./AboutDialog";
import { appActions, updateActions } from "./appActions";
import { installCloseGuard } from "./closeGuard";
import { InvalidateCachesOverlay, registerInvalidateCachesActions } from "./InvalidateCaches";
import { buildInfo } from "./host";
import { KeymapReferenceOverlay } from "./KeymapReference";
import { installLocaleSync, registerLocalizedActions } from "./locale";
import { installMenuBridge } from "./menuBridge";
import { PromptOverlay } from "./prompt";
import { installWindowTitle } from "./title";
import { installLaunchHandling, windowActions } from "./windows";

/** The UI locale of a secondary (Settings) window. */
export const activateLocale = installLocaleSync;

export function activate(): () => void {
  const disposers = [
    installLocaleSync(),
    registerLocalizedActions(() => [...appActions(), ...windowActions()]),
    registerOverlay({ id: "app.about", component: AboutOverlay }),
    registerOverlay({ id: "app.keymapReference", component: KeymapReferenceOverlay }),
    registerOverlay({ id: "app.prompt", component: PromptOverlay }),
    registerOverlay({ id: "app.invalidateCaches", component: InvalidateCachesOverlay }),
    registerInvalidateCachesActions(),
    installMenuBridge(),
    installWindowTitle(),
    installCloseGuard(),
    installLaunchHandling(),
  ];
  let disposed = false;
  void buildInfo().then((b) => {
    if (b?.updates && !disposed) disposers.push(registerLocalizedActions(updateActions));
  });
  return () => {
    disposed = true;
    disposers.reverse().forEach((d) => d());
  };
}
