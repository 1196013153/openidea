/**
 * Services tool window (⌘8) with Docker: containers grouped by Compose project,
 * images, volumes and networks, kept live by `docker events`; lifecycle, logs,
 * inspect, a shell in a terminal tab, pull and prune. Dockerfiles and Compose
 * files get gutter run icons that start run configurations.
 */
import { registerActions } from "@/platform/actions";
import { registerEditorContribution } from "@/editor/api";
import {
  SERVICES_WINDOW,
  registerOverlay,
  registerServiceView,
  registerToolWindow,
  showServiceView,
} from "@/workbench/contributions";
import { dockerGutter } from "./dockerGutter";
import { ServicesDialogHost } from "./dialogs";
import { canRemove, canStart, canStop, execShell, pullPrompt, prunePrompt, remove, restart, selected, showDetail, start, stop, DOCKER_VIEW } from "./ops";
import { ServicesView } from "./ServicesView";
import { ServicesHeaderActions, ServicesHost, ServicesTabs } from "./ServicesHost";
import { refresh } from "./store";
import { isRunning } from "./model";
import type { PruneTarget } from "@/platform/ipc";

const PROJECT = "projectOpen";

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: SERVICES_WINDOW,
      title: "Services",
      icon: "toolwindow-services",
      anchor: "bottom",
      order: 8,
      stripe: "onUse",
      component: ServicesHost,
      headerContent: ServicesTabs,
      headerActions: ServicesHeaderActions,
    }),
    registerServiceView({ id: DOCKER_VIEW, title: "Docker", icon: "file-docker", order: 0, component: ServicesView }),
    registerOverlay({ id: "services.dialogs", component: ServicesDialogHost }),
    registerEditorContribution({ id: "services.dockerGutter", order: 56, extensions: dockerGutter }),
    registerActions([
      {
        id: "services.show",
        title: "Services",
        category: "Docker",
        icon: "toolwindow-services",
        when: PROJECT,
        hidden: true,
        run: () => showServiceView(DOCKER_VIEW, true),
      },
      { id: "docker.refresh", title: "Refresh Docker", category: "Docker", icon: "refresh", when: PROJECT, run: () => refresh() },
      {
        id: "docker.start",
        title: "Start Container",
        category: "Docker",
        icon: "run",
        when: PROJECT,
        run: () => (canStart(selected()) ? start(selected()) : undefined),
      },
      {
        id: "docker.stop",
        title: "Stop Container",
        category: "Docker",
        icon: "stop",
        when: PROJECT,
        run: () => (canStop(selected()) ? stop(selected()) : undefined),
      },
      { id: "docker.restart", title: "Restart Container", category: "Docker", icon: "rerun", when: PROJECT, run: () => restart(selected()) },
      {
        id: "docker.remove",
        title: "Delete Docker Object…",
        category: "Docker",
        icon: "trash",
        when: PROJECT,
        run: () => (canRemove(selected()) ? remove(selected()) : undefined),
      },
      {
        id: "docker.showLog",
        title: "Show Container Log",
        category: "Docker",
        when: PROJECT,
        run: () => showDetail("log"),
      },
      { id: "docker.inspect", title: "Inspect Docker Object", category: "Docker", icon: "info", when: PROJECT, run: () => showDetail("inspect") },
      {
        id: "docker.execShell",
        title: "Create Terminal in Container",
        category: "Docker",
        icon: "terminal",
        keywords: ["exec", "shell", "attach"],
        when: PROJECT,
        run: () => {
          const n = selected();
          if (n?.kind === "container" && isRunning(n.container)) execShell(n);
        },
      },
      { id: "docker.pullImage", title: "Pull Docker Image…", category: "Docker", icon: "git-pull", when: PROJECT, run: () => pullPrompt() },
      {
        id: "docker.prune",
        title: "Prune Docker…",
        description: "Argument: `containers`, `images`, `allImages`, `volumes`, `networks` or `system` (default).",
        category: "Docker",
        icon: "trash",
        keywords: ["clean", "system prune"],
        when: PROJECT,
        run: ({ arg }) => prunePrompt(typeof arg === "string" ? (arg as PruneTarget) : "system"),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
