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

export interface LcaEdge {
  from: number;
  to: number;
  /**
   * Which selected person's shortest path to an ancestor actually runs
   * through this edge, as an index into the full up-to-`MAX_TARGETS`
   * selection passed to `lowestCommonAncestors` — not into this group's own
   * `targets`, which is only ever a subset renumbered from zero. Keeping the
   * index global means the same person gets the same index in every group of
   * a forest. Empty when the edge merely connects two admitted nodes without
   * lying on any tracked path — real structure worth drawing, but not part
   * of the answer to "how does X connect to the ancestor" for any particular
   * X.
   */
  owners: number[];
}

export interface LcaGroup {
  /** The queried people in this group. */
  targets: number[];
  /** Minimal common ancestors: none is an ancestor of another. */
  ancestors: number[];
  /** Every node on a shortest path from an ancestor down to a target. */
  nodes: number[];
  /** Advisor -> student, restricted to `nodes`. */
  edges: LcaEdge[];
  /** Per ancestor, the hop count down to each target, aligned with `targets`. */
  distances: Array<{ ancestor: number; hops: number[] }>;
  /**
   * Per node in `nodes`, the hop count to its farthest target — 0 at a target
   * itself, and otherwise one more than the tallest of its children in the
   * drawn subgraph. Two nodes both labelled "lowest" can still sit at
   * different depths in the tree below them; this says how much.
   */
  heights: Map<number, number>;
  /**
   * Per node in `nodes`, the union of its incident edges' `owners` — derived
   * from `edges` rather than tracked separately, so a node's colour can never
   * disagree with the lines actually touching it. Empty for a node with no
   * owned edges at all (in practice, only ever an ancestor itself).
   */
  nodeOwners: Map<number, number[]>;
}

export interface LcaResult {
  groups: LcaGroup[];
  /** Queried people who share no ancestor with any other selection. */
  isolated: number[];
  maxDepth: number;
  /** True when a deeper limit could have joined groups that are separate here. */
  depthLimited: boolean;
}

export interface AncestorGraph {
  /** Distance from `start` up to each ancestor, including itself at 0. */
  distances: Map<number, number>;
  /** Every real advisor -> student edge that lies on some shortest path up from `start`. */
  edges: Array<[advisor: number, student: number]>;
}

/**
 * Distances from `start` up to each of its ancestors, together with every
 * real edge that lies on some shortest path to get there — computed in one
 * pass, using only `advisors` throughout (never `students`, a separately
 * stored adjacency list that isn't guaranteed to agree with it edge for
 * edge). A node can legitimately have several parents at once, all equally
 * short; this keeps every one of those tied advisors as it goes, since by
 * the time a hop's frontier is fully processed, every node discovered at
 * that hop already has its final distance, so a later same-hop advisor is
 * exactly as valid a parent as the first one that reached it.
 */
export function ancestorGraph(dataset: Dataset, start: number, maxDepth: number): AncestorGraph {
  const distances = new Map<number, number>([[start, 0]]);
  const edges: Array<[number, number]> = [];
  let frontier = [start];

  for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const index of frontier) {
      for (const advisor of dataset.advisors(index)) {
        const existing = distances.get(advisor);
        if (existing === undefined) {
          distances.set(advisor, hop);
          edges.push([advisor, index]);
          next.push(advisor);
        } else if (existing === hop) {
          edges.push([advisor, index]);
        }
        // existing < hop: `advisor` has a strictly shorter route elsewhere,
        // so this particular edge isn't on any shortest path to it.
      }
    }
    frontier = next;
  }
  return { distances, edges };
}

/** Distance from `start` up to each of its ancestors, including itself at 0. */
export function ancestorDistances(dataset: Dataset, start: number, maxDepth: number): Map<number, number> {
  return ancestorGraph(dataset, start, maxDepth).distances;
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

  const graphs = unique.map((target) => ancestorGraph(dataset, target, maxDepth));
  const ancestries = graphs.map((graph) => graph.distances);
  const partitions = groupBySharedAncestry(unique, ancestries);

  const groups: LcaGroup[] = [];
  const isolated: number[] = [];

  for (const members of partitions) {
    if (members.length < 2) {
      isolated.push(...members);
      continue;
    }

    const memberAncestries = members.map((m) => ancestries[unique.indexOf(m)]);
    const memberGraphs = members.map((m) => graphs[unique.indexOf(m)]);
    let common = new Set<number>(memberAncestries[0].keys());
    for (const ancestry of memberAncestries.slice(1)) {
      common = new Set([...common].filter((index) => ancestry.has(index)));
    }

    const ancestors = minimalAncestors(dataset, common, maxDepth);

    // Which selected people (as global indices into `unique`) can really
    // reach each node — straight off each member's own distance map. This is
    // real ancestry, not restricted to any one member's *shortest* route, so
    // it credits a node correctly even when a member reaches it by a route
    // that happens to be someone else's shortest path rather than their own.
    const reach = new Map<number, Set<number>>();
    memberAncestries.forEach((ancestry, i) => {
      const member = unique.indexOf(members[i]);
      for (const node of ancestry.keys()) {
        let owners = reach.get(node);
        if (!owners) {
          owners = new Set();
          reach.set(node, owners);
        }
        owners.add(member);
      }
    });

    // Walk down from each ancestor through each member's own shortest-path
    // edges separately, exactly as the tree itself is defined — one
    // member's walk never borrows another's edge to press on somewhere
    // their own shortest route wouldn't otherwise reach. Mazurkiewicz
    // advising both Rajchman and Rajchman's own student Zygmund is real
    // too, but it's a same-level shortcut no member's shortest route to an
    // ancestor ever needs, so it never enters `graph.edges` in the first
    // place and stays out of this diagram the same way curveShortcutEdges'
    // shortcuts stay out of it, for the same reason: real, but not what
    // "lowest" is answering.
    //
    // Every edge discovered this way is coloured by real `reach` rather
    // than by which member's walk happened to discover it — an edge two
    // people are both really descended from is both of theirs to own, even
    // if only one of them needed it for their own shortest route and the
    // other reaches it by a separate route of their own that ties it at
    // the same distance.
    const nodes = new Set<number>(members);
    const edgeSeen = new Set<string>();
    const edges: LcaEdge[] = [];
    memberGraphs.forEach((graph) => {
      const childrenOf = new Map<number, number[]>();
      for (const [advisor, student] of graph.edges) {
        const list = childrenOf.get(advisor);
        if (list) list.push(student);
        else childrenOf.set(advisor, [student]);
      }

      for (const ancestor of ancestors) {
        if (!graph.distances.has(ancestor)) continue;
        nodes.add(ancestor);
        const seen = new Set<number>([ancestor]);
        let frontier = [ancestor];
        while (frontier.length > 0) {
          const next: number[] = [];
          for (const parent of frontier) {
            for (const child of childrenOf.get(parent) ?? []) {
              nodes.add(child);
              const key = `${parent}:${child}`;
              if (!edgeSeen.has(key)) {
                edgeSeen.add(key);
                const owners = [...(reach.get(child) ?? [])].sort((a, b) => a - b);
                edges.push({ from: parent, to: child, owners });
              }
              if (!seen.has(child)) {
                seen.add(child);
                next.push(child);
              }
            }
          }
          frontier = next;
        }
      }
    });

    const nodeOwnerSets = new Map<number, Set<number>>();
    for (const edge of edges) {
      for (const endpoint of [edge.from, edge.to]) {
        let set = nodeOwnerSets.get(endpoint);
        if (!set) {
          set = new Set();
          nodeOwnerSets.set(endpoint, set);
        }
        for (const owner of edge.owners) set.add(owner);
      }
    }
    const nodeOwners = new Map<number, number[]>();
    for (const index of nodes) {
      nodeOwners.set(index, [...(nodeOwnerSets.get(index) ?? [])].sort((a, b) => a - b));
    }

    // A node's height is its distance to whichever member is farthest below
    // it, computed as the actual recursive "max(child height) + 1" walk down
    // the diagram's own kept edges. Reading it off each member's independent
    // up-distance instead — which is what this used to do — looks like the
    // same number, but isn't: a node shared by several members' paths takes
    // its height from whichever member is farthest below *it*, and that can
    // be a different member than the one farthest below its parent. Two
    // numbers pulled from two different members' unrelated distances don't
    // compose into something that decreases along every edge the way a
    // height reasonably should. Walking the real, kept edges one at a time
    // does, by construction.
    const children = new Map<number, number[]>();
    for (const edge of edges) {
      const list = children.get(edge.from);
      if (list) list.push(edge.to);
      else children.set(edge.from, [edge.to]);
    }
    const heights = new Map<number, number>();
    const heightOf = (index: number): number => {
      const cached = heights.get(index);
      if (cached !== undefined) return cached;
      const kids = children.get(index);
      const height = kids && kids.length > 0 ? 1 + Math.max(...kids.map(heightOf)) : 0;
      heights.set(index, height);
      return height;
    };
    for (const index of nodes) heightOf(index);

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
      nodeOwners,
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
