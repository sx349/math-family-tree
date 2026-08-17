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
  /** Hop count to this node's farthest target, where the caller tracks one. */
  height?: number;
}

export interface GraphEdgeSpec {
  from: number;
  to: number;
  /**
   * Indices of the selected people whose path actually runs through this
   * edge, where the caller tracks that. An edge with exactly one owner gets
   * a dash pattern unique to that person, so a reader can trace which
   * branch is whose without following every line by eye; an edge with none
   * or several (a real link that isn't on any single tracked path, or one
   * shared by more than one) is drawn plain.
   */
  owners?: number[];
}

interface GraphViewProps {
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
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
 * One dash rhythm per selection slot, so a reader can trace which of up to
 * five targets a given edge belongs to without their line ever needing a
 * colour: increasingly long dashes, with the last two doubled up rather than
 * lengthened again, since past a point a longer dash reads the same as the
 * one before it at this line weight.
 */
const PATH_DASH_PATTERNS: number[][] = [
  [1, 4],
  [6, 4],
  [11, 4],
  [8, 3, 2, 3],
  [8, 3, 2, 3, 2, 3],
];

/**
 * A lineage is tall and narrow, and taller than it first looks: dagre ranks by
 * longest path, so someone three generations up by one route and twelve by
 * another is drawn at twelve, and a generation count is not a row count. So the
 * plate takes its height from the diagram rather than cropping the diagram to
 * the plate — a fixed 700px plate showed a seventh of a deep lineage, with
 * nothing to say the rest was there.
 *
 * Fitting is also what keeps the page usable: panning only turns on when the
 * drawing overflows, so a plate that holds its diagram leaves scrolling and
 * dragging to the page. At the ten-generation ceiling the tallest case measured
 * is 2,344px, on a phone; the ceiling here is a backstop well above it.
 */
const PLATE_MIN_HEIGHT = 360;
const PLATE_MAX_HEIGHT = 3600;

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
 * Bow an edge that skips a generation, so it can never be mistaken for the
 * chain running beneath it.
 *
 * Dagre ranks by edges: an advisor of both a student and that student's own
 * advisor sits exactly as far up as the longer path demands, since it has no
 * choice but to sit above everything it advises. With no sibling at that rank
 * to force any horizontal spread, the direct edge down to the grandchild ends
 * up drawn straight through the intermediate node's column — geometrically
 * identical to no edge at all. Curving only the edges that span more than one
 * rank leaves ordinary parent-child edges as clean straight lines and makes
 * every shortcut visible regardless of how the rest of the row falls.
 */
function curveShortcutEdges(cy: Core): void {
  const rankYs = new Set<number>();
  cy.nodes().forEach((node) => {
    rankYs.add(Math.round(node.position('y')));
  });
  const ranks = [...rankYs].sort((a, b) => a - b);
  const rankIndex = new Map<number, number>(ranks.map((y, i) => [y, i]));

  cy.edges().forEach((edge) => {
    const sourceRank = rankIndex.get(Math.round(edge.source().position('y')));
    const targetRank = rankIndex.get(Math.round(edge.target().position('y')));
    if (sourceRank === undefined || targetRank === undefined) return;
    if (Math.abs(targetRank - sourceRank) > 1) {
      edge.style({
        'curve-style': 'unbundled-bezier',
        'control-point-distances': [32],
        'control-point-weights': [0.5],
      });
    }
  });
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

    for (const { index, kind, height } of nodes) {
      const person = dataset.person(index);
      const effectiveKind = person.isStub && kind !== 'root' && kind !== 'target' ? 'stub' : kind;
      // Where the caller tracks height, it's prefixed onto the name rather
      // than added as a separate label: cytoscape draws one text field per
      // node, and a long name's ellipsis would otherwise eat a trailing
      // number before the reader ever saw it.
      const label = height !== undefined ? `(${height}) ${dataset.displayName(index)}` : dataset.displayName(index);
      definitions.push({
        data: {
          id: `n${index}`,
          index,
          kind: effectiveKind,
          label,
          sublabel: [person.year, person.country].filter(Boolean).join(' · '),
        },
      });
    }

    for (const { from, to, owners } of edges) {
      if (present.has(from) && present.has(to)) {
        // Only a *single* owner gets its own dash pattern: an edge two or
        // more targets share is exactly as much "everyone's" as "no one's"
        // in particular, and is drawn plain like one with no owner at all.
        const pathOwner = owners?.length === 1 ? owners[0] : undefined;
        definitions.push({
          data: {
            id: `e${from}-${to}`,
            source: `n${from}`,
            target: `n${to}`,
            ...(pathOwner !== undefined ? { pathOwner } : {}),
          },
        });
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
            // Wrapped, not ellipsised: a name too wide for one line grows the
            // box downward instead of losing its end, which matters most for
            // exactly the long, multi-part names this dataset has plenty of.
            'text-wrap': 'wrap',
            'text-max-width': '176px',
            // Below ~7px on screen a name is grey noise that obscures the shape
            // of the graph. Cytoscape drops the text entirely at that point, so
            // a dense view reads as clean boxes and names return on zoom in.
            'min-zoomed-font-size': MIN_ZOOMED_FONT_SIZE,
            width: 'label',
            height: 'label',
            padding: '7px',
          },
        },
        {
          // The people the reader asked about are ruled in oxblood; the ancestor
          // that answers the question is ruled heavier in the same ink as the
          // rest of the drawing. Weight and colour do separate jobs.
          selector: 'node[kind = "root"], node[kind = "target"]',
          style: { 'border-width': 1.6, color: palette.oxblood, 'font-weight': 'bold' },
        },
        {
          selector: 'node[kind = "lca"]',
          style: { 'border-width': 2.6, 'font-weight': 'bold' },
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
        ...PATH_DASH_PATTERNS.map((pattern, owner) => ({
          selector: `edge[pathOwner = ${owner}]`,
          style: { 'line-style': 'dashed' as const, 'line-dash-pattern': pattern },
        })),
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

    // Done against dagre's raw ranks, before wrapping touches any position.
    curveShortcutEdges(cy);

    // Wrap to roughly the container's own width so the result fits at close to
    // 1:1 zoom — wrapping to something wider only trades a strip for a smaller
    // strip once the fit scales it back down.
    const viewportWidth = cy.width() || 900;
    // Wrap to the plate's own width, whatever that is. The old floor of 640px
    // was wider than a phone, so on a 390px screen every diagram was built
    // 250px too wide and then clipped on both sides.
    wrapWideRanks(cy, Math.min(Math.max(viewportWidth - 40, 300), 1400));

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

    // Gestures belong to the page unless the diagram actually needs them. The
    // plate is now sized to its contents and can stand two phone screens tall,
    // so a canvas that swallowed every scroll and drag would leave the reader
    // unable to get past it. Wheel and pinch never zoom — "Fit all" and
    // "Recentre" do that — and dragging only pans when there is something
    // outside the plate to pan to.
    const drawn = cy.nodes().boundingBox();
    const fits =
      drawn.w * cy.zoom() <= cy.width() - 40 && drawn.h * cy.zoom() <= cy.height() - 40;
    cy.userZoomingEnabled(false);
    cy.userPanningEnabled(!fits);
    cy.autoungrabify(true);

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
    <>
      {/* Above the plate, not floating inside it: overlaid at the top right
          they covered the topmost generation, which on a narrow screen is
          where the diagram is widest. */}
      {nodes.length > 0 && (
        <div className="plate-tools">
          <button className="button" type="button" onClick={fitAll}>Fit all</button>
          <button className="button" type="button" onClick={recenter}>Recentre</button>
        </div>
      )}
      <div className="plate-frame" ref={frame}>
        <div className="plate-canvas" ref={container} />
        {nodes.length === 0 && emptyMessage && <div className="plate-empty">{emptyMessage}</div>}
      </div>
    </>
  );
}
