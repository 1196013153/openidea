/** Folder icon kind in the project view, from the effective roots. */
import { rootRole, type FolderRole, type RootFolder } from "@/platform/languageSettings";
import { basename, relativePath } from "@/platform/project";
import type { FolderKind } from "@/ui";
import type { ProjectNode } from "./model";

const ROLE_KIND: Record<FolderRole, FolderKind> = {
  source: "source",
  test: "test",
  resources: "resources",
  testResources: "testResources",
  excluded: "excluded",
};

/**
 * Project Structure marks and roots detected from build files. Like IDEA, only
 * excluded folders get the excluded icon; git-ignored ones keep the plain one.
 */
export function folderKind(
  node: Pick<ProjectNode, "path" | "excluded">,
  roots: readonly RootFolder[],
  root: string | null,
): FolderKind {
  if (node.excluded) return "excluded";
  const role = root ? rootRole(roots, relativePath(root, node.path)) : null;
  if (role) return ROLE_KIND[role];
  return basename(node.path) === ".github" ? "github" : "plain";
}
