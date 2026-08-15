/**
 * Engine tests against the real built artifacts.
 *
 * The expected values here were computed independently in Python directly from
 * the snapshot, so these tests check the binary format, the TypeScript readers
 * and the traversal logic all agree with the source data — not merely with each
 * other.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { Dataset } from './dataset';
import { lowestCommonAncestors } from './lca';
import { MAX_LINEAGE, directionProfile, neighborhood, overflowKey } from './neighborhood';
import { fold, search } from './search';

const DATA_DIR = path.resolve(__dirname, '../../../data/web');

// MGP ids used throughout; stable identifiers on genealogy.math.ndsu.nodak.edu.
const HILBERT = 7298;
const GAUSS = 18231;
const GUDERMANN = 29458;
const DENG = 212291;

let dataset: Dataset;

beforeAll(async () => {
  // Serve the artifacts off disk so the loader is exercised exactly as it is in
  // the browser, including the gzip and alignment handling.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const buffer = await readFile(path.join(DATA_DIR, url.replace(/^data:\//, '')));
    return new Response(buffer);
  }) as typeof fetch;

  dataset = await Dataset.load('data:/');
}, 60_000);

describe('dataset', () => {
  it('loads every node described by the manifest', () => {
    expect(dataset.count).toBe(dataset.manifest.nodeCount);
    expect(dataset.count).toBeGreaterThan(300_000);
  });

  it('round-trips MGP ids through the dense index', () => {
    for (const id of [1, HILBERT, GAUSS, DENG, dataset.ids[dataset.count - 1]]) {
      expect(dataset.ids[dataset.indexOfId(id)]).toBe(id);
    }
  });

  it('reports absent ids rather than guessing', () => {
    expect(dataset.indexOfId(999_999_999)).toBe(-1);
  });

  it('decodes names, including non-ASCII ones', () => {
    expect(dataset.displayName(dataset.indexOfId(HILBERT))).toBe('Hilbert, David');
    expect(dataset.displayName(dataset.indexOfId(GAUSS))).toContain('Gau');
  });

  it('keeps the two edge directions consistent', () => {
    const hilbert = dataset.indexOfId(HILBERT);
    for (const student of dataset.students(hilbert)) {
      expect([...dataset.advisors(student)]).toContain(hilbert);
    }
  });
});

describe('search', () => {
  it('folds diacritics and ligatures the way the pipeline did', () => {
    expect(fold('Gauß')).toBe('gauss');
    expect(fold('Erdős')).toBe('erdos');
    expect(fold('Łoś')).toBe('los');
  });

  it('finds a person by folded family name', () => {
    const { indices } = search(dataset, { family: 'gauss' });
    expect(indices.map((i) => dataset.ids[i])).toContain(GAUSS);
  });

  it('combines fields with AND, unlike the MGP search page', () => {
    const both = search(dataset, { family: 'wang', given: 'hong' });
    expect(both.total).toBeGreaterThan(0);
    // Every hit must satisfy both fields, not either one.
    for (const index of both.indices) {
      const [family, given, other] = dataset.nameParts(index);
      expect(fold(family).startsWith('wang')).toBe(true);
      expect(fold(`${given} ${other}`)).toContain('hong');
    }
    expect(both.total).toBeLessThan(search(dataset, { family: 'wang' }).total);
  });

  it('caps results but reports the true total', () => {
    const result = search(dataset, { family: 'w' }, 10);
    expect(result.indices).toHaveLength(10);
    expect(result.total).toBeGreaterThan(10);
    expect(result.truncated).toBe(true);
  });
});

describe('neighborhood', () => {
  // Ground truth computed in Python straight from snapshot.jsonl.gz. The gap
  // between the two columns is why the directions cannot share a control.
  it('matches the independently computed profiles in both directions', () => {
    const hilbert = dataset.indexOfId(HILBERT);
    expect(directionProfile(dataset, hilbert, 'up', 5)).toEqual([0, 2, 6, 12, 19, 30]);
    expect(directionProfile(dataset, hilbert, 'down', 5)).toEqual(
      [0, 79, 454, 2249, 8239, 20940],
    );
  });

  it('shows exactly advisors and students at one generation each', () => {
    const hilbert = dataset.indexOfId(HILBERT);
    const result = neighborhood(dataset, hilbert, {
      ancestors: 1,
      descendants: 1,
      nodeBudget: 500,
    });
    expect(new Set(result.nodes.map((n) => n.index))).toEqual(
      new Set([hilbert, ...dataset.advisors(hilbert), ...dataset.students(hilbert)]),
    );
  });

  it('never turns a path around, so no siblings or cousins appear', () => {
    // Deng's advisor has other students. Under an undirected radius they would
    // arrive as soon as the reader asked for two generations; under pure paths
    // they can never arrive, because reaching them means going up then down.
    const deng = dataset.indexOfId(DENG);
    const advisor = dataset.advisors(deng)[0];
    const siblings = [...dataset.students(advisor)].filter((s) => s !== deng);
    expect(siblings.length).toBeGreaterThan(0);

    const result = neighborhood(dataset, deng, {
      ancestors: 4,
      descendants: 4,
      nodeBudget: 500,
    });
    const shown = new Set(result.nodes.map((n) => n.index));
    for (const sibling of siblings) expect(shown.has(sibling)).toBe(false);
  });

  it('admits ancestors in full, since going up is bounded', () => {
    const hilbert = dataset.indexOfId(HILBERT);
    const result = neighborhood(dataset, hilbert, {
      ancestors: 5,
      descendants: 0,
      nodeBudget: 200,
    });
    expect(result.ancestorsReached).toBe(5);
    expect(result.budgetLimited).toBe(false);
    expect(result.nodes).toHaveLength(31); // 30 ancestors plus Hilbert
  });

  it('stops at the last student generation that fits the budget', () => {
    const result = neighborhood(dataset, dataset.indexOfId(HILBERT), {
      ancestors: 0,
      descendants: 5,
      nodeBudget: 200,
    });
    // 79 students fit; their 375 further students do not.
    expect(result.descendantsReached).toBe(1);
    expect(result.nodes).toHaveLength(80);
    expect(result.budgetLimited).toBe(true);
    expect(result.nextRingSize).toBeGreaterThan(0);
  });

  it('never admits a partial generation', () => {
    const result = neighborhood(dataset, dataset.indexOfId(HILBERT), {
      ancestors: 0,
      descendants: 5,
      nodeBudget: 200,
    });
    const profile = directionProfile(dataset, dataset.indexOfId(HILBERT), 'down', 5);
    expect(result.nodes.length).toBe(profile[result.descendantsReached] + 1);
  });

  it('offers no handles when the requested depth was reached', () => {
    const result = neighborhood(dataset, dataset.indexOfId(GAUSS), {
      ancestors: 1,
      descendants: 1,
      nodeBudget: 500,
    });
    expect(result.budgetLimited).toBe(false);
    expect(result.overflows).toHaveLength(0);
  });

  it('offers overflow handles for everything the budget hid', () => {
    const hilbert = dataset.indexOfId(HILBERT);
    const result = neighborhood(dataset, hilbert, {
      ancestors: 0,
      descendants: 1,
      nodeBudget: 20,
    });
    expect(result.nodes).toHaveLength(1);
    const down = result.overflows.find((o) => o.source === hilbert);
    expect(down?.hidden).toBe(dataset.students(hilbert).length);
  });

  it('bounds how much a single overflow expansion can add', () => {
    const hilbert = dataset.indexOfId(HILBERT);
    const result = neighborhood(dataset, hilbert, {
      ancestors: 0,
      descendants: 1,
      nodeBudget: 20,
      expanded: new Set([overflowKey(hilbert, 'down')]),
      expansionBudget: 10,
    });
    expect(result.nodes).toHaveLength(11); // Hilbert plus 10 students
    const leftover = result.overflows.find((o) => o.source === hilbert);
    expect(leftover?.hidden).toBe(dataset.students(hilbert).length - 10);
  });

  it('caps the lineage view by budget as well as by generations', () => {
    // A median lineage runs 36 generations and 220 people, so asking for the
    // full depth must stop on the budget rather than drawing a 200-row column.
    const result = neighborhood(dataset, dataset.indexOfId(DENG), {
      ancestors: MAX_LINEAGE,
      descendants: 0,
      nodeBudget: 60,
    });
    expect(result.nodes.length).toBeLessThanOrEqual(60);
    expect(result.nextAncestorRing).toBeGreaterThan(0);
    expect(result.budgetLimited).toBe(true);
  });

  it('draws non-tree edges between admitted nodes', () => {
    const result = neighborhood(dataset, dataset.indexOfId(HILBERT), {
      ancestors: 2,
      descendants: 2,
      nodeBudget: 1000,
    });
    const admitted = new Set(result.nodes.map((n) => n.index));
    let expected = 0;
    for (const index of admitted) {
      for (const student of dataset.students(index)) if (admitted.has(student)) expected++;
    }
    expect(result.edges).toHaveLength(expected);
    for (const [advisor, student] of result.edges) {
      expect(admitted.has(advisor) && admitted.has(student)).toBe(true);
    }
  });
});

describe('lowest common ancestors', () => {
  it('finds the ancestor Python computed for three 19th-century figures', () => {
    const targets = [HILBERT, GAUSS, GUDERMANN].map((id) => dataset.indexOfId(id));
    const { groups } = lowestCommonAncestors(dataset, targets);
    expect(groups).toHaveLength(1);
    expect(groups[0].ancestors).toHaveLength(1);

    // Asserted by name, not id: MGP holds Abraham Kästner twice (#21235 and
    // #66476, with one recorded as the other's advisor), so the id that comes
    // back is whichever duplicate sits lower. Both are legitimate answers to
    // "who is the lowest common ancestor"; only the lower one is minimal.
    const [ancestor] = groups[0].ancestors;
    expect(dataset.displayName(ancestor)).toBe('Kästner, Abraham Gotthelf');
    expect(groups[0].distances[0].hops).toEqual([5, 2, 2]);
  });

  it('treats an ancestor of the other selection as the answer', () => {
    const targets = [DENG, HILBERT].map((id) => dataset.indexOfId(id));
    const { groups } = lowestCommonAncestors(dataset, targets);
    expect(groups[0].ancestors.map((i) => dataset.ids[i])).toEqual([HILBERT]);
  });

  it('returns only minimal ancestors, never a redundant chain', () => {
    const targets = [HILBERT, GAUSS].map((id) => dataset.indexOfId(id));
    const { groups } = lowestCommonAncestors(dataset, targets);
    // No returned ancestor may be an ancestor of another returned one.
    for (const a of groups[0].ancestors) {
      const reachable = new Set<number>();
      let frontier = [a];
      for (let hop = 0; hop < 30 && frontier.length; hop++) {
        const next: number[] = [];
        for (const n of frontier) for (const s of dataset.students(n)) {
          if (!reachable.has(s)) { reachable.add(s); next.push(s); }
        }
        frontier = next;
      }
      for (const b of groups[0].ancestors) {
        if (a !== b) expect(reachable.has(b)).toBe(false);
      }
    }
  });

  it('includes a full connecting path, with both endpoints on it', () => {
    const targets = [HILBERT, GAUSS, GUDERMANN].map((id) => dataset.indexOfId(id));
    const group = lowestCommonAncestors(dataset, targets).groups[0];
    const nodes = new Set(group.nodes);
    for (const target of targets) expect(nodes.has(target)).toBe(true);
    for (const ancestor of group.ancestors) expect(nodes.has(ancestor)).toBe(true);
    // The path subgraph must be connected via the returned edges.
    expect(group.edges.length).toBeGreaterThanOrEqual(nodes.size - group.ancestors.length);
  });

  it('returns a forest when the selections share no ancestry', () => {
    // A shallow limit forces the two pairs apart even though they do connect
    // much further up, which is the forest case the UI has to render.
    const targets = [HILBERT, GAUSS, GUDERMANN].map((id) => dataset.indexOfId(id));
    const result = lowestCommonAncestors(dataset, targets, 1);
    expect(result.groups.length + result.isolated.length).toBeGreaterThan(1);
    expect(result.depthLimited).toBe(true);
  });

  it('respects the depth limit', () => {
    const targets = [DENG, GAUSS].map((id) => dataset.indexOfId(id));
    // Gauß is 11 hops above Deng, so a limit of 5 cannot connect them.
    expect(lowestCommonAncestors(dataset, targets, 5).groups).toHaveLength(0);
    expect(lowestCommonAncestors(dataset, targets, 12).groups).toHaveLength(1);
  });
});
