/**
 * `go test` (plain and `-v`). Results are printed per package and the package
 * name only appears in the trailing `ok`/`FAIL` line, so events are buffered
 * per package and emitted under it once that line arrives.
 */
import { parseDuration, type TestEvent, type TestOutputParser } from "./types";

const RUN_RE = /^=== (?:RUN|CONT|PAUSE)\s+(\S+)/;
const RESULT_RE = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+s)\)/;
const PKG_RE = /^(ok|FAIL|---)\s+(\S+)\s+(?:\(cached\)|([\d.]+s)|\[[^\]]+\])/;
const LOCATION_RE = /^\s+([\w.-]+\.go):(\d+):/;

export function goParser(): TestOutputParser {
  let buffer: TestEvent[] = [];
  let current: string[] | null = null;
  let totals = { passed: 0, failed: 0, skipped: 0 };
  const located = new Set<string>();

  const flush = (pkg: string | null): TestEvent[] => {
    const out = buffer.map((e) => (pkg && "path" in e ? { ...e, path: [pkg, ...e.path] } : e));
    buffer = [];
    current = null;
    located.clear();
    return out;
  };

  return {
    feed(line) {
      let m: RegExpExecArray | null;
      if ((m = RUN_RE.exec(line))) {
        const path = m[1]!.split("/");
        buffer.push({ type: "start", path });
        current = path;
        return [];
      }
      if ((m = RESULT_RE.exec(line))) {
        const status = m[1] === "PASS" ? "passed" : m[1] === "FAIL" ? "failed" : "skipped";
        const path = m[2]!.split("/");
        buffer.push({ type: "result", path, status, durationMs: parseDuration(m[3]) });
        current = path;
        if (path.length === 1) totals = { ...totals, [status]: totals[status] + 1 };
        return [];
      }
      if ((m = PKG_RE.exec(line)) && m[1] !== "---") {
        const pkg = m[2]!;
        const events = flush(pkg);
        // Without -v a passing package prints nothing per test: show the package itself.
        if (!events.some((e) => e.type === "result")) {
          events.push({ type: "result", path: [pkg], status: m[1] === "ok" ? "passed" : "failed", durationMs: parseDuration(m[3]) });
        }
        events.push({ type: "summary", ...totals });
        return events;
      }
      if (current && /^\s+/.test(line)) {
        buffer.push({ type: "output", path: current, line });
        const loc = LOCATION_RE.exec(line);
        const key = current.join("/");
        if (loc && !located.has(key)) {
          located.add(key);
          buffer.push({ type: "location", path: current, location: { path: loc[1]!, line: Number(loc[2]), resolve: "name" } });
        }
      }
      return [];
    },
    end() {
      return flush(null);
    },
  };
}
