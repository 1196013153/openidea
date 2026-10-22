/**
 * Console line model for run output: splits streamed chunks into lines,
 * parses ANSI SGR colours (via `anser`, one stateful parser per stream),
 * handles `\r` overwrites (progress bars) and caps the buffer.
 */
/* eslint-disable no-control-regex -- escape-sequence parsing matches control characters by design */
import Anser from "anser";
import type { OutputChunk } from "@/platform/ipc";

export type ChunkKind = OutputChunk["kind"];

export interface SpanStyle {
  /** CSS colour (`var(--ansi-red)`, `rgb(…)`). */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface Span extends SpanStyle {
  text: string;
}

export interface ConsoleLine {
  /** Monotonic id (stable across trimming). */
  id: number;
  kind: ChunkKind;
  spans: Span[];
  /** Plain text without escape sequences. */
  text: string;
}

export const MAX_LINES = 50_000;
/** Very long lines are broken up so a single minified blob can't stall rendering. */
export const MAX_LINE_LENGTH = 8_000;

const NAMED = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** xterm 256-colour palette entry (16–255) as `rgb(…)`. */
export function paletteColor(n: number): string {
  if (n < 16) {
    const bright = n >= 8;
    return `var(--ansi-${bright ? "bright-" : ""}${NAMED[n % 8]})`;
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]}, ${steps[Math.floor(i / 6) % 6]}, ${steps[i % 6]})`;
}

function cssColor(cls: string | null, truecolor: string | null): string | undefined {
  if (!cls) return undefined;
  if (cls === "ansi-truecolor") return truecolor ? `rgb(${truecolor})` : undefined;
  const palette = /^ansi-palette-(\d+)$/.exec(cls);
  if (palette) return paletteColor(Number(palette[1]));
  if (cls.startsWith("ansi-")) return `var(--${cls})`;
  return undefined;
}

function sameStyle(a: SpanStyle, b: SpanStyle) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike
  );
}

// OSC (…BEL or …ST), and escape sequences other than CSI.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const NON_CSI_ESC_RE = /\x1b(?:[()][0-9A-Za-z]|[=>78DEHMNOZc])/g;
// CSI that isn't SGR: erase-line becomes a carriage return, everything else is dropped.
const CSI_RE = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/g;
// An escape sequence cut off at the end of a chunk.
const INCOMPLETE_RE = /\x1b(?:\[[0-9;?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;

class StreamParser {
  private anser = new Anser();
  private carry = "";

  /** Normalises escapes; returns text whose only escapes are SGR (`ESC[…m`). */
  clean(text: string): string {
    let s = this.carry + text;
    this.carry = "";
    const cut = INCOMPLETE_RE.exec(s);
    if (cut && cut[0].length > 0) {
      this.carry = cut[0];
      s = s.slice(0, cut.index);
    }
    return s
      .replace(OSC_RE, "")
      .replace(NON_CSI_ESC_RE, "")
      .replace(CSI_RE, (all, params: string, _i: string, final: string) => {
        if (final === "m") return all;
        if (final === "K" && (params === "2" || params === "1")) return "\r";
        if (final === "G" && (params === "" || params === "1" || params === "0")) return "\r";
        return "";
      })
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
  }

  /** Style in effect at the end of the previous call (anser only carries it into escaped chunks). */
  private carryStyle: SpanStyle = {};

  spans(text: string): Span[] {
    const out: Span[] = [];
    const entries = this.anser.ansiToJson(text, { json: true, use_classes: true });
    entries.forEach((e, i) => {
      // Entry 0 is the text before the first escape: it continues the previous style.
      const style = i === 0 ? this.carryStyle : entryStyle(e);
      if (i === entries.length - 1) this.carryStyle = style;
      if (e.content) out.push({ text: e.content, ...style });
    });
    return out;
  }
}

function entryStyle(e: Anser.AnserJsonEntry): SpanStyle {
  const decorations = e.decorations ?? [];
  const style: SpanStyle = {};
  let fg = cssColor(e.fg, e.fg_truecolor);
  let bg = cssColor(e.bg, e.bg_truecolor);
  if ((e as { isInverted?: boolean }).isInverted) {
    [fg, bg] = [bg ?? "var(--bg-app)", fg ?? "var(--fg)"];
  }
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  if (decorations.includes("bold")) style.bold = true;
  if (decorations.includes("dim")) style.dim = true;
  if (decorations.includes("italic")) style.italic = true;
  if (decorations.includes("underline")) style.underline = true;
  if (decorations.includes("strikethrough")) style.strike = true;
  return style;
}

export interface ConsoleModelOptions {
  maxLines?: number;
  /** Cycle buffer: total characters kept (Settings › Console); unlimited when absent. */
  maxChars?: number | null;
  /** Called for every completed line (plain text), e.g. to feed the test parser. */
  onLine?: (text: string, kind: ChunkKind) => void;
}

export class ConsoleModel {
  lines: ConsoleLine[] = [];
  /** Total lines ever dropped from the front. */
  dropped = 0;
  private nextId = 1;
  private open: ConsoleLine | null = null;
  private pendingCR = false;
  private readonly parsers = { stdout: new StreamParser(), stderr: new StreamParser(), system: new StreamParser() };
  private readonly maxLines: number;
  private maxChars: number | null;
  /** Characters currently buffered (line text + one per line break). */
  private chars = 0;
  private readonly onLine?: (text: string, kind: ChunkKind) => void;

  constructor(options: ConsoleModelOptions = {}) {
    this.maxLines = options.maxLines ?? MAX_LINES;
    this.maxChars = options.maxChars ?? null;
    this.onLine = options.onLine;
  }

  /** Changes the cycle buffer size (applies on the next append). */
  setMaxChars(maxChars: number | null) {
    this.maxChars = maxChars;
    this.trim();
  }

  append(chunk: OutputChunk) {
    const { kind } = chunk;
    // Streams don't share a line; system messages always start on a fresh one.
    if (this.open && (this.open.kind !== kind || kind === "system")) {
      if (this.open.text.length > 0) this.closeLine();
      else this.open.kind = kind;
    }
    const text = this.parsers[kind].clean(chunk.text);
    const segments = text.split("\n");
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      this.appendSegment(kind, last ? segment : segment.replace(/\r$/, ""));
      if (!last) this.closeLine(kind);
    });
    if (kind === "system" && this.open?.text) this.closeLine();
    this.trim();
  }

  private appendSegment(kind: ChunkKind, segment: string) {
    if (!segment) return;
    const pieces = segment.split("\r");
    pieces.forEach((piece, i) => {
      if (i > 0) this.pendingCR = true;
      if (!piece) return;
      const line = this.ensureOpen(kind);
      if (this.pendingCR) {
        this.chars -= line.text.length;
        line.spans = [];
        line.text = "";
        this.pendingCR = false;
      }
      for (const span of this.parsers[kind].spans(piece)) this.pushSpan(kind, span);
    });
  }

  private pushSpan(kind: ChunkKind, span: Span) {
    let rest = span.text;
    while (rest) {
      const line = this.ensureOpen(kind);
      const room = MAX_LINE_LENGTH - line.text.length;
      const text = rest.slice(0, room);
      rest = rest.slice(text.length);
      const prev = line.spans[line.spans.length - 1];
      if (prev && sameStyle(prev, span)) prev.text += text;
      else line.spans.push({ ...span, text });
      line.text += text;
      this.chars += text.length;
      if (rest) this.closeLine(kind);
    }
  }

  private ensureOpen(kind: ChunkKind): ConsoleLine {
    if (!this.open) {
      this.open = { id: this.nextId++, kind, spans: [], text: "" };
      this.lines.push(this.open);
      this.chars += 1;
    }
    return this.open;
  }

  /** Ends the current line (creating an empty one for a bare newline). */
  private closeLine(kind?: ChunkKind) {
    const line = this.open ?? (kind ? this.ensureOpen(kind) : null);
    this.open = null;
    this.pendingCR = false;
    if (line) this.onLine?.(line.text, line.kind);
  }

  /** Completes a trailing partial line (at process exit). */
  flush() {
    if (this.open) this.closeLine();
  }

  private trim() {
    let drop = 0;
    if (this.lines.length > this.maxLines) {
      // Drop in batches so trimming is amortised.
      drop = this.lines.length - this.maxLines + Math.ceil(this.maxLines / 10);
    }
    if (this.maxChars !== null && this.chars > this.maxChars) {
      // Down to 90% of the buffer, never the line still being written.
      let excess = this.chars - Math.floor(this.maxChars * 0.9);
      let n = 0;
      for (const line of this.lines) {
        if (excess <= 0 || line === this.open) break;
        excess -= line.text.length + 1;
        n++;
      }
      drop = Math.max(drop, n);
    }
    if (drop <= 0) return;
    const removed = this.lines.splice(0, drop);
    for (const l of removed) this.chars -= l.text.length + 1;
    this.dropped += drop;
  }

  clear() {
    this.lines = [];
    this.chars = 0;
    this.dropped = 0;
    this.open = null;
    this.pendingCR = false;
  }

  get size() {
    return this.lines.length;
  }

  /** Whole buffer as plain text (copy / export). */
  text(): string {
    return this.lines.map((l) => l.text).join("\n");
  }
}
