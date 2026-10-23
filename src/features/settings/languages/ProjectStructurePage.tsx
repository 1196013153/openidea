/**
 * Settings › Project Structure (IDEA's module "Sources" tab): the content
 * root's Sources / Tests / Resources / Test Resources / Excluded folders.
 * Roots detected from build files (`pom.xml`, `build.gradle`, `Cargo.toml`,
 * `go.mod`, `pyproject.toml`, `package.json`) apply until the user marks or
 * unmarks the folder (`projectStructure.*`, project scope). Roots drive the
 * project tree icons, package inference for new classes, the "Project
 * Production / Test Files" scopes, and Excluded folders are skipped by the
 * tree, Find in Files and indexing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Icon, IconButton, Tree, folderIconName, type FolderKind, T } from "@/ui";
import { call, commands, isTauri, type FileEntry } from "@/platform/ipc";
import { relativePath, useProject } from "@/platform/project";
import {
  PROJECT_STRUCTURE_KEYS,
  effectiveRoots,
  markFolder,
  restoreDetected,
  rootRole,
  unmarkedRoots,
  type FolderRole,
  type ProjectStructureValid,
} from "@/platform/languageSettings";
import { initProjectRoots, useDetectedRoots } from "@/platform/projectRoots";
import { useProjectSetting } from "./components";
import styles from "./Sdk.module.css";

interface DirNode {
  path: string;
  name: string;
  rel: string;
}

const ROLES: Array<{ role: FolderRole; label: string; title: string; kind: FolderKind; cls: string }> = [
  { role: "source", label: "Sources", title: "Source Folders", kind: "source", cls: styles.sourceTitle! },
  { role: "test", label: "Tests", title: "Test Source Folders", kind: "test", cls: styles.testTitle! },
  { role: "resources", label: "Resources", title: "Resource Folders", kind: "resources", cls: styles.resourcesTitle! },
  {
    role: "testResources",
    label: "Test Resources",
    title: "Test Resource Folders",
    kind: "testResources",
    cls: styles.testResourcesTitle!,
  },
  { role: "excluded", label: "Excluded", title: "Excluded Folders", kind: "excluded", cls: styles.excludedTitle! },
];

async function readDirs(root: string, path: string): Promise<DirNode[]> {
  if (!isTauri()) return [];
  const entries: FileEntry[] = await call(commands.fsReadDir(path));
  return entries
    .filter((e) => e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir"))
    .filter((e) => e.name !== ".git")
    .map((e) => ({ path: e.path, name: e.name, rel: relativePath(root, e.path) }));
}

function useStructure(): [ProjectStructureValid, (next: ProjectStructureValid) => void] {
  const [sourceRoots, setSource] = useProjectSetting<string[] | undefined>("projectStructure.sourceRoots");
  const [testRoots, setTest] = useProjectSetting<string[] | undefined>("projectStructure.testRoots");
  const [resourceRoots, setResources] = useProjectSetting<string[] | undefined>("projectStructure.resourceRoots");
  const [testResourceRoots, setTestResources] = useProjectSetting<string[] | undefined>(
    "projectStructure.testResourceRoots",
  );
  const [excluded, setExcluded] = useProjectSetting<string[] | undefined>("projectStructure.excluded");
  const [unmarked, setUnmarked] = useProjectSetting<string[] | undefined>("projectStructure.unmarked");
  const ps = useMemo<ProjectStructureValid>(
    () => ({
      sourceRoots: sourceRoots ?? [],
      testRoots: testRoots ?? [],
      resourceRoots: resourceRoots ?? [],
      testResourceRoots: testResourceRoots ?? [],
      excluded: excluded ?? [],
      unmarked: unmarked ?? [],
    }),
    [sourceRoots, testRoots, resourceRoots, testResourceRoots, excluded, unmarked],
  );
  const set = useCallback(
    (next: ProjectStructureValid) => {
      const setters: Record<keyof ProjectStructureValid, (v: string[]) => void> = {
        sourceRoots: setSource,
        testRoots: setTest,
        resourceRoots: setResources,
        testResourceRoots: setTestResources,
        excluded: setExcluded,
        unmarked: setUnmarked,
      };
      for (const k of PROJECT_STRUCTURE_KEYS)
        if (JSON.stringify(next[k]) !== JSON.stringify(ps[k])) setters[k](next[k]);
    },
    [ps, setSource, setTest, setResources, setTestResources, setExcluded, setUnmarked],
  );
  return [ps, set];
}

export function ProjectStructurePage() {
  const root = useProject((s) => s.project?.root ?? null);
  const name = useProject((s) => s.project?.name ?? "");
  const [ps, setPs] = useStructure();
  const detected = useDetectedRoots();
  const roots = useMemo(() => effectiveRoots(detected, ps), [detected, ps]);
  useEffect(() => initProjectRoots(), []);
  const [children, setChildren] = useState<Map<string, DirNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root ? [root] : []));
  const [selected, setSelected] = useState<DirNode | null>(null);

  const load = useCallback(
    async (node: DirNode) => {
      if (!root) return;
      const dirs = await readDirs(root, node.path);
      setChildren((m) => new Map(m).set(node.path, dirs));
    },
    [root],
  );

  const rootNode = useMemo<DirNode | null>(() => (root ? { path: root, name, rel: "" } : null), [root, name]);
  useEffect(() => {
    if (!root) return;
    let live = true;
    void readDirs(root, root).then((dirs) => live && setChildren((m) => new Map(m).set(root, dirs)));
    return () => {
      live = false;
    };
  }, [root]);

  if (!rootNode)
    return (
      <div className={styles.note}>
        <T>Open a project to configure its folders.</T>
      </div>
    );

  const role = selected ? rootRole(roots, selected.rel) : null;
  const mark = (r: FolderRole) => {
    if (!selected) return;
    setPs(markFolder(ps, selected.rel, role === r ? null : r, detected));
  };
  const unmarkedDetected = unmarkedRoots(detected, ps);
  const restore = () => setPs(restoreDetected(ps, detected));

  return (
    <div className={styles.page}>
      <div className={styles.structure}>
        <div className={styles.structureTree}>
          <div className={styles.markBar} role="toolbar" aria-label="Mark as">
            <span>
              <T>Mark as:</T>
            </span>
            {ROLES.map((r) => (
              <button
                key={r.role}
                type="button"
                className={styles.markButton}
                aria-pressed={role === r.role}
                disabled={!selected || (!selected.rel && r.role === "excluded")}
                onClick={() => mark(r.role)}
              >
                <Icon name={folderIconName(r.kind)} size={14} />
                {r.label}
              </button>
            ))}
          </div>
          <div className={styles.treeScroll}>
            <Tree<DirNode>
              aria-label="Content root"
              roots={[rootNode]}
              getKey={(n) => n.path}
              getLabel={(n) => n.name}
              getChildren={(n) => children.get(n.path)}
              isExpandable={() => true}
              loadChildren={load}
              expanded={expanded}
              onExpandedChange={(set) => setExpanded(set)}
              multiSelect={false}
              selected={selected ? new Set([selected.path]) : new Set()}
              onSelectionChange={(_s, lead) => setSelected(lead)}
              getIcon={(n) => {
                const r = rootRole(roots, n.rel);
                if (!n.rel && !r) return "module";
                return folderIconName(r ? ROLES.find((x) => x.role === r)!.kind : "plain");
              }}
              getDetail={(n) => (n.rel ? undefined : (root ?? undefined))}
            />
          </div>
        </div>
        <div className={styles.roots} aria-label="Marked folders">
          {ROLES.map((r) => {
            const list = roots.filter((x) => x.kind === r.role);
            return (
              <div key={r.role} className={styles.rootGroup}>
                <div className={clsx(styles.rootTitle, r.cls)}>
                  <Icon name={folderIconName(r.kind)} size={14} />
                  {r.title}
                </div>
                {list.length === 0 && (
                  <div className={clsx(styles.rootItem, styles.note)}>
                    <T>None</T>
                  </div>
                )}
                {list.map((x) => {
                  const shown = x.path || name || ".";
                  return (
                    <div key={x.path} className={styles.rootItem}>
                      <span className={styles.rootPath} title={x.path || root || undefined}>
                        {shown}
                        {x.detectedFrom && <span className={styles.rootHint}> detected from {x.detectedFrom}</span>}
                      </span>
                      <IconButton
                        icon="close"
                        size="small"
                        iconSize={12}
                        title={`Unmark ${shown}`}
                        onClick={() => setPs(markFolder(ps, x.path, null, detected))}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
          {unmarkedDetected.length > 0 && (
            <div className={styles.note}>
              {unmarkedDetected.length === 1
                ? "1 detected folder is unmarked."
                : `${unmarkedDetected.length} detected folders are unmarked.`}{" "}
              <button type="button" className={styles.linkButton} onClick={restore}>
                <T>Restore detected roots</T>
              </button>
            </div>
          )}
          <div className={styles.note}>
            <T>
              {
                "Folders are detected from build files (pom.xml, build.gradle, Cargo.toml, go.mod, pyproject.toml, package.json); marking or unmarking a folder overrides detection. Excluded folders are skipped by the Project view, Find in Files and the index (reopen the project to re-index)."
              }
            </T>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ProjectStructurePage;
