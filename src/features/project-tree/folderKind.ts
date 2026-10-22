/** Folder icon kind in the project view, from the effective roots. */
import { rootRole, type FolderRole, type RootFolder } from "@/platform/languageSettings";
import { relativePath } from "@/platform/project";
import type { FolderKind } from "@/ui";
import type { ProjectNode } from "./model";

const ROLE_KIND: Record<FolderRole, FolderKind> = {
  source: "source",
  test: "test",
  resources: "resources",
  testResources: "testResources",
  excluded: "excluded",
};

/** Project Structure marks and roots detected from build files; ignored entries look excluded. */
export function folderKind(
  node: Pick<ProjectNode, "path" | "ignored">,
  roots: readonly RootFolder[],
  root: string | null,
): FolderKind {
  if (node.ignored) return "excluded";
  const role = root ? rootRole(roots, relativePath(root, node.path)) : null;
  return role ? ROLE_KIND[role] : "plain";
}
