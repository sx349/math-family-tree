/**
 * Lowest common ancestors on the advisor DAG.
 *
 * On a tree "the LCA" is a single node.  This graph is not a tree: 55,201 people
 * have two advisors, 5,112 have three, and one person can be both the advisor of
 * another and the advisor of that person's student.  Two consequences drive the
 * design here:
 *
 *  - There can be several *incomparable* lowest common ancestors, none of which
 *    is below the others.  Reporting only one would hide real structure, so all
 *    minimal common ancestors are returned.
 *
 *  - Mathematicians from unrelated traditions genuinely share no ancestor within
 *    any sane depth limit.  Rather than reporting "no result" for the whole
 *    query, the selected people are partitioned into groups that do share
 *    ancestry, and each group is solved separately — so the answer is a forest,
 *    not a tree.
 *
 * Ancestor sets are small in practice (median 208, p90 288, max 429 at depth 30
 * across a random sample), which is why the straightforward set-intersection
 * approach is fast enough to run on every keystroke.
 */

import type { Dataset } from './dataset';

export const DEFAULT_MAX_DEPTH = 30;
export const MAX_TARGETS = 5;

export interface LcaGroup {
  /** The queried people in this group. */
  targets: number[];
  /** Minimal common ancestors: none is an ancestor of another. */
  ancestors: number[];
  /** Every node on a shortest path from an ancestor down to a target. */
  nodes: number[];
  /** Advisor -> student, restricted to `nodes`. */
  edges: Array<[number, number]>;
  /** Per ancestor, the hop count down to each target, aligned with `targets`. */
  distances: Array<{ ancestor: number; hops: number[] }>;
  /**
   * Per node in `nodes`, the hop count to its farthest target — 0 at a target
   * itself, and otherwise one more than the tallest of its children in the
   * drawn subgraph. Two nodes both labelled "lowest" can still sit at
   * different depths in the tree below them; this says how much.
   */
  heights: Map<number, number>;
}

export interface LcaResult {
  groups: LcaGroup[];
  /** Queried people who share no ancestor with any other selection. */
  isolated: number[];
  maxDepth: number;
  /** True when a deeper limit could have joined groups that are separate here. */
  depthLimited: boolean;
}

/** Distance from `start` up to each of its ancestors, including itself at 0. */
export function ancestorDistances(
  dataset: Dataset,
  start: number,
  maxDepth: number,
): Map<number, number> {
  const distances = new Map<number, number>([[start, 0]]);
  let frontier = [start];

  for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const index of frontier) {
      for (const advisor of dataset.advisors(index)) {
        if (!distances.has(advisor)) {
          distances.set(advisor, hop);
          next.push(advisor);
        }
      }
    }
    frontier = next;
  }
  return distances;
}

/**
 * Keep only the *lowest* common ancestors.
 *
 * A common ancestor is not lowest if another common ancestor sits below it —
 * i.e. if it is itself an ancestor of another candidate. Discarding those
 * leaves the antichain of minimal elements.
 */
function minimalAncestors(
  dataset: Dataset,
  common: Set<number>,
  maxDepth: number,
): number[] {
  const superseded = new Set<number>();
  for (const candidate of common) {
    for (const [ancestor, hops] of ancestorDistances(dataset, candidate, maxDepth)) {
      if (hops > 0 && common.has(ancestor)) superseded.add(ancestor);
    }
  }
  return [...common].filter((index) => !superseded.has(index));
}

/**
 * Nodes on any shortest path from `ancestor` down to `target`.
 *
 * Walks down from the ancestor, keeping only steps that strictly close the
 * remaining distance to the target. Because `distances` holds the up-distance
 * from the target, a child is on a shortest path exactly when its distance is
 * one less than its parent's.
 */
function pathNodes(
  dataset: Dataset,
  ancestor: number,
  distances: Map<number, number>,
  into: Set<number>,
): void {
  const remaining = distances.get(ancestor);
  if (remaining === undefined) return;

  into.add(ancestor);
  let frontier = [ancestor];
  for (let hop = remaining; hop > 0; hop--) {
    // A Set, not a filter on `!into.has`: another target's path may already
    // have added this node (paths converge before a common ancestor and
    // diverge after), and skipping it here would break *this* path in two
    // without the node itself ever being missing from `into`.
    const next = new Set<number>();
    for (const index of frontier) {
      for (const student of dataset.students(index)) {
        if (distances.get(student) === hop - 1) next.add(student);
      }
    }
    for (const student of next) into.add(student);
    frontier = [...next];
  }
}

/** Partition targets into groups that share at least one ancestor. */
function groupBySharedAncestry(
  targets: number[],
  ancestries: Map<number, number>[],
): number[][] {
  // Union-find over the targets; two targets join when their ancestor sets meet.
  const parent = targets.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let a = 0; a < targets.length; a++) {
    for (let b = a + 1; b < targets.length; b++) {
      const [small, large] =
        ancestries[a].size < ancestries[b].size ? [ancestries[a], ancestries[b]] : [ancestries[b], ancestries[a]];
      for (const index of small.keys()) {
        if (large.has(index)) {
          parent[find(a)] = find(b);
          break;
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  targets.forEach((target, i) => {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(target);
  });
  return [...groups.values()];
}

export function lowestCommonAncestors(
  dataset: Dataset,
  targets: number[],
  maxDepth: number = DEFAULT_MAX_DEPTH,
): LcaResult {
  const unique = [...new Set(targets)].slice(0, MAX_TARGETS);
  if (unique.length === 0) {
    return { groups: [], isolated: [], maxDepth, depthLimited: false };
  }
  if (unique.length === 1) {
    return {
      groups: [],
      isolated: unique,
      maxDepth,
      depthLimited: false,
    };
  }

  const ancestries = unique.map((target) => ancestorDistances(dataset, target, maxDepth));
  const partitions = groupBySharedAncestry(unique, ancestries);

  const groups: LcaGroup[] = [];
  const isolated: number[] = [];

  for (const members of partitions) {
    if (members.length < 2) {
      isolated.push(...members);
      continue;
    }

    const memberAncestries = members.map((m) => ancestries[unique.indexOf(m)]);
    let common = new Set<number>(memberAncestries[0].keys());
    for (const ancestry of memberAncestries.slice(1)) {
      common = new Set([...common].filter((index) => ancestry.has(index)));
    }

    const ancestors = minimalAncestors(dataset, common, maxDepth);
    const nodes = new Set<number>(members);
    for (const ancestor of ancestors) {
      memberAncestries.forEach((ancestry) => pathNodes(dataset, ancestor, ancestry, nodes));
    }

    const edges: Array<[number, number]> = [];
    for (const index of nodes) {
      for (const student of dataset.students(index)) {
        if (nodes.has(student)) edges.push([index, student]);
      }
    }

    // A node's height is its distance to whichever member is farthest below
    // it — the same number the recursive "max(child) + 1" walk down the
    // subgraph would produce, but read directly off the up-distances already
    // computed for each member, since those are exactly the shortest-path
    // lengths the subgraph's edges were built from.
    const heights = new Map<number, number>();
    for (const index of nodes) {
      let height = 0;
      for (const ancestry of memberAncestries) {
        const hop = ancestry.get(index);
        if (hop !== undefined && hop > height) height = hop;
      }
      heights.set(index, height);
    }

    groups.push({
      targets: members,
      // Nearest first, by total distance to the selected people.
      ancestors: ancestors.sort(
        (a, b) =>
          memberAncestries.reduce((sum, m) => sum + (m.get(a) ?? 0), 0) -
          memberAncestries.reduce((sum, m) => sum + (m.get(b) ?? 0), 0),
      ),
      nodes: [...nodes],
      edges,
      distances: ancestors.map((ancestor) => ({
        ancestor,
        hops: memberAncestries.map((ancestry) => ancestry.get(ancestor) ?? -1),
      })),
      heights,
    });
  }

  return {
    groups,
    isolated,
    maxDepth,
    // More than one component means a deeper search might have joined them.
    depthLimited: groups.length + isolated.length > 1,
  };
}
