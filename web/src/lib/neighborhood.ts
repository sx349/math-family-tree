/**
 * Two views of the graph around one mathematician.
 *
 * Neighbourhood asks how someone sits among the people around them — an
 * Erdős-number-style radius. The graph is walked as undirected: a route may
 * go up and then down (or down and then up), so a depth-2 neighbourhood shows
 * not just grandparents and grandchildren but also an advisor's other
 * students, a student's other advisors, and so on. Depth is spent identically
 * in every direction; there is one control because there is one question.
 *
 * Lineage asks who someone descends from, which is a single direction and
 * goes much further. It gets its own function because mixing the two
 * questions into one control makes neither answer the reader's question.
 *
 * Both walks admit whole generations at a time, subject to a node budget —
 * half a generation would show an arbitrary subset of, say, someone's
 * students as though it were all of them. A generation the budget refuses
 * leaves "+N" overflow handles on whichever admitted nodes have neighbours
 * still outside the drawing, openable one at a time up to their own smaller
 * budget so a single click cannot blow past the limit the walk just enforced.
 */

import type { Dataset } from './dataset';

export type Direction = 'up' | 'down';
export type Relation = 'root' | 'ancestor' | 'descendant' | 'relative';

export interface OverflowHandle {
  key: string;
  source: number;
  direction: Direction;
  hidden: number;
}

/**
 * Chosen from the data rather than picked: the largest depth-1 neighbourhood in
 * the snapshot is 184 people, so at 200 no one's default view is ever
 * truncated, and past that the depth control governs.
 */
export const DEFAULT_NODE_BUDGET = 200;
export const DEFAULT_EXPANSION_BUDGET = 50;

/** The neighbourhood's one ceiling, spent identically in every direction. */
export const MAX_DEPTH = 5;

/**
 * The lineage view goes much further up than the neighbourhood one, but not
 * indefinitely. A median lineage in the snapshot runs 36 generations and 220
 * people, which draws as a column far taller than it is wide and stops being
 * readable long before it runs out.
 *
 * Ten, not twenty, because of what twenty costs on screen. Dagre ranks by
 * longest path, so twenty requested generations became about forty-five drawn
 * ranks — Deng's stood 4,969px high on a desktop and 8,796px on a phone, more
 * than any plate can hold, and the reader saw half a diagram with no way to
 * tell. At ten every case measured fits whole on both.
 */
export const MAX_LINEAGE = 10;
export const DEFAULT_LINEAGE = 8;

/**
 * Lineage gets its own budget, because the neighbourhood one governed a view it
 * was never measured for: at 200 it cut 68,890 people short of the depth their
 * slider asked for, and a diagram that disagrees with its own label is worse
 * than a shallow one.
 *
 * At the ten-generation ceiling nobody comes near this. Over all 307,559 people
 * with an advisor, ten generations up reaches a median of 19 and a maximum of
 * 160 — Lekshmi Dharmarajan's. So this is a backstop against a future snapshot
 * or a raised ceiling, not a limit any reader meets, and the generation count
 * is the only thing governing what the view shows.
 */
export const LINEAGE_NODE_BUDGET = 500;

export function overflowKey(source: number, direction: Direction): string {
  return `${source}:${direction}`;
}

// -------------------------------------------------------------- neighborhood

export interface NeighborhoodOptions {
  /** Radius to walk, spent identically up and down. */
  depth: number;
  /** A generation is admitted whole only while the total fits this. */
  nodeBudget: number;
  /** Overflow handles the reader has opened, as `${nodeIndex}:${direction}`. */
  expanded?: ReadonlySet<string>;
  /** Ceiling on how many nodes a single overflow handle may add. */
  expansionBudget?: number;
}

export interface NeighborhoodNode {
  index: number;
  /** Undirected hop count from the root. */
  depth: number;
  /**
   * 'ancestor'/'descendant' when some shortest path to this node never turns
   * around; 'relative' when every shortest path does (a sibling reached via
   * a shared advisor, a cousin, and so on).
   */
  relation: Relation;
}

export interface Neighborhood {
  root: number;
  nodes: NeighborhoodNode[];
  /** Advisor -> student, for every edge between included nodes. */
  edges: Array<[number, number]>;
  overflows: OverflowHandle[];
  /** Generations actually reached, whole. */
  reached: number;
  /** Nodes the next generation would have added. */
  nextRingSize: number;
  /** True when the budget, not the requested depth, ended the expansion. */
  budgetLimited: boolean;
}

/** Upgrade a candidate's classification, preferring a pure direction over 'relative'. */
function upgrade(map: Map<number, Relation>, key: number, candidate: Relation): void {
  const current = map.get(key);
  if (current === undefined || current === 'relative') map.set(key, candidate);
}

export function neighborhood(dataset: Dataset, root: number, options: NeighborhoodOptions): Neighborhood {
  const wantDepth = Math.max(0, Math.min(options.depth, MAX_DEPTH));
  const expanded = options.expanded ?? new Set<string>();
  const expansionBudget = options.expansionBudget ?? DEFAULT_EXPANSION_BUDGET;

  const admitted = new Map<number, NeighborhoodNode>([[root, { index: root, depth: 0, relation: 'root' }]]);

  let frontier = [root];
  let reached = 0;
  let nextRingSize = 0;

  for (let generation = 1; generation <= wantDepth && frontier.length > 0; generation++) {
    // Classification is decided the moment a node is first admitted, from
    // whichever frontier member reaches it by the "purest" edge: a node found
    // only through advisor edges from the root (or from another pure
    // ancestor) is still a pure ancestor; the same for students. Anything
    // that requires a turn — reached only via a mix, or only from a 'relative'
    // — is a relative.
    const ring = new Map<number, Relation>();
    for (const index of frontier) {
      const parent = admitted.get(index)!.relation;
      for (const advisor of dataset.advisors(index)) {
        if (admitted.has(advisor)) continue;
        upgrade(ring, advisor, parent === 'root' || parent === 'ancestor' ? 'ancestor' : 'relative');
      }
      for (const student of dataset.students(index)) {
        if (admitted.has(student)) continue;
        upgrade(ring, student, parent === 'root' || parent === 'descendant' ? 'descendant' : 'relative');
      }
    }
    if (ring.size === 0) break;
    if (admitted.size + ring.size > options.nodeBudget) {
      nextRingSize = ring.size;
      break;
    }

    for (const [index, relation] of ring) admitted.set(index, { index, depth: generation, relation });
    reached = generation;
    frontier = [...ring.keys()];
  }

  // ------------------------------------------------------------ overflow
  // Handles mark what the budget cut, never what the requested depth
  // excluded: a diagram that reached the depth it was asked for is complete,
  // and hanging "+N" off it would only advertise the next generation, which
  // is what the control is for. Only the boundary generation can have hidden
  // neighbours — an interior node's neighbours were always admitted or
  // refused together with the rest of their generation.
  const overflows: OverflowHandle[] = [];
  const pendingExpansion: Array<{ index: number; direction: Direction }> = [];

  if (nextRingSize > 0) {
    for (const node of admitted.values()) {
      if (node.depth !== reached) continue;
      const hiddenUp = [...dataset.advisors(node.index)].filter((n) => !admitted.has(n));
      const hiddenDown = [...dataset.students(node.index)].filter((n) => !admitted.has(n));
      for (const [direction, hidden] of [
        ['up', hiddenUp],
        ['down', hiddenDown],
      ] as const) {
        if (hidden.length === 0) continue;
        const key = overflowKey(node.index, direction);
        if (expanded.has(key)) pendingExpansion.push({ index: node.index, direction });
        else overflows.push({ key, source: node.index, direction, hidden: hidden.length });
      }
    }
  }

  // An opened handle pulls in its neighbours in that one direction, but only
  // up to the expansion budget — otherwise one click would blow past the
  // limit the generation-by-generation walk just enforced.
  for (const { index, direction } of pendingExpansion) {
    const source = admitted.get(index)!;
    const candidates = direction === 'up' ? dataset.advisors(index) : dataset.students(index);
    const hidden = [...candidates].filter((n) => !admitted.has(n));
    const admitCount = Math.min(hidden.length, expansionBudget);
    const depth = source.depth + 1;
    const relation: Relation =
      direction === 'up'
        ? source.relation === 'root' || source.relation === 'ancestor'
          ? 'ancestor'
          : 'relative'
        : source.relation === 'root' || source.relation === 'descendant'
          ? 'descendant'
          : 'relative';
    for (const neighbour of hidden.slice(0, admitCount)) {
      admitted.set(neighbour, { index: neighbour, depth, relation });
    }
    if (hidden.length > admitCount) {
      overflows.push({ key: overflowKey(index, direction), source: index, direction, hidden: hidden.length - admitCount });
    }
  }

  // ------------------------------------------------------------- edges
  // Every edge between admitted nodes is drawn, not only the ones the walk
  // followed. Those extra edges are the point: they are where the genealogy
  // stops being a tree, such as an advisor of both a student and that
  // student's own student.
  const edges: Array<[number, number]> = [];
  for (const index of admitted.keys()) {
    for (const student of dataset.students(index)) {
      if (admitted.has(student)) edges.push([index, student]);
    }
  }

  return {
    root,
    nodes: [...admitted.values()].sort((a, b) => a.depth - b.depth || a.index - b.index),
    edges,
    overflows: overflows.sort((a, b) => b.hidden - a.hidden),
    reached,
    nextRingSize,
    budgetLimited: nextRingSize > 0,
  };
}

// ------------------------------------------------------------------ lineage

export interface LineageOptions {
  /** Generations of advisors to include. */
  generations: number;
  /** Generations are admitted whole only while the total fits this. */
  nodeBudget: number;
}

export interface LineageNode {
  index: number;
  /** Generations above the root. */
  depth: number;
}

export interface Lineage {
  root: number;
  nodes: LineageNode[];
  /** Advisor -> student, for every edge between included nodes. */
  edges: Array<[number, number]>;
  /** Generations actually reached, whole. */
  reached: number;
  /** Nodes the next generation would have added. */
  nextRingSize: number;
  /** True when the budget, not the requested depth, ended the expansion. */
  budgetLimited: boolean;
}

export function lineage(dataset: Dataset, root: number, options: LineageOptions): Lineage {
  const wantUp = Math.max(0, Math.min(options.generations, MAX_LINEAGE));
  const admitted = new Map<number, LineageNode>([[root, { index: root, depth: 0 }]]);

  let frontier = [root];
  let reached = 0;
  let nextRingSize = 0;

  for (let generation = 1; generation <= wantUp && frontier.length > 0; generation++) {
    const ring = new Set<number>();
    for (const index of frontier) {
      for (const advisor of dataset.advisors(index)) {
        if (!admitted.has(advisor)) ring.add(advisor);
      }
    }
    if (ring.size === 0) break;
    if (admitted.size + ring.size > options.nodeBudget) {
      nextRingSize = ring.size;
      break;
    }

    for (const index of ring) admitted.set(index, { index, depth: generation });
    reached = generation;
    frontier = [...ring];
  }

  const edges: Array<[number, number]> = [];
  for (const index of admitted.keys()) {
    for (const student of dataset.students(index)) {
      if (admitted.has(student)) edges.push([index, student]);
    }
  }

  return {
    root,
    nodes: [...admitted.values()].sort((a, b) => a.depth - b.depth || a.index - b.index),
    edges,
    reached,
    nextRingSize,
    budgetLimited: nextRingSize > 0,
  };
}
