/** Applies Settings › Editor › Color Scheme (scheme + attribute overrides) as one stylesheet. */
import { useProject } from "@/platform/project";
import { editorPrefs } from "@/platform/editorSettings";
import { schemeCss } from "@/platform/colorScheme";

export function installColorScheme(): () => void {
  if (typeof document === "undefined") return () => {};
  const el = document.createElement("style");
  el.id = "openidea-editor-color-scheme";
  document.head.appendChild(el);
  const apply = () => {
    const settings = useProject.getState().settings;
    const css = schemeCss(settings?.editor?.colorScheme, editorPrefs(settings).colorOverrides);
    if (el.textContent !== css) el.textContent = css;
  };
  apply();
  const unsubscribe = useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings) apply();
  });
  const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(apply) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-contrast"] });
  return () => {
    unsubscribe();
    observer?.disconnect();
    el.remove();
  };
}
