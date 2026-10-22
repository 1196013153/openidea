/** Splits a console line's styled spans at link boundaries for rendering. */
import type { Span, SpanStyle } from "./console";
import type { OutputLink } from "./links";

export interface Segment {
  text: string;
  style: SpanStyle;
  link?: OutputLink;
}

export function segmentLine(spans: readonly Span[], links: readonly OutputLink[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  let li = 0;
  for (const span of spans) {
    const { text, ...style } = span;
    let offset = 0;
    while (offset < text.length) {
      const abs = pos + offset;
      while (li < links.length && links[li]!.end <= abs) li++;
      const link = links[li];
      let take: number;
      let current: OutputLink | undefined;
      if (link && link.start <= abs) {
        current = link;
        take = Math.min(text.length - offset, link.end - abs);
      } else {
        take = Math.min(text.length - offset, (link ? link.start : Infinity) - abs);
      }
      const piece = text.slice(offset, offset + take);
      const prev = out[out.length - 1];
      if (prev && prev.link === current && sameStyle(prev.style, style)) prev.text += piece;
      else out.push(current ? { text: piece, style, link: current } : { text: piece, style });
      offset += take;
    }
    pos += text.length;
  }
  return out;
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
