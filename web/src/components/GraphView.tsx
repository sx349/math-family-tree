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
 *
 * Derived, not chosen: cytoscape hides a label once its rendered size falls
 * under `min-zoomed-font-size`, which happens at exactly this zoom. The floor
 * used to be a separate 0.42, comfortably *below* the point labels vanish, so
 * the view that was supposed to stay legible held nothing but empty boxes.
 */
const NODE_FONT_SIZE = 11;
const MIN_ZOOMED_FONT_SIZE = 7;
const MIN_LEGIBLE_ZOOM = MIN_ZOOMED_FONT_SIZE / NODE_FONT_SIZE;

/**
 * A lineage is tall and narrow: twenty generations stand about 2,200px high,
 * which a fixed 700px plate can only ever show a third of. So the plate takes
 * its height from the diagram, within limits, instead of the diagram being
 * cropped to the plate.
 */
const PLATE_MIN_HEIGHT = 360;
const PLATE_MAX_HEIGHT = 1800;

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
  // outerWidth/outerHeight, not width/height: the latter measure the label box
  // before padding, and packing to those numbers drew every box overlapping its
  // neighbour by the padding — 14px of it, which is most of the gap.
  const packedWidthOf = (row: cytoscape.NodeSingular[]) =>
    row.reduce((sum, node) => sum + node.outerWidth() + WRAP_GAP, -WRAP_GAP);

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
    const widths = row.map((node) => node.outerWidth());
    const packedWidth = packedWidthOf(row);

    // Even sub-rows read better than a full one plus a short remainder.
    const subrowCount = Math.max(1, Math.ceil(packedWidth / maxRowWidth));
    const targetWidth = packedWidth / subrowCount;

    // A row's width counts the gaps *between* its nodes, so the running total
    // has to as well. Adding a trailing gap to each meant a rank that fits
    // still overflowed its target by exactly one gap on the final node, which
    // broke the last node of every rank onto a line of its own — most visibly
    // the second of somebody's two advisors.
    const subrows: cytoscape.NodeSingular[][] = [];
    let current: cytoscape.NodeSingular[] = [];
    let currentWidth = 0;
    row.forEach((node, position) => {
      const width = widths[position];
      const extended = current.length === 0 ? width : currentWidth + WRAP_GAP + width;
      if (current.length > 0 && extended > targetWidth) {
        subrows.push(current);
        current = [node];
        currentWidth = width;
      } else {
        current.push(node);
        currentWidth = extended;
      }
    });
    if (current.length > 0) subrows.push(current);

    const rowHeight = Math.max(...row.map((node) => node.outerHeight())) + SUBROW_GAP;
    subrows.forEach((subrow, position) => {
      const subrowWidth = subrow.reduce((sum, node) => sum + node.outerWidth() + WRAP_GAP, -WRAP_GAP);
      let cursor = axis - subrowWidth / 2;
      const y = baseY + position * rowHeight;
      for (const node of subrow) {
        node.position({ x: cursor + node.outerWidth() / 2, y });
        cursor += node.outerWidth() + WRAP_GAP;
      }
    });

    // Push every later generation down to make room for the extra sub-rows.
    shift += (subrows.length - 1) * rowHeight;
  }
}

/**
 * Hold the drawing against the edges of the plate.
 *
 * Centring on the focus node is right when the whole graph fits, but a lineage
 * puts that node at the very bottom of the drawing, so centring it left the
 * diagram in the top half of the plate and empty paper below. Panning is
 * clamped to the drawing's own bounds instead: an axis that overflows keeps the
 * plate covered, an axis that fits is centred on it.
 */
function clampPan(cy: Core, padding: number): void {
  const box = cy.nodes().boundingBox();
  if (box.w === 0 && box.h === 0) return;
  const zoom = cy.zoom();
  const pan = cy.pan();

  const along = (min: number, max: number, viewport: number, current: number) => {
    if ((max - min) * zoom + padding * 2 <= viewport) return (viewport - (min + max) * zoom) / 2;
    return Math.min(Math.max(current, viewport - padding - max * zoom), padding - min * zoom);
  };

  cy.pan({
    x: along(box.x1, box.x2, cy.width(), pan.x),
    y: along(box.y1, box.y2, cy.height(), pan.y),
  });
}

/** Cytoscape draws to a canvas, so it needs resolved colours, not CSS variables. */
function readPalette(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    paper: read('--paper', '#ebe7db'),
    ink: read('--ink', '#262d28'),
    inkSoft: read('--ink-soft', '#515850'),
    inkFaint: read('--ink-faint', '#7d817a'),
    hair: read('--hair', '#c6c0b1'),
    oxblood: read('--oxblood', '#7c3a2c'),
  };
}

/**
 * One ink for structure, one oxblood for the people the reader asked about.
 * Everything else is distinguished by stroke weight and line style — the
 * register of a printed plate rather than of a colour-coded chart.
 */
function strokeFor(kind: string, palette: Record<string, string>): string {
  if (kind === 'root' || kind === 'target') return palette.oxblood;
  if (kind === 'stub') return palette.inkFaint;
  return palette.ink;
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
  const frame = useRef<HTMLDivElement>(null);
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
            shape: 'rectangle',
            'background-color': palette.paper,
            'background-opacity': 1,
            'border-width': 1,
            'border-color': (element) => strokeFor(element.data('kind') as string, palette),
            label: 'data(label)',
            color: palette.ink,
            'font-family': "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
            'font-size': NODE_FONT_SIZE,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'ellipsis',
            'text-max-width': '176px',
            // Below ~7px on screen a name is grey noise that obscures the shape
            // of the graph. Cytoscape drops the text entirely at that point, so
            // a dense view reads as clean boxes and names return on zoom in.
            'min-zoomed-font-size': MIN_ZOOMED_FONT_SIZE,
            width: 'label',
            height: 20,
            padding: '7px',
          },
        },
        {
          // The people the reader asked about are ruled in oxblood; the ancestor
          // that answers the question is ruled heavier in the same ink as the
          // rest of the drawing. Weight and colour do separate jobs.
          selector: 'node[kind = "root"], node[kind = "target"]',
          style: { 'border-width': 1.6, color: palette.oxblood, 'font-weight': 'bold', height: 24 },
        },
        {
          selector: 'node[kind = "lca"]',
          style: { 'border-width': 2.6, 'font-weight': 'bold', height: 24 },
        },
        {
          // Stubs are people MGP references but whose record we do not have, so
          // they are drawn dashed to signal "name only, nothing behind it".
          selector: 'node[kind = "stub"]',
          style: { 'border-style': 'dashed', color: palette.inkFaint },
        },
        {
          selector: 'node[kind = "overflow"]',
          style: {
            shape: 'rectangle',
            'background-color': palette.paper,
            'border-color': palette.inkFaint,
            'border-style': 'dotted',
            'border-width': 1,
            height: 14,
            padding: '4px',
            color: palette.inkSoft,
            'font-size': 9,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 0.8,
            'line-color': palette.inkSoft,
            'target-arrow-color': palette.inkSoft,
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.6,
            'curve-style': 'bezier',
            opacity: 0.75,
          },
        },
        {
          selector: 'edge[overflow]',
          style: { 'line-style': 'dashed', 'target-arrow-shape': 'none' },
        },
        {
          selector: 'node:selected',
          style: { 'border-color': palette.oxblood, 'border-width': 2.4 },
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

    // Give the plate the height this particular diagram needs, before fitting
    // into it. Height is the only dimension free to move — width belongs to
    // the page — so a tall lineage grows downward rather than being cropped.
    if (frame.current) {
      const box = cy.nodes().boundingBox();
      const usableWidth = Math.max(viewportWidth - 80, 1);
      const zoom = Math.max(Math.min(1, usableWidth / Math.max(box.w, 1)), MIN_LEGIBLE_ZOOM);
      const needed = box.h * zoom + 80;
      const height = Math.max(PLATE_MIN_HEIGHT, Math.min(needed, PLATE_MAX_HEIGHT));
      frame.current.style.height = `${Math.round(height)}px`;
      cy.resize();
    }

    cy.fit(undefined, 40);

    // Fitting a very wide generation shrinks the labels past readability, so
    // below the legibility floor we keep a usable scale and centre on the
    // person in question instead of showing an unreadable overview.
    if (cy.zoom() < MIN_LEGIBLE_ZOOM) {
      cy.zoom(MIN_LEGIBLE_ZOOM);
      const focus = focusRef.current !== undefined ? cy.getElementById(`n${focusRef.current}`) : null;
      if (focus && focus.nonempty()) cy.center(focus);
      else cy.center();
      clampPan(cy, 40);
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
    clampPan(cy, 40);
  };

  return (
    <div className="plate-frame" ref={frame}>
      <div className="plate-canvas" ref={container} />
      {nodes.length > 0 && (
        <div className="plate-tools">
          <button className="button" type="button" onClick={fitAll}>Fit all</button>
          <button className="button" type="button" onClick={recenter}>Recentre</button>
        </div>
      )}
      {nodes.length === 0 && emptyMessage && <div className="plate-empty">{emptyMessage}</div>}
    </div>
  );
}
