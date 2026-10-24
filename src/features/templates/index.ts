/**
 * Live templates (⌘J, Tab expansion, Surround With ⌥⌘T), postfix completion
 * (`expr.if` …), Emmet (Tab expansion, Update Tag with Emmet) and file
 * templates ("New ▸ …").
 */
import { lazyComponent } from "@/ui";
import { registerAction, registerActions, type Action } from "@/platform/actions";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { notifications, registerMenuGroup, registerOverlay, registerSettingsPage } from "@/workbench/contributions";
import { insertLiveTemplate, surroundTarget, surroundWith, templateEditorExtension } from "./editor";
import { ChooserHost } from "./popup/Chooser";
import { NewFileDialogHost, openNewFileDialog } from "./files/NewFileDialog";
import { defaultDirectory } from "./files/create";
import { fileTemplates, useFileTemplates } from "./files/store";
import type { FileTemplate } from "./files/model";
import { syncTemplatesFromStorage } from "./sync";
import { tagAtCaret, updateTag } from "./emmet/editor";
import { promptAbbreviation, UpdateTagDialogHost } from "./emmet/UpdateTagDialog";

export { EXTRA_COMPLETION_KEY } from "./editor";

const EDITOR_WHEN = "textEditorActive && !editorReadOnly && (editorFocus || popupOpen || !toolWindowFocus)";
const MARKUP_PATH = /\.(html?|xhtml|shtml|vue|svelte|xml)$/i;

async function updateTagWithEmmet() {
  const editor = activeEditor();
  if (!editor) return;
  const tag = tagAtCaret(editor.view);
  if (!tag) {
    notifications().notify({ level: "info", title: "No tag at the caret", key: "emmet-update-tag" });
    return;
  }
  const abbreviation = await promptAbbreviation(tag);
  editor.view.focus();
  if (abbreviation && !updateTag(editor.view, abbreviation))
    notifications().notify({
      level: "warning",
      title: "Cannot update the tag",
      body: `'${abbreviation}' does not describe a single element.`,
      key: "emmet-update-tag",
    });
}

interface NewFileArg {
  directory?: string;
  templateId?: string;
  /** Without `templateId`: the template for this file extension (one with `kindId` preferred). */
  extension?: string;
  name?: string;
  kindId?: string;
}

function templateForExtension(extension: string | undefined, kindId: string | undefined): string | undefined {
  if (!extension) return undefined;
  const matching = fileTemplates().filter((t) => t.enabled !== false && t.extension === extension);
  return (matching.find((t) => t.kinds.some((k) => k.id === kindId)) ?? matching[0])?.id;
}

function directoryOf(arg: unknown): string | null {
  const a = (arg ?? {}) as NewFileArg;
  return a.directory ?? defaultDirectory();
}

function newFileAction(t: FileTemplate): Action {
  return {
    id: `templates.new.${t.id}`,
    title: t.id === "file" ? "New Empty File…" : `New ${t.name}…`,
    category: "File",
    icon: t.icon,
    when: "projectOpen",
    keywords: ["new", "create", "template", t.extension].filter(Boolean),
    run: ({ arg }) => {
      const directory = directoryOf(arg);
      if (directory) openNewFileDialog({ directory, templateId: t.id });
    },
  };
}

function registerFileTemplateActions(): () => void {
  let disposers: Array<() => void> = [];
  const sync = (templates: FileTemplate[]) => {
    disposers.forEach((d) => d());
    disposers = templates.filter((t) => t.enabled !== false).map((t) => registerAction(newFileAction(t)));
  };
  sync(useFileTemplates.getState().templates);
  const unsub = useFileTemplates.subscribe((s, prev) => {
    if (s.templates !== prev.templates) sync(s.templates);
  });
  return () => {
    unsub();
    disposers.forEach((d) => d());
  };
}

/** Live / postfix / file template pages (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  const disposers = [
    registerSettingsPage({
      id: "editor.liveTemplates",
      title: "Live Templates",
      group: "Editor",
      order: 28,
      keywords: ["snippet", "abbreviation", "surround", "template"],
      component: lazyComponent(() => import("./settings/LiveTemplatesPage").then((m) => m.LiveTemplatesPage)),
    }),
    registerSettingsPage({
      // IDEA: Editor › General › Postfix Completion.
      id: "editor.general.postfixCompletion",
      title: "Postfix Completion",
      group: "Editor",
      order: 7,
      keywords: ["postfix", "template", ".if", ".var", ".for"],
      component: lazyComponent(() => import("./settings/PostfixPage").then((m) => m.PostfixPage)),
    }),
    registerSettingsPage({
      id: "editor.fileTemplates",
      title: "File and Code Templates",
      group: "Editor",
      order: 26,
      keywords: ["new file", "class", "template", "package"],
      component: lazyComponent(() => import("./settings/FileTemplatesPage").then((m) => m.FileTemplatesPage)),
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  const disposers = [
    registerEditorContribution({ id: "templates", order: 90, extensions: templateEditorExtension }),
    registerOverlay({ id: "templates.chooser", component: ChooserHost }),
    registerOverlay({ id: "templates.newFile", component: NewFileDialogHost }),
    registerOverlay({ id: "templates.emmetUpdateTag", component: UpdateTagDialogHost }),
    registerMenuGroup({
      id: "templates.emmet",
      menus: ["editor"],
      order: 60,
      items: (_menu, { paths: [path] }) =>
        path && MARKUP_PATH.test(path) ? [{ kind: "action", action: "emmet.updateTag" }] : [],
    }),
    registerActions([
      {
        id: "code.insertLiveTemplate",
        title: "Insert Live Template…",
        category: "Code",
        when: EDITOR_WHEN,
        keywords: ["snippet", "template", "abbreviation"],
        run: () => {
          const view = activeEditor()?.view;
          if (view) insertLiveTemplate(view);
        },
      },
      {
        id: "code.surroundWith",
        title: "Surround With…",
        category: "Code",
        when: EDITOR_WHEN,
        keywords: ["wrap", "if", "try", "region"],
        run: async () => {
          const editor = activeEditor();
          if (!editor) return;
          const target = await surroundTarget(editor.view, editor.ctx);
          if (activeEditor()?.view === editor.view) surroundWith(editor.view, target);
        },
      },
      {
        id: "emmet.updateTag",
        title: "Update Tag with Emmet",
        category: "Code",
        when: `${EDITOR_WHEN} && (editorLangId == html || editorLangId == vue || editorLangId == svelte || editorLangId == xml)`,
        keywords: ["emmet", "tag", "rename", "class", "attribute"],
        run: updateTagWithEmmet,
      },
      {
        id: "templates.newFromTemplate",
        title: "New from Template…",
        category: "File",
        icon: "plus",
        when: "projectOpen",
        keywords: ["new", "file", "create", "class"],
        run: ({ arg }) => {
          const directory = directoryOf(arg);
          if (!directory) return;
          const a = (arg ?? {}) as NewFileArg;
          openNewFileDialog({ directory, templateId: a.templateId ?? templateForExtension(a.extension, a.kindId), name: a.name, kindId: a.kindId });
        },
      },
    ]),
    registerFileTemplateActions(),
    activateSettingsPages(),
    syncTemplatesFromStorage(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
