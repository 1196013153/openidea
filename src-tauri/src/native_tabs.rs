//! macOS native window tabs for project windows, like IDEA's "Merge All Project Windows".
//!
//! Project windows share one tabbing identifier, so Window › Merge All Windows and the
//! system "Prefer tabs" setting group them; with `general.openProjectInTab` a new
//! project window joins the tab group of the window it was opened from.
//!
//! The page draws its own title bar under the transparent native one. With the tab bar
//! shown, the native title bar row and tab bar cover the top of the page with their own
//! material: their height is polled and sent to each window ([`TAB_BAR_EVENT`]), which
//! then starts its title bar below them.

use tauri::{AppHandle, WebviewWindow};

/// Tabbing identifier of project windows (settings windows get their own).
pub const PROJECT_TABBING_ID: &str = "ai.l0ng.openidea.project";
pub const SETTINGS_TABBING_ID: &str = "ai.l0ng.openidea.settings";
/// Height of the native chrome (title bar row + tab bar) in logical px, sent when it changes.
pub const TAB_BAR_EVENT: &str = "openidea://native-tab-bar";

#[cfg(target_os = "macos")]
mod mac {
    use super::TAB_BAR_EVENT;
    use crate::windows::project_window_labels;
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

    const POLL: Duration = Duration::from_millis(250);

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        // SAFETY: Tauri hands out the window's live NSWindow; it is used on the main thread
        // while `window` is borrowed.
        window.ns_window().ok().and_then(|p| unsafe { p.cast::<NSWindow>().as_ref() })
    }

    /// Height of the native chrome over the page while the tab bar is shown: title bar
    /// row (traffic lights) plus tab bar, drawn with their own material. 0 without tabs.
    /// Main thread only.
    pub fn tab_bar_height(window: &WebviewWindow) -> f64 {
        let Some(ns) = ns_window(window) else { return 0.0 };
        if !ns.tabGroup().is_some_and(|g| g.isTabBarVisible()) {
            return 0.0;
        }
        let Some(content) = ns.contentView() else { return 0.0 };
        // Full-size content view: everything above the layout rect is native chrome.
        (content.frame().size.height - ns.contentLayoutRect().size.height).max(0.0).round()
    }

    /// Adds `window` as a tab of `anchor`'s tab group and selects it.
    pub fn join_tab_group(app: &AppHandle, anchor: &str, window: &str) {
        let (app, anchor, window) = (app.clone(), anchor.to_owned(), window.to_owned());
        let handle = app.clone();
        let _ = handle.run_on_main_thread(move || {
            let (Some(a), Some(w)) = (app.get_webview_window(&anchor), app.get_webview_window(&window)) else {
                return;
            };
            if let (Some(a_ns), Some(w_ns)) = (ns_window(&a), ns_window(&w)) {
                a_ns.addTabbedWindow_ordered(w_ns, NSWindowOrderingMode::Above);
                w_ns.makeKeyAndOrderFront(None);
            }
        });
    }

    /// Polls the tab bar of every project window and tells a window when its height changes.
    pub fn watch(app: &AppHandle) {
        let app = app.clone();
        std::thread::Builder::new()
            .name("native-tab-bar".into())
            .spawn(move || {
                let last: std::sync::Arc<Mutex<HashMap<String, f64>>> = Default::default();
                loop {
                    std::thread::sleep(POLL);
                    let (app2, last) = (app.clone(), last.clone());
                    let _ = app.run_on_main_thread(move || {
                        let mut last = last.lock();
                        let labels = project_window_labels(&app2);
                        last.retain(|l, _| labels.contains(l));
                        for label in labels {
                            let Some(w) = app2.get_webview_window(&label) else { continue };
                            let h = tab_bar_height(&w);
                            if last.get(&label).copied().unwrap_or(0.0) != h {
                                last.insert(label.clone(), h);
                                let _ = app2.emit_to(label.as_str(), TAB_BAR_EVENT, h);
                            }
                        }
                    });
                }
            })
            .expect("spawn native-tab-bar thread");
    }
}

/// Starts reporting native tab bar heights to project windows (macOS).
pub fn watch(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::watch(_app);
}

/// Makes `window` a tab of `anchor` (macOS; no-op elsewhere).
pub fn join_tab_group(_app: &AppHandle, _anchor: &WebviewWindow, _window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    mac::join_tab_group(_app, _anchor.label(), _window.label());
}

/// Current native tab bar height of `window` (0 without one, or off macOS).
pub async fn tab_bar_height(_app: &AppHandle, _window: &WebviewWindow) -> f64 {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let w = _window.clone();
        if _app
            .run_on_main_thread(move || {
                let _ = tx.send(mac::tab_bar_height(&w));
            })
            .is_ok()
        {
            return rx.await.unwrap_or(0.0);
        }
    }
    0.0
}
