// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { columnModeExtension, extendBlock, isColumnMode, toggleColumnMode } from "./columnMode";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function make(doc: string, at: number) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [columnModeExtension, EditorState.allowMultipleSelections.of(true)],
    }),
    parent: document.body,
  });
  return view;
}

const ranges = (v: EditorView) => v.state.selection.ranges.map((r) => [r.anchor, r.head]);

describe("Column Selection Mode", () => {
  it("toggles per editor", () => {
    const v = make("abc", 0);
    expect(isColumnMode(v.state)).toBe(false);
    toggleColumnMode(v);
    expect(isColumnMode(v.state)).toBe(true);
    expect(v.dom.classList.contains("cm-openidea-columnMode")).toBe(true);
    toggleColumnMode(v);
    expect(isColumnMode(v.state)).toBe(false);
  });

  it("⇧+arrows are left alone while the mode is off", () => {
    const v = make("abcd\nefgh", 1);
    expect(extendBlock(v, 1, 0)).toBe(false);
  });

  it("⇧↓ / ⇧→ build a block selection, clamped to short lines", () => {
    const v = make("abcd\nef\nijkl", 1);
    toggleColumnMode(v);
    extendBlock(v, 1, 0);
    extendBlock(v, 1, 0);
    extendBlock(v, 0, 1);
    extendBlock(v, 0, 1);
    // Lines start at 0, 5, 8; columns 1..3.
    expect(ranges(v)).toEqual([
      [1, 3],
      [6, 7],
      [9, 11],
    ]);
    extendBlock(v, -1, 0);
    expect(ranges(v)).toEqual([
      [1, 3],
      [6, 7],
    ]);
  });
});
