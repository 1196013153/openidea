/**
 * Gutter ▶ icons next to runnable declarations (`fn main`, tests, test suites)
 * with a Run / Debug popup, as in IntelliJ (no code lenses).
 * Targets are detected with cheap per-line regexes, recomputed (debounced) after
 * edits and mapped through changes in between.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { shortcutLabel } from "@/platform/keymap";
import { iconMarkup, showContextMenu } from "@/ui";
import { notifications, runExecutors } from "@/workbench/contributions";
import { executeContext, launchProduced, produceResolved } from "./contextRun";
import { goModulePath, loadGoModules } from "./goModules";
import { fileTargets, OPTIMISTIC, produceContext, type ContextInput } from "./producers";
import { loadConfigs, useRun } from "./store";
import { targetLanguage, type RunTarget } from "./targets";

/** Languages with gutter run targets (C / C++ `main` included). */
const hasGutterTargets = (path: string) => !!targetLanguage(path) || /\.(c|cpp|cc|cxx)$/.test(path);
import styles from "./Run.module.css";

interface PlacedTarget extends RunTarget {
  /** Line start offset in the current state. */
  pos: number;
}

const setTargets = StateEffect.define<PlacedTarget[]>();

function place(state: EditorState, targets: RunTarget[]): PlacedTarget[] {
  return targets.filter((t) => t.line < state.doc.lines).map((t) => ({ ...t, pos: state.doc.line(t.line + 1).from }));
}

const targetsField = StateField.define<PlacedTarget[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTargets)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    const out: PlacedTarget[] = [];
    for (const t of value) {
      const pos = tr.changes.mapPos(t.pos, -1);
      const line = tr.state.doc.lineAt(pos);
      if (out.some((o) => o.pos === line.from)) continue;
      out.push({ ...t, pos: line.from, line: line.number - 1 });
    }
    return out;
  },
});

function targetInput(path: string, content: string, line: number): ContextInput {
  return {
    path,
    root: useProject.getState().project?.root ?? null,
    configs: useRun.getState().configs,
    content,
    line,
    goModule: goModulePath,
  };
}

async function launch(target: RunTarget, path: string, debug: boolean, content: string) {
  if (!useProject.getState().project?.root) return;
  if (!useRun.getState().loaded) await loadConfigs();
  const produced = await produceResolved(targetInput(path, content.slice(0, 400_000), target.line));
  if (!produced) {
    notifications().notify({
      group: "run",
      level: "info",
      title: "Nothing to run here",
      body: "No run or test configuration of the project matches this file.",
      key: "run-target",
    });
    return;
  }
  // IDEA: running a gutter target creates (or reuses) a temporary configuration and selects it.
  await launchProduced(produced, debug);
}

export function targetTitle(t: RunTarget): string {
  if (t.kind === "main") return "Run";
  if (t.kind === "suite") return "Run tests";
  return "Run test";
}

export function label(t: RunTarget): string {
  if (t.kind === "main") return t.className ? `${t.name}.main()` : "main";
  return t.name;
}

function showTargetMenu(view: EditorView, target: RunTarget, path: string, at: { x: number; y: number }) {
  const content = view.state.doc.toString();
  const p = produceContext(targetInput(path, content.slice(0, 400_000), target.line), OPTIMISTIC);
  const name = p?.name ?? label(target);
  // Like IDEA, Debug only where a debugger can run it.
  const debuggable = !p || !!(p.debug || p.config?.debugAdapter || p.missing);
  showContextMenu(at, [
    {
      label: `Run '${name}'`,
      icon: "run",
      shortcut: shortcutLabel("run.runContext"),
      run: () => void launch(target, path, false, content),
    },
    ...(debuggable
      ? [
          {
            label: `Debug '${name}'`,
            icon: "debug",
            shortcut: shortcutLabel("run.debugContext"),
            run: () => void launch(target, path, true, content),
          },
        ]
      : []),
    ...runExecutors()
      .filter((e) => !!p?.config && e.supports(p.config))
      .map((e) => ({
        label: e.label(name),
        icon: e.icon,
        run: () => void executeContext(e.id, { path, line: target.line, content: content.slice(0, 400_000) }),
      })),
  ]);
}

class RunMarker extends GutterMarker {
  constructor(
    readonly target: PlacedTarget,
    readonly path: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof RunMarker &&
      other.target.kind === this.target.kind &&
      other.target.name === this.target.name &&
      other.path === this.path
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    el.title = `${targetTitle(this.target)} '${label(this.target)}'`;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", el.title);
    el.innerHTML = iconMarkup(this.target.kind === "suite" ? "gutter-run-all" : "gutter-run", 14) ?? "";
    return el;
  }
}

function markers(state: EditorState, path: string): RangeSet<GutterMarker> {
  return RangeSet.of(
    state.field(targetsField).map((t) => new RunMarker(t, path).range(t.pos)),
    true,
  );
}

const DEBOUNCE = 350;

export function runGutter(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  if (!useProject.getState().project?.root || isVirtualUri(path) || !hasGutterTargets(path)) return [];
  if (/\.go$/.test(path)) void loadGoModules(useProject.getState().project?.root ?? null, useRun.getState().configs).catch(() => {});
  const detect = (text: string) =>
    fileTargets({ path, root: useProject.getState().project?.root ?? null, configs: useRun.getState().configs }, text);

  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(DEBOUNCE);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const view = this.view;
          const found = place(view.state, detect(view.state.doc.toString()));
          const cur = view.state.field(targetsField);
          const same =
            cur.length === found.length &&
            cur.every((t, i) => t.pos === found[i]!.pos && t.name === found[i]!.name && t.kind === found[i]!.kind);
          if (!same) view.dispatch({ effects: setTargets.of(found) });
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );

  return [
    targetsField,
    detector,
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-run`,
      markers: (view) => markers(view.state, path),
      initialSpacer: () => new RunMarker({ line: 0, pos: 0, kind: "test", name: "", path: [] }, path),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const target = view.state.field(targetsField).find((t) => t.pos === block.from);
          if (!target || (event as MouseEvent).button !== 0) return false;
          const el = (event.target as HTMLElement).closest?.(`.${styles.runMarker}`) as HTMLElement | null;
          const rect = (el ?? (event.target as HTMLElement)).getBoundingClientRect();
          event.preventDefault();
          showTargetMenu(view, target, path, { x: rect.left, y: rect.bottom + 2 });
          return true;
        },
      },
    }),
  ];
}
