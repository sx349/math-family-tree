/**
 * Neighbourhood expansion around one mathematician.
 *
 * "Depth" is a radius in the undirected advisor graph, so depth 1 is exactly a
 * person's advisors and students, depth 2 adds grand-advisors, grand-students,
 * academic siblings and co-advisors, and so on.
 *
 * That radius cannot be used on its own.  Measured on the real data, David
 * Hilbert has 82 nodes at depth 1, 539 at depth 2, 2,756 at depth 3 and 10,812
 * at depth 4 — unreadable as a diagram and slow to lay out.  So expansion is
 * governed by a node budget: rings are admitted whole while they fit, and the
 * first ring that would overflow is left out entirely and summarised as "+N
 * more" handles on the nodes it would have hung from.  The result is that a
 * requested depth of 5 may resolve to an effective depth of 2 for Hilbert and a
 * full 5 for someone with a sparser lineage, without the user having to know in
 * advance which they are looking at.
 */

import type { Dataset } from './dataset';

export type Direction = 'up' | 'down';

export interface NeighborhoodOptions {
  depth: number;
  /** Rings are admitted whole only while the total stays within this. */
  nodeBudget: number;
  /** Cap on parent-steps along any path; defaults to `depth`. */
  maxUp?: number;
  /** Cap on child-steps along any path; defaults to `depth`. */
  maxDown?: number;
  /** Overflow handles the user has opened, as `${nodeIndex}:${direction}`. */
  expanded?: ReadonlySet<string>;
  /** Ceiling on how many nodes a single overflow handle may add. */
  expansionBudget?: number;
}

export interface NeighborhoodNode {
  index: number;
  /** Hops from the root in the undirected graph. */
  depth: number;
  /** Whether the shortest route to this node went up, down, or both. */
  relation: 'root' | 'ancestor' | 'descendant' | 'relative';
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
  /** Depth actually reached before the budget stopped expansion. */
  depthReached: number;
  requestedDepth: number;
  /** Nodes the next ring would have added, for "depth N would show X". */
  nextRingSize: number;
  /** True when the budget, not the requested depth, ended the expansion. */
  budgetLimited: boolean;
}

/**
 * Chosen from the data rather than picked: the largest depth-1 neighbourhood in
 * the snapshot is 184 people, so at 200 no one's default view is ever
 * truncated, and beyond depth 1 the depth control governs. At 150 exactly one
 * person's opening diagram came up short without any way to tell.
 */
export const DEFAULT_NODE_BUDGET = 200;
export const DEFAULT_EXPANSION_BUDGET = 50;
export const MAX_DEPTH = 5;

export function overflowKey(source: number, direction: Direction): string {
  return `${source}:${direction}`;
}

/**
 * Expand the neighbourhood of `root`.
 *
 * Paths are tracked as (node, up-steps used); down-steps are implied by the hop
 * count, which keeps the separate up/down caps exact without the cost of a full
 * Pareto frontier per node.
 */
export function neighborhood(
  dataset: Dataset,
  root: number,
  options: NeighborhoodOptions,
): Neighborhood {
  const depth = Math.max(0, Math.min(options.depth, MAX_DEPTH));
  const maxUp = options.maxUp ?? depth;
  const maxDown = options.maxDown ?? depth;
  const expanded = options.expanded ?? new Set<string>();
  const expansionBudget = options.expansionBudget ?? DEFAULT_EXPANSION_BUDGET;

  // For each admitted node: the set of up-step counts it has been reached with,
  // as a bitmask. A node is worth revisiting only via a path that used a
  // different number of up-steps, since that may unlock further movement.
  const seenUpMasks = new Map<number, number>();
  const admitted = new Map<number, NeighborhoodNode>();

  const relationOf = (up: number, down: number): NeighborhoodNode['relation'] => {
    if (up === 0 && down === 0) return 'root';
    if (down === 0) return 'ancestor';
    if (up === 0) return 'descendant';
    return 'relative';
  };

  admitted.set(root, { index: root, depth: 0, relation: 'root' });
  seenUpMasks.set(root, 1);

  let frontier: Array<{ index: number; up: number }> = [{ index: root, up: 0 }];
  let depthReached = 0;
  let nextRingSize = 0;
  let budgetLimited = false;

  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    // Candidates reached at this hop, each with the fewest up-steps found.
    const ring = new Map<number, number>();

    const reach = (neighbour: number, upSteps: number): void => {
      if (upSteps > maxUp || hop - upSteps > maxDown) return;
      if ((seenUpMasks.get(neighbour) ?? 0) & (1 << upSteps)) return;
      const best = ring.get(neighbour);
      if (best === undefined || upSteps < best) ring.set(neighbour, upSteps);
    };

    for (const { index, up } of frontier) {
      for (const advisor of dataset.advisors(index)) reach(advisor, up + 1);
      for (const student of dataset.students(index)) reach(student, up);
    }

    // Nodes already on the diagram are not new arrivals, but reaching one by a
    // route that spent fewer up-steps can unlock moves the first route could
    // not afford, so they re-enter the frontier without counting against the
    // budget. The up-step bitmask bounds how often that can happen.
    const arrivals: Array<{ index: number; up: number }> = [];
    const newcomers = new Map<number, number>();
    for (const [index, up] of ring) {
      if (admitted.has(index)) arrivals.push({ index, up });
      else newcomers.set(index, up);
    }

    // The budget is checked per ring rather than per node: admitting half a
    // generation would produce a diagram that misrepresents the data by showing
    // an arbitrary subset of someone's students as if it were all of them.
    if (newcomers.size > 0 && admitted.size + newcomers.size > options.nodeBudget) {
      nextRingSize = newcomers.size;
      budgetLimited = true;
      break;
    }

    for (const [index, up] of newcomers) {
      admitted.set(index, { index, depth: hop, relation: relationOf(up, hop - up) });
      arrivals.push({ index, up });
    }
    for (const { index, up } of arrivals) {
      seenUpMasks.set(index, (seenUpMasks.get(index) ?? 0) | (1 << up));
    }
    if (newcomers.size > 0) depthReached = hop;
    frontier = arrivals;
  }

  // ------------------------------------------------------------ overflow
  // Handles mark what the *budget* cut, not what the requested depth excluded.
  // A diagram that reached the depth it was asked for is complete, and hanging
  // "+N" off its outer nodes would only advertise the next generation — which
  // is what the depth control is for. They appear on the outermost ring, and
  // only when a ring was actually refused.
  const overflows: OverflowHandle[] = [];
  const pendingExpansion: Array<{ index: number; direction: Direction }> = [];

  const collectOverflow = (index: number, direction: Direction): void => {
    if (!budgetLimited) return;
    if ((admitted.get(index)?.depth ?? 0) < depthReached) return;
    const neighbours = direction === 'up' ? dataset.advisors(index) : dataset.students(index);
    let hidden = 0;
    for (const neighbour of neighbours) if (!admitted.has(neighbour)) hidden++;
    if (hidden === 0) return;
    const key = overflowKey(index, direction);
    if (expanded.has(key)) pendingExpansion.push({ index, direction });
    else overflows.push({ key, source: index, direction, hidden });
  };

  for (const index of [...admitted.keys()]) {
    collectOverflow(index, 'up');
    collectOverflow(index, 'down');
  }

  // Opened handles pull in their neighbours, but only up to the expansion
  // budget — otherwise one click on Hilbert's "+79 more" would blow past every
  // limit the ring-by-ring expansion just enforced.
  for (const { index, direction } of pendingExpansion) {
    const neighbours = direction === 'up' ? dataset.advisors(index) : dataset.students(index);
    const hiddenNodes = [...neighbours].filter((n) => !admitted.has(n));
    const admitCount = Math.min(hiddenNodes.length, expansionBudget);
    const parentDepth = admitted.get(index)!.depth;
    for (const neighbour of hiddenNodes.slice(0, admitCount)) {
      admitted.set(neighbour, {
        index: neighbour,
        depth: parentDepth + 1,
        relation: direction === 'up' ? 'ancestor' : 'descendant',
      });
    }
    if (hiddenNodes.length > admitCount) {
      overflows.push({
        key: overflowKey(index, direction),
        source: index,
        direction,
        hidden: hiddenNodes.length - admitCount,
      });
    }
  }

  // ------------------------------------------------------------- edges
  // Every edge between admitted nodes is drawn, not just the ones BFS traversed.
  // Those extra edges are the point: they are where the genealogy stops being a
  // tree, e.g. an advisor of both a student and that student's own student.
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
    depthReached,
    requestedDepth: depth,
    nextRingSize,
    budgetLimited,
  };
}

/**
 * Node counts per depth, for telling the user what a deeper setting would cost.
 */
export function depthProfile(dataset: Dataset, root: number, maxDepth = MAX_DEPTH): number[] {
  const seen = new Set<number>([root]);
  const counts = [1];
  let frontier = [root];

  for (let hop = 1; hop <= maxDepth; hop++) {
    const next: number[] = [];
    for (const index of frontier) {
      for (const advisor of dataset.advisors(index)) {
        if (!seen.has(advisor)) { seen.add(advisor); next.push(advisor); }
      }
      for (const student of dataset.students(index)) {
        if (!seen.has(student)) { seen.add(student); next.push(student); }
      }
    }
    counts.push(seen.size);
    frontier = next;
    if (next.length === 0) break;
  }
  return counts;
}
