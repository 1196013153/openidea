/* global document, localStorage, window */
// Runs before the app's CSS loads: restores the last theme (theme.ts stores it)
// so a new window starts in it instead of flashing the light default.
// An external file because the CSP forbids inline scripts.
try {
  const last = JSON.parse(localStorage.getItem("openidea.theme") ?? "null");
  if (last?.theme) document.documentElement.dataset.theme = last.theme;
  if (last?.contrast) document.documentElement.dataset.contrast = last.contrast;
} catch {
  /* storage unavailable */
}
// Settings windows (`settings-<parent>`) load this page too: splash.css drops the logo for them.
if (window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label?.startsWith("settings-")) {
  document.documentElement.dataset.window = "settings";
}
