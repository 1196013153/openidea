/**
 * Maven and Gradle tool windows (right stripe), registered only while the open
 * project has that build system, like IDEA. The model is re-read when build
 * files change; running goals / tasks goes through the run feature's actions.
 */
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { onIdeEvent, type BuildModel, type BuildTool } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerOverlay, registerRunAnythingProvider, registerToolWindow } from "@/workbench/contributions";
import { GradleView, MavenView } from "./BuildToolView";
import { ExecutePopupHost } from "./ExecutePopup";
import { buildToolsRunAnything } from "./runAnything";
import { expandableKeys, gradleChildren, gradleRoots, mavenChildren, mavenRoots } from "./model";
import {
  cancelSync,
  loadModel,
  resetBuild,
  setExpanded,
  syncTool,
  toggleGradleOffline,
  toggleMavenOffline,
  toggleSkipTests,
  useBuild,
} from "./store";

export const MAVEN_WHEN = "projectOpen && build.maven";
export const GRADLE_WHEN = "projectOpen && build.gradle";

/** Build files whose creation / change / removal re-reads the model. */
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|mvnw(?:\.cmd)?|gradlew(?:\.bat)?)$/;

function expandAll(tool: BuildTool) {
  const { model, configs } = useBuild.getState();
  if (tool === "maven" && model?.maven) {
    const m = model.maven;
    setExpanded(tool, expandableKeys(mavenRoots(m), (n) => mavenChildren(n, m, configs)));
  } else if (tool === "gradle" && model?.gradle) {
    const g = model.gradle;
    setExpanded(tool, expandableKeys(gradleRoots(g), (n) => gradleChildren(n, g, configs)));
  }
}

function openExecute(tool: BuildTool) {
  useBuild.setState({ executeOpen: tool });
}

const synced = new Set<string>();

/** Registers / unregisters the tool windows to match the model; first sync of a never-synced build. */
function apply(model: BuildModel | null, registered: Partial<Record<BuildTool, () => void>>) {
  const has: Record<BuildTool, boolean> = { maven: !!model?.maven, gradle: !!model?.gradle };
  setContext("build.maven", has.maven);
  setContext("build.gradle", has.gradle);
  for (const tool of ["maven", "gradle"] as const) {
    if (has[tool] && !registered[tool]) {
      registered[tool] =
        tool === "maven"
          ? registerToolWindow({ id: "maven", title: "Maven", icon: "toolwindow-maven", anchor: "right", order: 10, component: MavenView })
          : registerToolWindow({ id: "gradle", title: "Gradle", icon: "toolwindow-gradle", anchor: "right", order: 11, component: GradleView });
    } else if (!has[tool] && registered[tool]) {
      registered[tool]!();
      delete registered[tool];
    }
  }
  // IDEA imports a build when the project is first opened.
  const root = useBuild.getState().root;
  for (const tool of ["maven", "gradle"] as const) {
    const info = tool === "maven" ? model?.maven : model?.gradle;
    const key = `${tool}:${root}`;
    if (info && info.syncedAt == null && !synced.has(key)) {
      synced.add(key);
      void syncTool(tool);
    }
  }
}

export function activate(): () => void {
  const registered: Partial<Record<BuildTool, () => void>> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLoad = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadModel(), 300);
  };
  const disposers: Array<() => void> = [
    registerOverlay({ id: "build-tools.execute", component: ExecutePopupHost }),
    registerRunAnythingProvider(buildToolsRunAnything),
    useBuild.subscribe((s, prev) => {
      if (s.model !== prev.model || s.root !== prev.root) apply(s.root ? s.model : null, registered);
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      resetBuild();
      if (s.project) void loadModel();
    }),
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some((p) => BUILD_FILE.test(p))) scheduleLoad();
    }),
    onIdeEvent("projectRootsChanged", scheduleLoad),
    // Project JDK / Maven home and options are applied to the model's launchers.
    onIdeEvent("settingsChanged", (e) => {
      if (e.key === "languages" || e.key.startsWith("languages.java")) scheduleLoad();
    }),
    registerActions([
      {
        id: "maven.reload",
        title: "Reload All Maven Projects",
        description: "Re-reads the effective POMs and dependency trees with Maven",
        category: "Maven",
        icon: "refresh",
        when: MAVEN_WHEN,
        keywords: ["maven", "sync", "reimport", "refresh"],
        run: () => syncTool("maven"),
      },
      {
        id: "maven.cancelReload",
        title: "Stop Reloading Maven Projects",
        category: "Maven",
        icon: "stop",
        hidden: true,
        when: MAVEN_WHEN,
        run: () => cancelSync("maven"),
      },
      {
        id: "maven.executeGoal",
        title: "Execute Maven Goal…",
        category: "Maven",
        icon: "run-anything",
        when: MAVEN_WHEN,
        keywords: ["maven", "mvn", "goal", "run anything"],
        run: () => openExecute("maven"),
      },
      {
        id: "maven.toggleOffline",
        title: "Toggle Offline Mode",
        description: "Runs Maven with -o",
        category: "Maven",
        icon: "build-offline",
        when: MAVEN_WHEN,
        keywords: ["maven", "offline"],
        toggled: () => useBuild.getState().settings.maven.offline,
        run: () => toggleMavenOffline(),
      },
      {
        id: "maven.toggleSkipTests",
        title: "Toggle 'Skip Tests' Mode",
        description: "Runs Maven with -DskipTests",
        category: "Maven",
        icon: "skip-tests",
        when: MAVEN_WHEN,
        keywords: ["maven", "skip tests"],
        toggled: () => useBuild.getState().settings.maven.skipTests,
        run: () => toggleSkipTests(),
      },
      {
        id: "maven.expandAll",
        title: "Expand All",
        category: "Maven",
        icon: "expand-all",
        hidden: true,
        when: MAVEN_WHEN,
        run: () => expandAll("maven"),
      },
      {
        id: "maven.collapseAll",
        title: "Collapse All",
        category: "Maven",
        icon: "collapse-all",
        hidden: true,
        when: MAVEN_WHEN,
        run: () => setExpanded("maven", new Set()),
      },
      {
        id: "gradle.reload",
        title: "Reload All Gradle Projects",
        description: "Re-reads the task list with Gradle",
        category: "Gradle",
        icon: "refresh",
        when: GRADLE_WHEN,
        keywords: ["gradle", "sync", "refresh"],
        run: () => syncTool("gradle"),
      },
      {
        id: "gradle.cancelReload",
        title: "Stop Reloading Gradle Projects",
        category: "Gradle",
        icon: "stop",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => cancelSync("gradle"),
      },
      {
        id: "gradle.executeTask",
        title: "Execute Gradle Task…",
        category: "Gradle",
        icon: "run-anything",
        when: GRADLE_WHEN,
        keywords: ["gradle", "task", "run anything"],
        run: () => openExecute("gradle"),
      },
      {
        id: "gradle.toggleOffline",
        title: "Toggle Offline Mode",
        description: "Runs Gradle with --offline",
        category: "Gradle",
        icon: "build-offline",
        when: GRADLE_WHEN,
        keywords: ["gradle", "offline"],
        toggled: () => useBuild.getState().settings.gradle.offline,
        run: () => toggleGradleOffline(),
      },
      {
        id: "gradle.expandAll",
        title: "Expand All",
        category: "Gradle",
        icon: "expand-all",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => expandAll("gradle"),
      },
      {
        id: "gradle.collapseAll",
        title: "Collapse All",
        category: "Gradle",
        icon: "collapse-all",
        hidden: true,
        when: GRADLE_WHEN,
        run: () => setExpanded("gradle", new Set()),
      },
    ]),
  ];
  if (useProject.getState().project) void loadModel();
  return () => {
    clearTimeout(timer);
    disposers.reverse().forEach((d) => d());
    for (const d of Object.values(registered)) d?.();
    setContext("build.maven", false);
    setContext("build.gradle", false);
    resetBuild();
  };
}
