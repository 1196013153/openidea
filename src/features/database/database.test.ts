import { describe, expect, it } from "vitest";
import { exportData, type ExportData } from "./export";
import { buildRowEdits, connectRemedy, emptyEdits, hasEdits, parseSourceUrl, sourceLabel, splitTarget, sshLabel, targetOf, toCsv, toTsv } from "./model";

describe("clipboard formats", () => {
  it("copies TSV with NULL as empty and whitespace flattened", () => {
    expect(toTsv(["a", "b"], [["1", null], ["x\ty", "line\nbreak"]])).toBe("a\tb\n1\t\nx y\tline break");
    expect(toTsv(null, [["1"]])).toBe("1");
  });

  it("copies RFC 4180 CSV", () => {
    expect(toCsv(["id", "note"], [["1", 'say "hi", ok'], ["2", null]])).toBe('id,note\r\n1,"say ""hi"", ok"\r\n2,');
  });
});

describe("table edits", () => {
  const columns = ["id", "name", "note"];
  const rows = [
    ["1", "ann", null],
    ["2", "bob", "x"],
  ];

  it("turns pending changes into keyed updates, deletes and inserts", () => {
    const e = emptyEdits();
    expect(hasEdits(e)).toBe(false);
    e.updates.set(0, new Map([["note", "hello"]]));
    e.updates.set(1, new Map([["name", "bobby"]]));
    e.deletes.add(1);
    e.inserts.push(new Map([["name", "cy"]]));
    expect(hasEdits(e)).toBe(true);
    expect(buildRowEdits(columns, rows, ["id"], e)).toEqual([
      { kind: "update", key: [{ column: "id", value: "1" }], values: [{ column: "note", value: "hello" }] },
      { kind: "delete", key: [{ column: "id", value: "2" }] },
      { kind: "insert", values: [{ column: "name", value: "cy" }] },
    ]);
  });
});

describe("labels", () => {
  it("labels data sources", () => {
    expect(sourceLabel({ name: "app", driver: "postgres" })).toBe("app (PostgreSQL)");
  });
});

describe("export formats", () => {
  const data: ExportData = {
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
    ],
    rows: [
      ["1", "O'Hara"],
      ["2", null],
    ],
    table: "order items",
    driver: "postgres",
  };

  it("writes JSON with numbers and nulls", () => {
    expect(JSON.parse(exportData("json", data))).toEqual([
      { id: 1, name: "O'Hara" },
      { id: 2, name: null },
    ]);
  });

  it("writes SQL inserts with quoted names and literals", () => {
    expect(exportData("sql", data)).toBe(
      `INSERT INTO "order items" (id, name) VALUES (1, 'O''Hara');\nINSERT INTO "order items" (id, name) VALUES (2, NULL);`,
    );
  });

  it("writes a Markdown table, numbers right-aligned", () => {
    expect(exportData("markdown", { ...data, rows: [["1", "a|b"]] })).toBe("| id | name |\n| --: | --- |\n| 1 | a\\|b |");
  });
});

describe("connection errors", () => {
  const ssh = (auth: "password" | "keyPair" | "openSsh") => ({ ssh: { enabled: true, host: "bastion", auth } });

  it("asks for what the failed connection needs", () => {
    expect(connectRemedy("protocol", "Unknown SSH host key for bastion:22 (ssh-ed25519 SHA256:abc)")).toBe("trustHostKey");
    expect(connectRemedy("permissionDenied", "SSH password required for me@bastion:22", ssh("password"))).toBe("sshSecret");
    expect(connectRemedy("permissionDenied", "SSH key passphrase required for /k", ssh("keyPair"))).toBe("sshSecret");
    expect(connectRemedy("permissionDenied", "SSH authentication failed for me@bastion:22", ssh("password"))).toBe(
      "sshSecret",
    );
    expect(connectRemedy("permissionDenied", "SSH authentication failed for me@bastion:22", ssh("openSsh"))).toBeNull();
    expect(connectRemedy("permissionDenied", "[28P01] password authentication failed")).toBe("password");
    expect(connectRemedy("io", "connection refused")).toBeNull();
  });

  it("never offers to trust a changed host key", () => {
    expect(
      connectRemedy("permissionDenied", "SSH host key of bastion:22 has changed (known_hosts line 3); possible attack"),
    ).toBeNull();
  });

  it("labels the SSH host", () => {
    expect(sshLabel({ ssh: { host: "bastion", user: "ops", port: 2222 } })).toBe("ops@bastion:2222");
    expect(sshLabel({ ssh: null })).toBe("");
  });
});

describe("connection targets", () => {
  it("names the default database by the source id alone", () => {
    expect(targetOf("pg", null, "app")).toBe("pg");
    expect(targetOf("pg", "app", "app")).toBe("pg");
    expect(targetOf("pg", "other", "app")).toBe("pg:other");
  });

  it("splits a target back into source and database", () => {
    expect(splitTarget("pg")).toEqual({ id: "pg", database: null });
    expect(splitTarget("pg:my:db")).toEqual({ id: "pg", database: "my:db" });
  });
});

describe("parseSourceUrl", () => {
  it("reads PostgreSQL / MySQL URLs, plain and JDBC", () => {
    expect(parseSourceUrl("postgresql://ann:s%40cret@db.local:5433/shop?sslmode=require")).toEqual({
      source: { driver: "postgres", host: "db.local", port: 5433, user: "ann", database: "shop", ssl: "require" },
      password: "s@cret",
    });
    expect(parseSourceUrl("jdbc:mysql://localhost/app?user=root")).toEqual({
      source: { driver: "mysql", host: "localhost", port: null, user: "root", database: "app" },
      password: null,
    });
  });

  it("reads SQLite files and rejects other drivers", () => {
    expect(parseSourceUrl("jdbc:sqlite:C:/data/shop.db")?.source).toEqual({ driver: "sqlite", file: "C:/data/shop.db", name: "shop" });
    expect(parseSourceUrl("oracle://x")).toBeNull();
  });
});
