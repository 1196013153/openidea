import { describe, expect, it } from "vitest";
import type { DockerContainer, DockerSnapshot } from "@/platform/ipc";
import { composeTargets, dockerfileTargets, fileTargets, imageTag, isComposeFile, isDockerfile, targetConfig } from "./compose";
import { childrenOf, findNode, nodeDetail, nodeLabel, rootNodes, type ServiceNode } from "./model";

const container = (name: string, state: string, project?: string, service?: string): DockerContainer => ({
  id: `${name}-id`,
  name,
  image: "img",
  command: "",
  state,
  status: state === "running" ? "Up 1 hour" : "Exited (0)",
  ports: "",
  createdAt: "",
  composeProject: project ?? null,
  composeService: service ?? null,
  composeWorkingDir: null,
  composeFiles: [],
});

const snapshot: DockerSnapshot = {
  availability: { kind: "ready", clientVersion: "27", serverVersion: "27", context: null },
  executable: "/usr/bin/docker",
  containers: [container("web", "exited"), container("shop-db-1", "running", "shop", "db"), container("shop-api-1", "exited", "shop", "api")],
  images: [{ id: "sha256:abc", repository: "postgres", tag: "16", size: "1MB", createdSince: "now" }],
  volumes: [],
  networks: [],
  errors: [],
};

describe("services tree", () => {
  it("groups containers by compose project before standalone ones", () => {
    const children = childrenOf(snapshot);
    const [docker] = rootNodes();
    const groups = children(docker!)!;
    expect(groups.map(nodeLabel)).toEqual(["Containers", "Images", "Volumes", "Networks"]);
    expect(nodeDetail(groups[0]!)).toBe("3");
    const containers = children(groups[0]!)!;
    expect(containers.map((n) => n.kind)).toEqual(["compose", "container"]);
    const shop = containers[0] as Extract<ServiceNode, { kind: "compose" }>;
    expect(nodeDetail(shop)).toBe("1/2 running");
    expect(children(shop)!.map(nodeLabel)).toEqual(["api", "db"]);
    expect(nodeLabel(children(groups[1]!)![0]!)).toBe("postgres:16");
  });

  it("finds nodes again in a new snapshot", () => {
    expect(findNode(snapshot, "container:shop-db-1-id")?.kind).toBe("container");
    expect(findNode(snapshot, "container:gone")).toBeNull();
  });

  it("has no children while docker is down", () => {
    const down: DockerSnapshot = { ...snapshot, availability: { kind: "daemonDown", message: "x", context: null } };
    expect(childrenOf(down)(rootNodes()[0]!)).toBeUndefined();
  });
});

describe("docker run targets", () => {
  it("recognises file names", () => {
    expect(isDockerfile("/p/Dockerfile")).toBe(true);
    expect(isDockerfile("/p/Dockerfile.dev")).toBe(true);
    expect(isDockerfile("/p/api.dockerfile")).toBe(true);
    expect(isDockerfile("/p/Dockerfiles.md")).toBe(false);
    expect(isComposeFile("/p/docker-compose.yml")).toBe(true);
    expect(isComposeFile("/p/compose.override.yaml")).toBe(true);
    expect(isComposeFile("/p/values.yaml")).toBe(false);
  });

  it("finds compose services directly under services:", () => {
    const text = [
      "name: shop",
      "services:",
      "  # the database",
      "  db:",
      "    image: postgres:16",
      "    environment:",
      "      POSTGRES_PASSWORD: x",
      '  "api":',
      "    build: .",
      "    depends_on:",
      "      - db",
      "volumes:",
      "  pgdata:",
    ].join("\n");
    expect(composeTargets(text)).toEqual([
      { kind: "composeAll", line: 1 },
      { kind: "composeService", line: 3, service: "db" },
      { kind: "composeService", line: 7, service: "api" },
    ]);
    expect(composeTargets("version: '3'\n")).toEqual([]);
  });

  it("builds each FROM stage", () => {
    const text = "FROM node:22 AS build\nRUN npm ci\nFROM --platform=linux/amd64 nginx:1.27\nCOPY --from=build /app /usr/share/nginx/html\n";
    expect(dockerfileTargets(text)).toEqual([
      { kind: "build", line: 0, stage: "build", last: false },
      { kind: "build", line: 2, stage: null, last: true },
    ]);
    expect(fileTargets("/p/README.md", text)).toEqual([]);
  });

  it("creates run configurations", () => {
    expect(imageTag("/work/My App/Dockerfile")).toBe("my-app:latest");
    const build = targetConfig({ kind: "build", line: 0, stage: "build", last: false }, "/work/app/Dockerfile", "/work/app");
    expect(build.args).toEqual(["build", "--file", "/work/app/Dockerfile", "--tag", "app:latest", "--target", "build", "/work/app"]);
    expect(build.cwd).toBe("/work/app");
    const up = targetConfig({ kind: "composeService", line: 3, service: "db" }, "/work/app/compose.yaml", "/work/app", "/bin/docker");
    expect(up).toMatchObject({ command: "/bin/docker", args: ["compose", "--file", "/work/app/compose.yaml", "up", "db"], id: "docker:compose:compose.yaml:db" });
  });
});
