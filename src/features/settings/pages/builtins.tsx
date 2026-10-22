/** Built-in settings pages (IDEA layout: Appearance & Behavior, Keymap, Editor). */
import { GlobListEditor, Row } from "../components/Form";
import { useSetting } from "../components/context";
import { KeymapPage, keymapSearchLabels } from "../keymap/KeymapPage";
import type { PageSpec } from "./spec";

export { APPEARANCE_GROUP } from "./behavior";
export const EDITOR_GROUP = "Editor";

function ExcludeRow() {
  const [exclude, setExclude] = useSetting<string[]>("files.exclude");
  return (
    <Row
      label="Exclude patterns"
      stacked
      hint="Glob patterns (e.g. **/dist, *.log) hidden from the project tree and skipped by search and indexing."
    >
      <GlobListEditor value={exclude} onChange={setExclude} aria-label="Exclude patterns" />
    </Row>
  );
}

export const BUILTIN_PAGES: PageSpec[] = [
  {
    id: "keymap",
    title: "Keymap",
    order: 10,
    keywords: ["shortcut", "keyboard", "hotkey", "binding", "preset", "vs code", "intellij"],
    component: KeymapPage,
    dynamicLabels: keymapSearchLabels,
  },
  {
    id: "editor.files",
    title: "File Types",
    group: EDITOR_GROUP,
    order: 29,
    projectScope: true,
    keywords: ["ignore", "ignored", "excluded", "glob", "exclude patterns"],
    sections: [
      {
        title: "Ignored Files and Folders",
        options: [{ kind: "custom", label: "Exclude patterns", component: ExcludeRow }],
      },
    ],
  },
];
