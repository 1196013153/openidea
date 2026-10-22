/**
 * Commit graph lanes for the Git log (computed client-side from parents, for
 * commits in topological order, children before parents).
 */

export interface GraphSegment {
  /** Lane at the segment's start (top edge for `up`, node level for `down`). */
  from: number;
  /** Lane at the segment's end (node level for `up`, bottom edge for `down`). */
  to: number;
  color: number;
}

export interface GraphRow {
  /** Lane of the commit's node. */
  lane: number;
  color: number;
  /** Top half of the row: lines entering from the previous row. */
  up: GraphSegment[];
  /** Bottom half: lines leaving towards the next row. */
  down: GraphSegment[];
  /** Number of lane slots this row spans. */
  width: number;
}

interface Lane {
  id: string;
  color: number;
}

export interface GraphState {
  lanes: Array<Lane | null>;
  nextColor: number;
}

export const emptyGraphState = (): GraphState => ({ lanes: [], nextColor: 0 });

const firstFree = (lanes: Array<Lane | null>) => {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
};

/**
 * Lays out `commits` (continuing from `state`, so pages can be appended).
 * Each lane keeps its position while it lives; freed slots are reused.
 */
export function computeGraph(
  commits: ReadonlyArray<{ id: string; parents: readonly string[] }>,
  state: GraphState = emptyGraphState(),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...state.lanes];
  let nextColor = state.nextColor;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const matching: number[] = [];
    lanes.forEach((l, i) => {
      if (l?.id === c.id) matching.push(i);
    });
    let lane: number;
    let color: number;
    if (matching.length) {
      lane = matching[0]!;
      color = lanes[lane]!.color;
    } else {
      lane = firstFree(lanes);
      color = nextColor++;
    }
    const widthBefore = lanes.length;

    const up: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (!l) return;
      up.push({ from: i, to: l.id === c.id ? lane : i, color: l.color });
    });
    for (const m of matching) lanes[m] = null;
    if (lane >= lanes.length) lanes.length = lane + 1;
    lanes[lane] = null;

    const down: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (l) down.push({ from: i, to: i, color: l.color });
    });

    c.parents.forEach((p, k) => {
      // The first parent continues this lane even if another lane also leads to it
      // (both lines then converge at the parent's node, like `git log --graph`).
      if (k === 0) {
        lanes[lane] = { id: p, color };
        down.push({ from: lane, to: lane, color });
        return;
      }
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing >= 0) {
        down.push({ from: lane, to: existing, color: lanes[existing]!.color });
        return;
      }
      const slot = firstFree(lanes);
      const col = nextColor++;
      lanes[slot] = { id: p, color: col };
      down.push({ from: lane, to: slot, color: col });
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const widthAfter = Math.max(0, ...down.map((s) => s.to + 1));
    rows.push({ lane, color, up, down, width: Math.max(widthBefore, widthAfter, lane + 1) });
  }
  return { rows, state: { lanes, nextColor } };
}

/** Lane colours (tokens), cycled by colour index. */
export const LANE_COLORS = [
  "var(--accent)",
  "var(--vcs-added)",
  "var(--vcs-modified)",
  "var(--syn-annotation)",
  "var(--syn-number)",
  "var(--syn-string)",
  "var(--syn-type)",
  "var(--danger)",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;
