/**
 * Neighbourhood expansion around one mathematician.
 *
 * Two independent directions, each counted in generations: ancestors are your
 * advisor, their advisor, and so on; descendants are your students, their
 * students, and so on. Paths are *pure* — a route never turns around — so
 * nothing appears that the reader cannot predict from the two numbers. An
 * undirected radius, or separate caps on a mixed path, both let a route go up
 * twice and down once to arrive at a first cousin, which nobody can anticipate
 * from a control reading "2 up, 1 down".
 *
 * The two directions are not comparable quantities and must not share a
 * control. Measured on the snapshot, Hilbert has 2 / 6 / 12 / 19 / 30 ancestors
 * at depths 1-5 against 79 / 454 / 2,249 / 8,239 / 20,940 descendants. Across a
 * random sample, ancestors at depth 20 have a median of 114 and a maximum of
 * 296: going up is always cheap, going down explodes at once. So ancestors are
 * admitted in full and only descendants are rationed by the node budget — whole
 * generations at a time, since half a generation would show an arbitrary subset
 * of someone's students as though it were all of them.
 */

import type { Dataset } from './dataset';

export type Direction = 'up' | 'down';

export interface NeighborhoodOptions {
  /** Generations of advisors to include. */
  ancestors: number;
  /** Generations of students to include. */
  descendants: number;
  /** Descendant generations are admitted whole only while the total fits this. */
  nodeBudget: number;
  /** Overflow handles the reader has opened, as `${nodeIndex}:${direction}`. */
  expanded?: ReadonlySet<string>;
  /** Ceiling on how many nodes a single overflow handle may add. */
  expansionBudget?: number;
}

export interface NeighborhoodNode {
  index: number;
  /** Generations from the root, in whichever direction this node lies. */
  depth: number;
  relation: 'root' | 'ancestor' | 'descendant';
}

export interface OverflowHandle {
  key: string;
  source: number;
  direction: Direction;
  hidden: number;
}

export interface Neighborhood {
  root: number;
  nodes: NeighborhoodNode[];
  /** Advisor -> student, for every edge between included nodes. */
  edges: Array<[number, number]>;
  overflows: OverflowHandle[];
  ancestorsReached: number;
  descendantsReached: number;
  requestedDescendants: number;
  /** Nodes the next descendant generation would have added. */
  nextRingSize: number;
  /** True when the budget, not the requested depth, ended the expansion. */
  budgetLimited: boolean;
}

/**
 * Chosen from the data rather than picked: the largest depth-1 neighbourhood in
 * the snapshot is 184 people, so at 200 no one's default view is ever
 * truncated, and past that the depth controls govern.
 */
export const DEFAULT_NODE_BUDGET = 200;
export const DEFAULT_EXPANSION_BUDGET = 50;

/** Going up is cheap enough that the ceiling can be generous. */
export const MAX_ANCESTORS = 12;
/** Going down is not. */
export const MAX_DESCENDANTS = 5;

export function overflowKey(source: number, direction: Direction): string {
  return `${source}:${direction}`;
}

export function neighborhood(
  dataset: Dataset,
  root: number,
  options: NeighborhoodOptions,
): Neighborhood {
  const wantUp = Math.max(0, Math.min(options.ancestors, MAX_ANCESTORS));
  const wantDown = Math.max(0, Math.min(options.descendants, MAX_DESCENDANTS));
  const expanded = options.expanded ?? new Set<string>();
  const expansionBudget = options.expansionBudget ?? DEFAULT_EXPANSION_BUDGET;

  const admitted = new Map<number, NeighborhoodNode>([
    [root, { index: root, depth: 0, relation: 'root' }],
  ]);

  /**
   * Walk one direction a generation at a time, reporting how far it got and,
   * if a generation was refused, how large that generation was.
   */
  const walk = (
    step: (index: number) => Uint32Array,
    limit: number,
    relation: 'ancestor' | 'descendant',
    budget: number,
  ): { reached: number; refused: number } => {
    let frontier = [root];
    let reached = 0;

    for (let generation = 1; generation <= limit && frontier.length > 0; generation++) {
      const ring = new Set<number>();
      for (const index of frontier) {
        for (const neighbour of step(index)) {
          if (!admitted.has(neighbour)) ring.add(neighbour);
        }
      }
      if (ring.size === 0) break;
      if (admitted.size + ring.size > budget) return { reached, refused: ring.size };

      for (const index of ring) {
        admitted.set(index, { index, depth: generation, relation });
      }
      reached = generation;
      frontier = [...ring];
    }
    return { reached, refused: 0 };
  };

  // Ancestors first and in full: they are bounded, and they are the half of the
  // diagram a reader is most likely to have set a deep number for.
  const up = walk((index) => dataset.advisors(index), wantUp, 'ancestor', Number.MAX_SAFE_INTEGER);
  const down = walk((index) => dataset.students(index), wantDown, 'descendant', options.nodeBudget);

  // ------------------------------------------------------------ overflow
  // Handles mark what the budget cut, never what the requested depth excluded:
  // a diagram that reached the depth it was asked for is complete, and hanging
  // "+N" off it would only advertise the next generation, which is what the
  // controls are for.
  const overflows: OverflowHandle[] = [];
  const pendingExpansion: number[] = [];

  if (down.refused > 0) {
    for (const node of admitted.values()) {
      if (node.relation === 'ancestor') continue;
      if (node.depth < down.reached) continue;
      const hiddenNodes = [...dataset.students(node.index)].filter((n) => !admitted.has(n));
      if (hiddenNodes.length === 0) continue;
      const key = overflowKey(node.index, 'down');
      if (expanded.has(key)) pendingExpansion.push(node.index);
      else overflows.push({ key, source: node.index, direction: 'down', hidden: hiddenNodes.length });
    }
  }

  // An opened handle pulls in its students, but only up to the expansion
  // budget — otherwise one click would blow past the limit the generation-by-
  // generation expansion just enforced.
  for (const index of pendingExpansion) {
    const hiddenNodes = [...dataset.students(index)].filter((n) => !admitted.has(n));
    const admitCount = Math.min(hiddenNodes.length, expansionBudget);
    const depth = (admitted.get(index)?.depth ?? 0) + 1;
    for (const neighbour of hiddenNodes.slice(0, admitCount)) {
      admitted.set(neighbour, { index: neighbour, depth, relation: 'descendant' });
    }
    if (hiddenNodes.length > admitCount) {
      overflows.push({
        key: overflowKey(index, 'down'),
        source: index,
        direction: 'down',
        hidden: hiddenNodes.length - admitCount,
      });
    }
  }

  // ------------------------------------------------------------- edges
  // Every edge between admitted nodes is drawn, not only the ones the walk
  // followed. Those extra edges are the point: they are where the genealogy
  // stops being a tree, such as an advisor of both a student and that student's
  // own student.
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
    ancestorsReached: up.reached,
    descendantsReached: down.reached,
    requestedDescendants: wantDown,
    nextRingSize: down.refused,
    budgetLimited: down.refused > 0,
  };
}

/**
 * How many people lie within each generation in one direction, for telling the
 * reader what a deeper setting would cost.
 */
export function directionProfile(
  dataset: Dataset,
  root: number,
  direction: Direction,
  maxDepth: number,
): number[] {
  const step = direction === 'up'
    ? (index: number) => dataset.advisors(index)
    : (index: number) => dataset.students(index);

  const seen = new Set<number>([root]);
  const counts = [0];
  let frontier = [root];

  for (let generation = 1; generation <= maxDepth; generation++) {
    const next: number[] = [];
    for (const index of frontier) {
      for (const neighbour of step(index)) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    counts.push(seen.size - 1);
    frontier = next;
    // Pad, so the caller can index by depth without a bounds check.
    if (next.length === 0) {
      while (counts.length <= maxDepth) counts.push(seen.size - 1);
      break;
    }
  }
  return counts;
}
