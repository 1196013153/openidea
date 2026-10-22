/**
 * Run targets of Dockerfiles (`FROM` lines → build image) and Compose files
 * (`services:` → up all, each service → up that service), detected per line like
 * the run gutter does, and the run configurations they start.
 */
import type { RunConfig } from "@/platform/ipc";

export type DockerTarget =
  | { kind: "build"; line: number; stage: string | null; last: boolean }
  | { kind: "composeAll"; line: number }
  | { kind: "composeService"; line: number; service: string };

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";

export function isDockerfile(path: string): boolean {
  const name = base(path);
  return /^(Dockerfile|Containerfile)(\.[\w.-]+)?$/i.test(name) || /\.(dockerfile|containerfile)$/i.test(name);
}

export function isComposeFile(path: string): boolean {
  return /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(base(path));
}

/** Every `FROM` line; a named stage (`AS build`) is built with `--target`, the last one whole. */
export function dockerfileTargets(text: string): DockerTarget[] {
  const out: Array<Extract<DockerTarget, { kind: "build" }>> = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+([\w.-]+))?\s*$/i.exec(line.replace(/\r$/, ""));
    if (m) out.push({ kind: "build", line: i, stage: m[1] ?? null, last: false });
  });
  if (out.length) out[out.length - 1]!.last = true;
  return out;
}

const KEY = /^(\s*)("([^"]+)"|'([^']+)'|[A-Za-z0-9._-]+)\s*:\s*(#.*)?$/;

/** The top-level `services:` key and each service directly below it. */
export function composeTargets(text: string): DockerTarget[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const out: DockerTarget[] = [];
  const start = lines.findIndex((l) => /^services\s*:\s*(#.*)?$/.test(l));
  if (start < 0) return out;
  out.push({ kind: "composeAll", line: start });
  let indent: number | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break; // next top-level key
    indent ??= lead;
    if (lead !== indent) continue;
    const m = KEY.exec(line);
    if (m) out.push({ kind: "composeService", line: i, service: m[3] ?? m[4] ?? m[2]! });
  }
  return out;
}

export function fileTargets(path: string, text: string): DockerTarget[] {
  if (isDockerfile(path)) return dockerfileTargets(text);
  if (isComposeFile(path)) return composeTargets(text);
  return [];
}

/** An image tag from the build context's folder name (`My App` → `my-app:latest`). */
export function imageTag(path: string): string {
  const folder = base(dir(path))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return `${folder || "image"}:latest`;
}

function rel(path: string, root: string | null): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : base(path);
}

export function targetTitle(t: DockerTarget, path: string): string {
  switch (t.kind) {
    case "build":
      return t.stage && !t.last ? `Build Stage '${t.stage}'` : `Build Image '${imageTag(path)}'`;
    case "composeAll":
      return "Compose Up (All Services)";
    case "composeService":
      return `Compose Up '${t.service}'`;
  }
}

/** The run configuration a target starts, run with `docker` (the resolved executable when known). */
export function targetConfig(t: DockerTarget, path: string, root: string | null, docker = "docker"): RunConfig {
  const cwd = dir(path);
  const file = rel(path, root);
  const common = { command: docker, cwd, env: {}, detected: false, isTest: false, debugAdapter: null, kind: "docker" };
  switch (t.kind) {
    case "build": {
      const args = ["build", "--file", path, "--tag", imageTag(path)];
      const stage = t.stage && !t.last ? t.stage : null;
      if (stage) args.push("--target", stage);
      args.push(cwd);
      return { ...common, id: `docker:build:${file}${stage ? `:${stage}` : ""}`, name: stage ? `${file} [${stage}]` : file, args };
    }
    case "composeAll":
      return { ...common, id: `docker:compose:${file}`, name: `Compose: ${file}`, args: ["compose", "--file", path, "up"] };
    case "composeService":
      return {
        ...common,
        id: `docker:compose:${file}:${t.service}`,
        name: `Compose: ${t.service}`,
        args: ["compose", "--file", path, "up", t.service],
      };
  }
}

/** `docker compose down` for a compose file (gutter menu of `services:`). */
export function composeDownConfig(path: string, root: string | null, docker = "docker"): RunConfig {
  const file = rel(path, root);
  return {
    id: `docker:compose-down:${file}`,
    name: `Compose Down: ${file}`,
    kind: "docker",
    command: docker,
    args: ["compose", "--file", path, "down"],
    cwd: dir(path),
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
  };
}
