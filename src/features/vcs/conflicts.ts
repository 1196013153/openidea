/** Git conflict marker parsing and resolution (pure). */

export interface ConflictBlock {
  /** Offset of the `<<<<<<<` line start. */
  from: number;
  /** Offset just past the `>>>>>>>` line (including its terminator). */
  to: number;
  ours: string;
  /** diff3 base section, when present. */
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
  /** Offsets of the separator lines (for decorations). */
  oursFrom: number;
  oursTo: number;
  theirsFrom: number;
  theirsTo: number;
}

const START = "<<<<<<<";
const BASE = "|||||||";
const SEP = "=======";
const END = ">>>>>>>";

const isMarker = (line: string, marker: string) =>
  line.startsWith(marker) && (line.length === 7 || line[7] === " " || line[7] === "\r" || line[7] === "\n");

/** Finds well-formed conflict blocks in `text`. */
export function parseConflicts(text: string): ConflictBlock[] {
  const out: ConflictBlock[] = [];
  const lines: Array<{ from: number; text: string; end: number }> = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl + 1;
    lines.push({ from: pos, text: text.slice(pos, end), end });
    pos = end;
  }
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]!;
    if (!isMarker(start.text, START)) continue;
    let baseAt = -1;
    let sepAt = -1;
    let endAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (isMarker(t, START)) break;
      if (sepAt < 0 && baseAt < 0 && isMarker(t, BASE)) baseAt = j;
      else if (sepAt < 0 && isMarker(t, SEP)) sepAt = j;
      else if (sepAt >= 0 && isMarker(t, END)) {
        endAt = j;
        break;
      }
    }
    if (sepAt < 0 || endAt < 0) continue;
    const slice = (a: number, b: number) => (a >= b ? "" : text.slice(lines[a]!.from, lines[b - 1]!.end));
    const oursEnd = baseAt >= 0 ? baseAt : sepAt;
    const label = (l: string, m: string) => l.slice(m.length).trim();
    out.push({
      from: start.from,
      to: lines[endAt]!.end,
      ours: slice(i + 1, oursEnd),
      base: baseAt >= 0 ? slice(baseAt + 1, sepAt) : null,
      theirs: slice(sepAt + 1, endAt),
      oursLabel: label(start.text, START),
      theirsLabel: label(lines[endAt]!.text, END),
      oursFrom: lines[i + 1]?.from ?? start.end,
      oursTo: lines[oursEnd]!.from,
      theirsFrom: lines[sepAt]!.end,
      theirsTo: lines[endAt]!.from,
    });
    i = endAt;
  }
  return out;
}

export type Resolution = "ours" | "theirs" | "both" | "base";

export function resolutionText(block: ConflictBlock, how: Resolution): string {
  switch (how) {
    case "ours":
      return block.ours;
    case "theirs":
      return block.theirs;
    case "base":
      return block.base ?? "";
    case "both": {
      const a = block.ours;
      return a && !a.endsWith("\n") ? `${a}\n${block.theirs}` : a + block.theirs;
    }
  }
}

/** Resolves every block the same way. */
export function resolveAll(text: string, how: Resolution): string {
  const blocks = parseConflicts(text);
  let out = "";
  let pos = 0;
  for (const b of blocks) {
    out += text.slice(pos, b.from) + resolutionText(b, how);
    pos = b.to;
  }
  return out + text.slice(pos);
}

export function blockAt(blocks: readonly ConflictBlock[], offset: number): ConflictBlock | undefined {
  return blocks.find((b) => b.from <= offset && offset < Math.max(b.to, b.from + 1));
}
