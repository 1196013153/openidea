/**
 * File templates ("New ▸ Rust File", "Kotlin Class"…): naming rules,
 * package inference and body rendering.
 *
 * Body variables: `$NAME$` (the entered name, styled per template),
 * `$PACKAGE$`, `$FILE_NAME$`, `$DATE$`, `$TIME$`, `$YEAR$`, `$USER$`,
 * `$PROJECT_NAME$`, `$END$` (caret). A line mentioning `$PACKAGE$` is
 * dropped, together with one following blank line, when the package is empty.
 */
import { formatDate, pascalCase, snakeCase, kebabCase } from "../live/model";

export type NameStyle = "asis" | "snake" | "pascal" | "kebab";

export interface FileTemplateKind {
  id: string;
  label: string;
  body: string;
}

export interface FileTemplate {
  id: string;
  /** Menu label, e.g. "Rust File". */
  name: string;
  icon: string;
  /** Without the dot; empty for "File…" (the name carries the extension). */
  extension: string;
  nameStyle: NameStyle;
  /** Package inference: `jvm` (Java/Kotlin source roots) or `go` (directory). */
  packageStyle?: "jvm" | "go";
  /** Dotted names (`com.acme.Foo`) create package directories. */
  dottedPackages?: boolean;
  kinds: FileTemplateKind[];
  enabled?: boolean;
}

export function styleName(name: string, style: NameStyle): string {
  switch (style) {
    case "snake":
      return snakeCase(name) || name;
    case "pascal":
      return /^[A-Z][A-Za-z0-9]*$/.test(name) ? name : pascalCase(name) || name;
    case "kebab":
      return kebabCase(name) || name;
    default:
      return name;
  }
}

export interface PlannedFile {
  /** Absolute path of the new file. */
  path: string;
  /** Directory the file goes into (may not exist yet). */
  directory: string;
  /** `$NAME$` value. */
  name: string;
  fileName: string;
}

/**
 * Resolves the entered name to a file path: strips a typed extension, allows
 * `sub/dir/name` (and `com.acme.Name` for JVM templates) and applies the
 * template's naming style.
 */
export function planFile(
  t: Pick<FileTemplate, "extension" | "nameStyle" | "dottedPackages">,
  directory: string,
  input: string,
): PlannedFile | null {
  let raw = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!raw) return null;
  const ext = t.extension ? `.${t.extension}` : "";
  if (ext && raw.toLowerCase().endsWith(ext.toLowerCase())) raw = raw.slice(0, -ext.length);
  let parts = raw.split("/").filter(Boolean);
  if (t.dottedPackages && parts.length === 1 && /^[\w$]+(\.[\w$]+)+$/.test(parts[0]!)) parts = parts[0]!.split(".");
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
  const last = parts.pop()!;
  const name = styleName(last, t.nameStyle);
  if (!name || /[<>:"|?*]/.test(name)) return null;
  const dir = [directory.replace(/\/+$/, ""), ...parts].join("/");
  const fileName = name + ext;
  return { path: `${dir}/${fileName}`, directory: dir, name, fileName };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const JVM_ROOTS = new Set(["java", "kotlin", "scala", "groovy"]);

/** Project-relative path of a source / test root (`""` = the content root). */
export type SourceRootPath = string;

const toPackage = (segs: readonly string[]) => {
  const clean = segs.map((s) => s.replace(/-/g, "_"));
  return clean.every((s) => IDENT.test(s)) ? clean.join(".") : "";
};

/**
 * Java/Kotlin package for a directory: the path below the nearest source or
 * test root (`sourceRoots`, from Project Structure and build-file detection),
 * as IDEA does. Without a containing root, conventions apply
 * (`src/main/kotlin/com/acme` → `com.acme`, also `src/commonMain/kotlin/…`,
 * `src/test/java/…`); a plain `src/com/acme` falls back to below `src`.
 */
export function inferJvmPackage(
  directory: string,
  projectRoot: string | null,
  sourceRoots: readonly SourceRootPath[] = [],
): string {
  let rel = directory.replace(/\/+$/, "");
  if (projectRoot && (rel === projectRoot || rel.startsWith(`${projectRoot.replace(/\/+$/, "")}/`)))
    rel = rel.slice(projectRoot.replace(/\/+$/, "").length);
  const segs = rel.split("/").filter(Boolean);
  const relPath = segs.join("/");
  const nearest = sourceRoots
    .filter((r) => !r || relPath === r || relPath.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (nearest !== undefined) return toPackage(segs.slice(nearest.split("/").filter(Boolean).length));
  const srcIdx = segs.lastIndexOf("src");
  let rootIdx = -1;
  for (let i = segs.length - 1; i > srcIdx && srcIdx >= 0; i--) {
    if (JVM_ROOTS.has(segs[i]!)) {
      rootIdx = i;
      break;
    }
  }
  let pkg: string[];
  if (rootIdx >= 0) pkg = segs.slice(rootIdx + 1);
  else if (srcIdx >= 0) {
    pkg = segs.slice(srcIdx + 1);
    // `src/main` without a language root has no package.
    if (["main", "test"].includes(pkg[0] ?? "")) pkg = pkg.slice(1);
  } else pkg = [];
  return toPackage(pkg);
}

/**
 * Go package for a directory: the package of an existing sibling file when
 * known, `main` under `cmd/`, otherwise the sanitized directory name.
 */
export function inferGoPackage(directory: string, projectRoot: string | null, siblingPackage?: string | null): string {
  if (siblingPackage) return siblingPackage;
  const dir = directory.replace(/\/+$/, "");
  const segs = dir.split("/").filter(Boolean);
  const rootSegs = (projectRoot ?? "").split("/").filter(Boolean).length;
  const below = segs.slice(rootSegs);
  if (below.length >= 1 && below.slice(0, -1).includes("cmd")) return "main";
  const base = (segs[segs.length - 1] ?? "main").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!base || /^\d/.test(base)) return "main";
  return base;
}

export const GO_PACKAGE_RE = /^\s*package\s+([A-Za-z_]\w*)/m;

export interface FileTemplateVars {
  name: string;
  fileName: string;
  packageName?: string;
  projectName?: string;
  user?: string;
  now?: Date;
}

/** Renders a body; returns the text and the caret offset (`$END$`, else the end). */
export function renderFileTemplate(body: string, vars: FileTemplateVars): { text: string; caret: number } {
  const now = vars.now ?? new Date();
  const values: Record<string, string> = {
    NAME: vars.name,
    FILE_NAME: vars.fileName,
    PACKAGE: vars.packageName ?? "",
    PACKAGE_NAME: vars.packageName ?? "",
    PROJECT_NAME: vars.projectName ?? "",
    USER: vars.user ?? "",
    DATE: formatDate(now),
    TIME: formatDate(now, "HH:mm"),
    YEAR: String(now.getFullYear()),
  };
  let lines = body.replace(/\r\n?/g, "\n").split("\n");
  if (!values.PACKAGE) {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\$PACKAGE(_NAME)?\$/.test(lines[i]!)) {
        if (lines[i + 1]?.trim() === "") i++;
        continue;
      }
      out.push(lines[i]!);
    }
    lines = out;
  }
  let text = "";
  let caret = -1;
  const src = lines.join("\n");
  let i = 0;
  while (i < src.length) {
    if (src[i] === "$") {
      if (src[i + 1] === "$") {
        text += "$";
        i += 2;
        continue;
      }
      const close = src.indexOf("$", i + 1);
      const key = close > 0 ? src.slice(i + 1, close) : "";
      if (key === "END") {
        if (caret < 0) caret = text.length;
        i = close + 1;
        continue;
      }
      if (key in values) {
        text += values[key];
        i = close + 1;
        continue;
      }
    }
    text += src[i];
    i++;
  }
  return { text, caret: caret < 0 ? text.length : caret };
}
