/**
 * editor/core: the text editor (CodeMirror 6), document sync with the Rust
 * backend, tabs and splits, find/replace, navigation history and the editor
 * status bar widgets. See editor/api.ts for the extension contract.
 */
import {
  provideEditorArea,
  provideEditorService,
  registerOverlay,
  registerStatusItem,
} from "@/workbench/contributions";
import { _provideDocumentAttacher } from "@/editor/api";
import { editorController } from "./controller";
import { attachDocument } from "./model/attachment";
import { registerEditorActions } from "./actions";
import { installColorScheme } from "./colorSchemeRuntime";
import { EditorAreaView } from "./view/EditorArea";
import { GotoLineDialog } from "./view/GotoLineDialog";
import { NavBarPopup } from "./view/NavBarPopup";
import { installClipboardTracking } from "./clipboardHistory";
import {
  Breadcrumbs,
  CaretStatus,
  EncodingStatus,
  IndentStatus,
  LineEndingStatus,
  ReadOnlyStatus,
} from "./view/StatusItems";

export function activate(): void | (() => void) {
  const ctrl = editorController();
  ctrl.start();
  provideEditorService({
    openFile: (path, options) => ctrl.openFile(path, options),
    openInput: (input, options) => ctrl.openInput(input, options),
    activePath: () => ctrl.activePath(),
    activeCursor: () => ctrl.activeCursor(),
    saveAll: () => ctrl.saveAll(),
    focus: () => ctrl.focus(),
  });
  _provideDocumentAttacher((path) => attachDocument(ctrl.manager, path));
  const disposers = [
    installColorScheme(),
    provideEditorArea(EditorAreaView),
    registerEditorActions(),
    registerOverlay({ id: "editor.gotoLine", component: GotoLineDialog }),
    registerOverlay({ id: "editor.navigationBar", component: NavBarPopup }),
    installClipboardTracking(),
    registerStatusItem({
      id: "editor.breadcrumbs",
      align: "left",
      priority: 0,
      component: Breadcrumbs,
      title: "Navigation Bar",
    }),
    registerStatusItem({
      id: "editor.caret",
      align: "right",
      priority: 20,
      component: CaretStatus,
      title: "Line:Column Number",
    }),
    registerStatusItem({
      id: "editor.lineEnding",
      align: "right",
      priority: 30,
      component: LineEndingStatus,
      title: "Line Separator",
    }),
    registerStatusItem({
      id: "editor.encoding",
      align: "right",
      priority: 40,
      component: EncodingStatus,
      title: "File Encoding",
    }),
    registerStatusItem({
      id: "editor.indent",
      align: "right",
      priority: 50,
      component: IndentStatus,
      title: "Indentation",
    }),
    registerStatusItem({
      id: "editor.readOnly",
      align: "right",
      priority: 55,
      component: ReadOnlyStatus,
      title: "Read-only Attribute",
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    _provideDocumentAttacher(null);
    ctrl.stop();
  };
}
