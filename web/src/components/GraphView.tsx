/**
 * Cytoscape rendering of an advisor sub-graph.
 *
 * Layout is dagre top-to-bottom, so advisors always sit above their students
 * and a generation reads as a row. That matters here because the data is a DAG,
 * not a tree: when someone advises both a student and that student's own
 * student, the layered layout shows the shortcut edge spanning two rows instead
 * of hiding it in a tangle.
 */

import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { useEffect, useMemo, useRef } from 'react';

import { useDataset } from '../DatasetContext';
import type { OverflowHandle } from '../lib/neighborhood';

cytoscape.use(dagre);

export type NodeKind = 'root' | 'ancestor' | 'descendant' | 'relative' | 'target' | 'lca' | 'stub';

export interface GraphNodeSpec {
  index: number;
  kind: NodeKind;
}

interface GraphViewProps {
  nodes: GraphNodeSpec[];
  /** Advisor -> student. */
  edges: Array<[number, number]>;
  overflows?: OverflowHandle[];
  onSelect?: (index: number) => void;
  onExpand?: (key: string) => void;
  emptyMessage?: string;
  /** Node to keep in view when the graph is too wide to fit legibly. */
  focusIndex?: number;
}

/**
 * Below this zoom, labels are too small to read, so fitting the whole graph
 * stops being useful. A wide generation — Hilbert has 79 students in one row —
 * would otherwise render as an illegible strip. Past this point the view keeps
 * a readable scale, centres on the person being looked at, and lets the reader
 * pan, with "Fit all" available for the overview.
 */
const MIN_LEGIBLE_ZOOM = 0.42;

/** Vertical gap between the stacked sub-rows of one wrapped generation. */
const SUBROW_GAP = 8;
/** Horizontal gap between neighbouring nodes in a wrapped generation. */
const WRAP_GAP = 12;

/**
 * Wrap over-wide generations into several stacked sub-rows.
 *
 * Dagre puts every node of a rank on one line, so a prolific advisor produces a
 * single row thousands of pixels wide — Hilbert's 79 students rendered as an
 * unreadable strip. Wrapping keeps those nodes in their own generation (no rank
 * is merged with another) but stacks them, trading a much better aspect ratio
 * for some edges passing near the sub-rows below them.
 *
 * Dagre's left-to-right ordering within the rank is preserved, so the crossing
 * minimisation it already did is not thrown away.
 */
function wrapWideRanks(cy: Core, maxRowWidth: number): void {
  const byRank = new Map<number, cytoscape.NodeSingular[]>();
  cy.nodes().forEach((node) => {
    // Dagre aligns a rank's nodes on a shared y; round to absorb any drift.
    const rank = Math.round(node.position('y'));
    const bucket = byRank.get(rank);
    if (bucket) bucket.push(node);
    else byRank.set(rank, [node]);
  });

  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const packedWidthOf = (row: cytoscape.NodeSingular[]) =>
    row.reduce((sum, node) => sum + node.width() + WRAP_GAP, -WRAP_GAP);

  // If every generation already fits, dagre's layout is left exactly as it is —
  // its alignment of parents over their children is worth keeping.
  if (ranks.every((rank) => packedWidthOf(byRank.get(rank)!) <= maxRowWidth)) return;

  // Otherwise at least one generation must be wrapped, which invalidates the
  // global x-alignment dagre computed anyway. So every generation is repacked
  // and centred on a common axis, giving a compact column instead of a layout
  // still stretched to the width of the row that had to be broken up.
  const bounds = cy.nodes().boundingBox();
  const axis = (bounds.x1 + bounds.x2) / 2;

  let shift = 0;
  for (const rank of ranks) {
    const row = byRank.get(rank)!.sort((a, b) => a.position('x') - b.position('x'));
    const baseY = rank + shift;
    const widths = row.map((node) => node.width());
    const packedWidth = packedWidthOf(row);

    // Even sub-rows read better than a full one plus a short remainder.
    const subrowCount = Math.max(1, Math.ceil(packedWidth / maxRowWidth));
    const targetWidth = packedWidth / subrowCount;

    const subrows: cytoscape.NodeSingular[][] = [];
    let current: cytoscape.NodeSingular[] = [];
    let currentWidth = 0;
    row.forEach((node, position) => {
      const width = widths[position] + WRAP_GAP;
      if (current.length > 0 && currentWidth + width > targetWidth) {
        subrows.push(current);
        current = [];
        currentWidth = 0;
      }
      current.push(node);
      currentWidth += width;
    });
    if (current.length > 0) subrows.push(current);

    const rowHeight = Math.max(...row.map((node) => node.height())) + SUBROW_GAP;
    subrows.forEach((subrow, position) => {
      const subrowWidth = subrow.reduce((sum, node) => sum + node.width() + WRAP_GAP, -WRAP_GAP);
      let cursor = axis - subrowWidth / 2;
      const y = baseY + position * rowHeight;
      for (const node of subrow) {
        node.position({ x: cursor + node.width() / 2, y });
        cursor += node.width() + WRAP_GAP;
      }
    });

    // Push every later generation down to make room for the extra sub-rows.
    shift += (subrows.length - 1) * rowHeight;
  }
}

/** Cytoscape draws to a canvas, so it needs resolved colours, not CSS variables. */
function readPalette(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    root: read('--root', '#a8452a'),
    ancestor: read('--ancestor', '#3d6b8e'),
    descendant: read('--descendant', '#4b7d55'),
    relative: read('--muted', '#6f6a62'),
    target: read('--root', '#a8452a'),
    // Distinct from the red of the selected people, and consistent with
    // advisors being blue on the person page.
    lca: read('--ancestor', '#3d6b8e'),
    stub: read('--stub', '#9a938a'),
    accent: read('--accent', '#7c4a2d'),
    accent_soft: read('--accent-soft', '#f2e8e0'),
    surface: read('--surface', '#ffffff'),
    text: read('--text', '#23201c'),
    border: read('--border', '#e3ded6'),
    muted: read('--muted', '#6f6a62'),
  };
}

export function GraphView({
  nodes,
  edges,
  overflows = [],
  onSelect,
  onExpand,
  emptyMessage,
  focusIndex,
}: GraphViewProps) {
  const dataset = useDataset();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Core | null>(null);
  // Held in refs so that changing a handler never forces the graph to rebuild.
  const selectHandler = useRef(onSelect);
  const expandHandler = useRef(onExpand);
  const focusRef = useRef(focusIndex);
  selectHandler.current = onSelect;
  expandHandler.current = onExpand;
  focusRef.current = focusIndex;

  const elements = useMemo<ElementDefinition[]>(() => {
    const present = new Set(nodes.map((n) => n.index));
    const definitions: ElementDefinition[] = [];

    for (const { index, kind } of nodes) {
      const person = dataset.person(index);
      const effectiveKind = person.isStub && kind !== 'root' && kind !== 'target' ? 'stub' : kind;
      definitions.push({
        data: {
          id: `n${index}`,
          index,
          kind: effectiveKind,
          label: dataset.displayName(index),
          sublabel: [person.year, person.country].filter(Boolean).join(' · '),
        },
      });
    }

    for (const [advisor, student] of edges) {
      if (present.has(advisor) && present.has(student)) {
        definitions.push({ data: { id: `e${advisor}-${student}`, source: `n${advisor}`, target: `n${student}` } });
      }
    }

    for (const handle of overflows) {
      if (!present.has(handle.source)) continue;
      // Just "+N": the handle's position already says which direction it opens
      // (above for advisors, below for students), and spelling out the noun on
      // every frontier node crowds the diagram far more than it informs.
      definitions.push({
        data: {
          id: `o${handle.key}`,
          kind: 'overflow',
          overflowKey: handle.key,
          label: `+${handle.hidden}`,
        },
      });
      // The handle hangs on the side its hidden neighbours would appear on.
      const [source, target] =
        handle.direction === 'up'
          ? [`o${handle.key}`, `n${handle.source}`]
          : [`n${handle.source}`, `o${handle.key}`];
      definitions.push({ data: { id: `eo${handle.key}`, source, target, overflow: true } });
    }

    return definitions;
  }, [dataset, nodes, edges, overflows]);

  useEffect(() => {
    if (!container.current) return;
    const palette = readPalette();

    const cy = cytoscape({
      container: container.current,
      elements,
      style: [
        {
          // Labels sit *inside* the node box. Dagre spaces nodes by their box,
          // and has no idea how wide a label drawn outside one would be, so
          // external labels make it pack nodes until the text overlaps.
          selector: 'node',
          style: {
            shape: 'round-rectangle',
            'background-color': palette.surface,
            'border-width': 2,
            'border-color': (element) => palette[element.data('kind') as string] ?? palette.relative,
            label: 'data(label)',
            color: palette.text,
            'font-family': 'system-ui, sans-serif',
            'font-size': 11,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'ellipsis',
            'text-max-width': '176px',
            // Below ~7px on screen a name is grey noise that obscures the shape
            // of the graph. Cytoscape drops the text entirely at that point, so
            // a dense view reads as clean boxes and names return on zoom in.
            'min-zoomed-font-size': 7,
            width: 'label',
            height: 20,
            padding: '7px',
          },
        },
        {
          // The people the reader actually asked about are filled, so they stand
          // out from the context drawn around them.
          selector: 'node[kind = "root"], node[kind = "target"], node[kind = "lca"]',
          style: {
            'background-color': (element) => palette[element.data('kind') as string] ?? palette.root,
            color: palette.surface,
            'font-weight': 'bold',
            'font-size': 12,
            height: 24,
          },
        },
        {
          // Stubs are people MGP references but whose record we do not have, so
          // they are drawn dashed to signal "name only, nothing behind it".
          selector: 'node[kind = "stub"]',
          style: { 'border-style': 'dashed', 'border-color': palette.stub, color: palette.muted },
        },
        {
          selector: 'node[kind = "overflow"]',
          style: {
            shape: 'round-rectangle',
            'background-color': palette.accent_soft ?? palette.surface,
            'border-color': palette.accent,
            'border-style': 'dotted',
            height: 14,
            padding: '4px',
            color: palette.accent,
            'font-size': 9,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.2,
            'line-color': palette.border,
            'target-arrow-color': palette.border,
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.7,
            'curve-style': 'bezier',
          },
        },
        {
          selector: 'edge[overflow]',
          style: { 'line-style': 'dashed', 'target-arrow-shape': 'none' },
        },
        {
          selector: 'node:selected',
          style: { 'border-color': palette.root, 'border-width': 3 },
        },
      ],
      layout: {
        name: 'dagre',
        rankDir: 'TB',
        nodeSep: 14,
        rankSep: 76,
        animate: false,
        fit: false, // fitted below, after the wrap pass has moved things
        padding: 40,
      } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.2,
      maxZoom: 3,
      minZoom: 0.03,
    });

    // Wrap to roughly the container's own width so the result fits at close to
    // 1:1 zoom — wrapping to something wider only trades a strip for a smaller
    // strip once the fit scales it back down.
    const viewportWidth = cy.width() || 900;
    wrapWideRanks(cy, Math.max(640, Math.min(viewportWidth - 80, 1400)));
    cy.fit(undefined, 40);

    // Fitting a very wide generation shrinks the labels past readability, so
    // below the legibility floor we keep a usable scale and centre on the
    // person in question instead of showing an unreadable overview.
    if (cy.zoom() < MIN_LEGIBLE_ZOOM) {
      cy.zoom(MIN_LEGIBLE_ZOOM);
      const focus = focusRef.current !== undefined ? cy.getElementById(`n${focusRef.current}`) : null;
      if (focus && focus.nonempty()) cy.center(focus);
      else cy.center();
    }

    cy.on('tap', 'node', (event) => {
      const data = event.target.data();
      if (data.kind === 'overflow') expandHandler.current?.(data.overflowKey as string);
      else selectHandler.current?.(data.index as number);
    });
    // Cursor affordance, since nodes navigate on click.
    cy.on('mouseover', 'node', () => { if (container.current) container.current.style.cursor = 'pointer'; });
    cy.on('mouseout', 'node', () => { if (container.current) container.current.style.cursor = 'default'; });

    instance.current = cy;
    return () => {
      cy.destroy();
      instance.current = null;
    };
  }, [elements]);

  const fitAll = () => instance.current?.fit(undefined, 40);
  const recenter = () => {
    const cy = instance.current;
    if (!cy) return;
    cy.zoom(1);
    const focus = focusIndex !== undefined ? cy.getElementById(`n${focusIndex}`) : null;
    if (focus && focus.nonempty()) cy.center(focus);
    else cy.center();
  };

  return (
    <div className="graph-shell">
      <div className="graph-canvas" ref={container} />
      {nodes.length > 0 && (
        <div className="graph-tools">
          <button className="button" type="button" onClick={fitAll}>
            Fit all
          </button>
          <button className="button" type="button" onClick={recenter}>
            Recentre
          </button>
        </div>
      )}
      {nodes.length === 0 && emptyMessage && <div className="graph-empty">{emptyMessage}</div>}
    </div>
  );
}
