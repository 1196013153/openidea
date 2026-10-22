/**
 * Live templates (⌘J, Tab expansion, Surround With ⌥⌘T), postfix completion
 * (`expr.if` …) and file templates ("New ▸ …").
 */
import { lazyComponent } from "@/ui";
import { registerAction, registerActions, type Action } from "@/platform/actions";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { registerOverlay, registerSettingsPage } from "@/workbench/contributions";
import { insertLiveTemplate, surroundTarget, surroundWith, templateEditorExtension } from "./editor";
import { ChooserHost } from "./popup/Chooser";
import { NewFileDialogHost, openNewFileDialog } from "./files/NewFileDialog";
import { defaultDirectory } from "./files/create";
import { fileTemplates, useFileTemplates } from "./files/store";
import type { FileTemplate } from "./files/model";
import { syncTemplatesFromStorage } from "./sync";

export { EXTRA_COMPLETION_KEY } from "./editor";

const EDITOR_WHEN = "textEditorActive && !editorReadOnly && (editorFocus || popupOpen || !toolWindowFocus)";

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
