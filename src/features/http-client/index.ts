/**
 * HTTP Client (IDEA's `.http` / `.rest` files): highlighting, ▶ gutter per
 * request, environments, Run All, and a tool window with the responses and
 * their history. Parsing, variable resolution and sending happen in Rust
 * (`ide-http`).
 */
import { activeEditor, registerEditorContribution, registerLanguageMode } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { call, commands, emitLocalIdeEvent, IpcError, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { editorService, notifications, registerServiceView, showServiceView } from "@/workbench/contributions";
import { HTTP_LANGUAGE, httpEditorExtension, refreshRequests, requestAtCaret } from "./editor";
import { HttpClientHeaderActions, HttpClientView } from "./HttpClientView";
import { httpLanguageDescription } from "./language";
import { SERVICE_VIEW, resetHttpClient, runAll, runRequest } from "./store";

export const NEW_REQUEST_TEMPLATE = `### Example request
# Variables come from http-client.env.json / http-client.private.env.json
# next to this file or in the project root: {{host}}
GET https://example.com/
Accept: application/json

###
`;

function activeHttpEditor() {
  const e = activeEditor();
  return e && e.ctx.language === HTTP_LANGUAGE ? e : null;
}

function filePath(path: string, virtual?: boolean): string | null {
  return virtual ? null : path;
}

async function runAtCaret() {
  const e = activeHttpEditor();
  if (!e) return;
  await refreshRequests(e.view);
  const r = requestAtCaret(e.view);
  if (!r) {
    notifications().notify({ level: "info", title: "No HTTP request at the caret", key: "http-run" });
    return;
  }
  await runRequest(filePath(e.ctx.path, e.ctx.virtual), e.view.state.doc.toString(), r.index);
}

/** New HTTP Request: a scratch `requests[_n].http` with an example request. */
async function newRequest() {
  try {
    const { appDataDir } = await import("@tauri-apps/api/path");
    const dir = `${(await appDataDir()).replace(/\/+$/, "")}/scratches`;
    try {
      await call(commands.fsCreateDir(dir));
    } catch (e) {
      if (!(e instanceof IpcError && e.kind === "alreadyExists")) throw e;
    }
    const names = new Set((await call(commands.fsReadDir(dir))).map((e) => e.name.toLowerCase()));
    let name = "requests.http";
    for (let i = 1; names.has(name); i++) name = `requests_${i}.http`;
    const path = `${dir}/${name}`;
    await call(commands.fsCreateFile(path));
    emitLocalIdeEvent({ type: "fsChanged", created: [path], modified: [], removed: [] });
    await editorService().openFile(path, { focus: true });
    const e = activeEditor();
    if (e?.ctx.path === path) e.view.dispatch({ changes: { from: 0, insert: NEW_REQUEST_TEMPLATE } });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot create the HTTP request file",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export function activate(): () => void {
  const disposers = [
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetHttpClient();
    }),
    registerLanguageMode(httpLanguageDescription),
    registerEditorContribution({ id: "http.requests", order: 56, extensions: httpEditorExtension }),
    registerServiceView({
      id: SERVICE_VIEW,
      title: "HTTP Client",
      icon: "file-http",
      order: 10,
      onUse: true,
      component: HttpClientView,
      headerActions: HttpClientHeaderActions,
    }),
    registerActions([
      {
        id: "http.runRequest",
        title: "Run HTTP Request at Caret",
        category: "Tools",
        icon: "run",
        when: "editorTextFocus && editorLangId == http",
        run: () => runAtCaret(),
      },
      {
        id: "http.runAll",
        title: "Run All HTTP Requests in File",
        category: "Tools",
        icon: "gutter-run-all",
        when: "editorLangId == http",
        run: async () => {
          const e = activeHttpEditor();
          if (e) await runAll(filePath(e.ctx.path, e.ctx.virtual), e.view.state.doc.toString());
        },
      },
      {
        id: "http.newRequest",
        title: "New HTTP Request",
        category: "Tools",
        icon: "file-http",
        keywords: ["http client", "rest", "scratch", "curl"],
        when: "projectOpen",
        run: () => (isTauri() ? newRequest() : undefined),
      },
      {
        id: "http.showToolWindow",
        title: "HTTP Client",
        category: "Tools",
        icon: "file-http",
        keywords: ["responses", "http history"],
        when: "projectOpen",
        run: () => showServiceView(SERVICE_VIEW, true),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
