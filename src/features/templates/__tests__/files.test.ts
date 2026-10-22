import { describe, expect, it } from "vitest";
import { inferGoPackage, inferJvmPackage, planFile, renderFileTemplate, styleName } from "../files/model";
import { BUILTIN_FILE_TEMPLATES } from "../files/builtins";

const tpl = (id: string) => BUILTIN_FILE_TEMPLATES.find((t) => t.id === id)!;

describe("package inference", () => {
  it("uses the path below JVM source roots", () => {
    expect(inferJvmPackage("/p/src/main/kotlin/com/acme", "/p")).toBe("com.acme");
    expect(inferJvmPackage("/p/app/src/test/java/org/x/util", "/p")).toBe("org.x.util");
    expect(inferJvmPackage("/p/shared/src/commonMain/kotlin/io/k", "/p")).toBe("io.k");
    expect(inferJvmPackage("/p/src/com/acme", "/p")).toBe("com.acme");
    expect(inferJvmPackage("/p/src/main/java", "/p")).toBe("");
    expect(inferJvmPackage("/p/docs", "/p")).toBe("");
    expect(inferJvmPackage("/p/src/main/java/my-app/x", "/p")).toBe("my_app.x");
    expect(inferJvmPackage("/p/src/main/java/1bad", "/p")).toBe("");
  });

  it("counts from the nearest source root when roots are known", () => {
    // A custom root (`<sourceDirectory>gen</sourceDirectory>`, Mark Directory as Sources Root).
    expect(inferJvmPackage("/p/gen/com/acme", "/p", ["gen"])).toBe("com.acme");
    expect(inferJvmPackage("/p/gen", "/p", ["gen"])).toBe("");
    // Innermost root wins; conventions apply outside every root.
    expect(inferJvmPackage("/p/src/x/y/z", "/p", ["src", "src/x"])).toBe("y.z");
    expect(inferJvmPackage("/p/src/main/java/a/b", "/p", ["lib"])).toBe("a.b");
    expect(inferJvmPackage("/p/gens/a", "/p", ["gen"])).toBe("");
  });

  it("infers Go packages", () => {
    expect(inferGoPackage("/p/internal/store", "/p")).toBe("store");
    expect(inferGoPackage("/p/cmd/server", "/p")).toBe("main");
    expect(inferGoPackage("/p/pkg/http-util", "/p")).toBe("httputil");
    expect(inferGoPackage("/p/pkg/x", "/p", "xsvc")).toBe("xsvc");
  });
});

describe("file naming", () => {
  it("applies styles and extensions", () => {
    expect(styleName("UserService", "snake")).toBe("user_service");
    expect(styleName("user service", "pascal")).toBe("UserService");
    expect(planFile(tpl("rust"), "/p/src", "HttpClient")?.path).toBe("/p/src/http_client.rs");
    expect(planFile(tpl("tsx"), "/p/src", "user-card.tsx")?.path).toBe("/p/src/UserCard.tsx");
    expect(planFile(tpl("java"), "/p/src/main/java", "com.acme.Foo")).toMatchObject({
      path: "/p/src/main/java/com/acme/Foo.java",
      directory: "/p/src/main/java/com/acme",
      name: "Foo",
    });
    expect(planFile(tpl("file"), "/p", "notes/todo.txt")?.path).toBe("/p/notes/todo.txt");
    expect(planFile(tpl("file"), "/p", "  ")).toBeNull();
    expect(planFile(tpl("file"), "/p", "../x")).toBeNull();
  });
});

describe("rendering", () => {
  it("substitutes variables and places the caret", () => {
    const kind = tpl("java").kinds[0]!;
    const r = renderFileTemplate(kind.body, { name: "Foo", fileName: "Foo.java", packageName: "com.acme" });
    expect(r.text).toBe("package com.acme;\n\npublic class Foo {\n    \n}\n");
    expect(r.text.slice(r.caret)).toBe("\n}\n");
  });

  it("drops the package line when there is no package", () => {
    const kind = tpl("kotlin").kinds[0]!;
    const r = renderFileTemplate(kind.body, { name: "Foo", fileName: "Foo.kt" });
    expect(r.text).toBe("class Foo {\n    \n}\n");
  });

  it("caret defaults to the end and $$ is a dollar", () => {
    const r = renderFileTemplate("a$$b $YEAR$", { name: "", fileName: "", now: new Date(2030, 1, 1) });
    expect(r).toEqual({ text: "a$b 2030", caret: 8 });
  });
});
