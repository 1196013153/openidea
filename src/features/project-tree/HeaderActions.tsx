import { shortcutLabel } from "@/platform/keymap";
import { IconButton, type MenuItem } from "@/ui";
import { setViewOption, useProjectTree, type ViewOptions } from "./store";

export const OPTION_LABELS: Array<[keyof ViewOptions, string]> = [
  ["showHidden", "Show Hidden Files"],
  ["showExcluded", "Show Excluded Files"],
  ["compact", "Compact Middle Packages"],
  ["foldersFirst", "Sort Folders First"],
  ["autoscrollToSource", "Autoscroll to Source"],
  ["autoscrollFromSource", "Autoscroll from Source"],
  ["singleClickOpen", "Open Files with Single Click"],
  ["previewTab", "Enable Preview Tab"],
];

/** Header controls of the Project tool window (IDEA: Locate, Expand/Collapse All). */
export function ProjectHeaderActions() {
  return (
    <>
      <IconButton
        icon="locate"
        action="navigate.selectIn"
        title="Select Opened File"
        shortcut={shortcutLabel("navigate.selectIn")}
        size="small"
      />
      <IconButton icon="expand-all" action="project.expandAll" title="Expand All" size="small" />
      <IconButton icon="collapse-all" action="project.collapseAll" title="Collapse All" size="small" />
    </>
  );
}

/** View options in the header's "⋮" menu (IDEA: Project › Options › Appearance / Behavior). */
export function useProjectHeaderMenu(): MenuItem[] {
  const options = useProjectTree((s) => s.options);
  return [
    { kind: "header", label: "Appearance" },
    ...OPTION_LABELS.slice(0, 4).map(([key, label]) => option(key, label, options)),
    { kind: "separator" },
    { kind: "header", label: "Behavior" },
    ...OPTION_LABELS.slice(4).map(([key, label]) => option(key, label, options)),
  ];
}

function option(key: keyof ViewOptions, label: string, options: ViewOptions): MenuItem {
  return { id: key, label, checked: options[key], run: () => setViewOption(key, !options[key]) };
}
