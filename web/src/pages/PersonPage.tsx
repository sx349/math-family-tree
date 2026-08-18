import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { GraphView, type GraphNodeSpec } from '../components/GraphView';
import { useDataset } from '../DatasetContext';
import type { PersonDetail } from '../lib/dataset';
import {
  DEFAULT_EXPANSION_BUDGET,
  DEFAULT_LINEAGE,
  DEFAULT_NODE_BUDGET,
  LINEAGE_NODE_BUDGET,
  MAX_DEPTH,
  MAX_LINEAGE,
  lineage as lineageWalk,
  neighborhood,
} from '../lib/neighborhood';
import { readStored, writeStored } from '../lib/persist';
import { usePortraitPhone } from '../lib/usePortraitPhone';

/**
 * Two questions, two diagrams — and one control each.
 *
 * Neighbourhood asks how someone sits among the people around them. That is a
 * radius, so it takes a single depth and spends it in both directions at once.
 * Lineage asks who they descend from, which is one direction and goes much
 * further, so it takes generations of advisors and nothing else.
 *
 * The split belongs between the modes, not inside one: an earlier version gave
 * the neighbourhood separate advisor and student sliders, which made the reader
 * answer a question the mode had already answered for them.
 */
type Mode = 'neighbourhood' | 'lineage';

interface StoredControls {
  mode: Mode;
  depth: number;
  lineageDepth: number;
}

// Shared across every person's page, deliberately: choosing Lineage at depth
// 6 for one mathematician and then following an advisor link is asking to
// keep looking at the same kind of thing, not to start over at the default.
const STORAGE_KEY = 'person:controls';

export function PersonPage() {
  const dataset = useDataset();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const index = dataset.indexOfId(Number(id));

  const [controls, setControls] = useState<StoredControls>(() =>
    readStored<StoredControls>(STORAGE_KEY, { mode: 'neighbourhood', depth: 1, lineageDepth: DEFAULT_LINEAGE }),
  );
  const { mode, depth, lineageDepth } = controls;
  const setMode = (next: Mode) => setControls((current) => ({ ...current, mode: next }));
  const setDepth = (next: number) => setControls((current) => ({ ...current, depth: next }));
  const setLineageDepth = (next: number) => setControls((current) => ({ ...current, lineageDepth: next }));

  useEffect(() => {
    writeStored(STORAGE_KEY, controls);
  }, [controls]);

  const portraitPhone = usePortraitPhone();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  // Opened "+N more" handles belong to the person being viewed; carrying them
  // across a navigation would expand the wrong node. Mode and depth are not
  // reset here — those follow the reader, not the person.
  useEffect(() => {
    setExpanded(new Set());
  }, [index]);

  useEffect(() => {
    if (index < 0) return;
    let active = true;
    setDetailLoading(true);
    dataset.detail(index).then((result) => {
      if (active) {
        setDetail(result);
        setDetailLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [dataset, index]);

  const neighborhoodView = useMemo(
    () =>
      portraitPhone || index < 0 || mode !== 'neighbourhood'
        ? null
        : neighborhood(dataset, index, {
            depth,
            nodeBudget: DEFAULT_NODE_BUDGET,
            expanded,
            expansionBudget: DEFAULT_EXPANSION_BUDGET,
          }),
    [dataset, index, mode, depth, expanded, portraitPhone],
  );

  const lineageView = useMemo(
    () =>
      portraitPhone || index < 0 || mode !== 'lineage'
        ? null
        : lineageWalk(dataset, index, { generations: lineageDepth, nodeBudget: LINEAGE_NODE_BUDGET }),
    [dataset, index, mode, lineageDepth, portraitPhone],
  );

  // Counted off the diagram itself, root excluded. Showing what lies within
  // reach instead put a number beside the slider that the picture below it
  // contradicted whenever anything stopped the walk short.
  const drawnCount =
    mode === 'neighbourhood'
      ? Math.max(0, (neighborhoodView?.nodes.length ?? 1) - 1)
      : Math.max(0, (lineageView?.nodes.length ?? 1) - 1);

  if (index < 0) {
    return (
      <div className="page narrow">
        <h1>Not found</h1>
        <p className="muted">
          No mathematician with id {id} is in this snapshot. They may have been added to MGP after
          it was taken — try <a href={`https://www.genealogy.math.ndsu.nodak.edu/id.php?id=${id}`}>
            their MGP page
          </a>{' '}
          or <Link to="/search">search by name</Link>.
        </p>
      </div>
    );
  }

  const person = dataset.person(index);
  const advisors = [...dataset.advisors(index)];
  const students = [...dataset.students(index)];

  const nodes: GraphNodeSpec[] =
    mode === 'neighbourhood'
      ? (neighborhoodView?.nodes ?? []).map((node) => ({ index: node.index, kind: node.relation }))
      : (lineageView?.nodes ?? []).map((node) => ({ index: node.index, kind: node.index === index ? 'root' : 'ancestor' }));

  const toggleExpand = (key: string) =>
    setExpanded((current) => new Set(current).add(key));

  return (
    <div className="page">
      <h1>{dataset.displayName(index)}</h1>
      <p className="record-id">
        MGP <a href={dataset.mgpUrl(index)} target="_blank" rel="noreferrer">{person.id}</a>
        {person.mscLabel && ` · ${person.mscLabel}`}
      </p>

      {person.isStub ? (
        <div className="notice">No further details for this person in the snapshot.</div>
      ) : (
        <ul className="facts" style={{ marginBottom: 8 }}>
          {detail?.degrees.map((degree, position) => (
            <li key={position}>
              <span className="key">{degree.type || 'Degree'}</span>
              <span>
                {[degree.schools.join('; '), degree.year].filter(Boolean).join(', ')}
                {degree.thesis && (
                  <>
                    <br />
                    <em>{degree.thesis}</em>
                  </>
                )}
              </span>
            </li>
          ))}
          {detailLoading && !detail && (
            <li>
              <span className="key">Degree</span>
              <span className="muted">loading…</span>
            </li>
          )}
          <li>
            <span className="key">Advisors</span>
            <span>
              {advisors.length === 0 ? (
                <span className="muted">none recorded</span>
              ) : (
                advisors.map((advisor, position) => (
                  <span key={advisor}>
                    {position > 0 && ', '}
                    <Link to={`/person/${dataset.ids[advisor]}`}>{dataset.displayName(advisor)}</Link>
                  </span>
                ))
              )}
            </span>
          </li>
          <li>
            <span className="key">Students</span>
            <span>
              {students.length === 0 ? (
                <span className="muted">none recorded</span>
              ) : (
                <span className="num">{students.length.toLocaleString()} recorded</span>
              )}
            </span>
          </li>
        </ul>
      )}

      <h2>Genealogy</h2>

      {portraitPhone ? (
        <div className="rotate-prompt">Turn your phone sideways to see the diagram.</div>
      ) : (
        <>
          {/* The mode is the first choice a reader makes here, and the two
              questions it answers are not variations on each other — so it gets
              its own row, set apart from the depth control that only refines
              whichever one is picked. */}
          <div className="mode-toggle">
            <button
              type="button"
              aria-pressed={mode === 'neighbourhood'}
              onClick={() => setMode('neighbourhood')}
            >
              Neighbourhood
            </button>
            <button
              type="button"
              aria-pressed={mode === 'lineage'}
              onClick={() => setMode('lineage')}
            >
              Lineage
            </button>
          </div>

          <div className="controls">
            {mode === 'neighbourhood' ? (
              <div className="group">
                <label htmlFor="depth">Depth</label>
                <input
                  id="depth" type="range" min={0} max={MAX_DEPTH} value={depth}
                  style={{ width: 150 }}
                  onChange={(event) => setDepth(Number(event.target.value))}
                />
                <strong>{depth}</strong>
                <span className="faint small num">· {drawnCount.toLocaleString()}</span>
              </div>
            ) : (
              <div className="group">
                <label htmlFor="lineage">Generations</label>
                <input
                  id="lineage" type="range" min={1} max={MAX_LINEAGE} value={lineageDepth}
                  style={{ width: 150 }}
                  onChange={(event) => setLineageDepth(Number(event.target.value))}
                />
                <strong>{lineageDepth}</strong>
                <span className="faint small num">· {drawnCount.toLocaleString()}</span>
              </div>
            )}

            <span className="muted small">
              {mode === 'neighbourhood'
                ? `Everyone within ${depth} step${depth === 1 ? '' : 's'}.`
                : `Advisor chain up to ${lineageDepth} generation${lineageDepth === 1 ? '' : 's'}.`}
            </span>

            {expanded.size > 0 && (
              <button className="button quiet" type="button" onClick={() => setExpanded(new Set())}>
                Reset
              </button>
            )}
          </div>

          {mode === 'neighbourhood' && neighborhoodView && neighborhoodView.budgetLimited && (
            <div className="notice warn">
              Stopped at <strong>{neighborhoodView.reached}</strong>{' '}
              {neighborhoodView.reached === 1 ? 'step' : 'steps'}: the next would add{' '}
              {neighborhoodView.nextRingSize.toLocaleString()} more people.
            </div>
          )}

          {mode === 'lineage' && lineageView && lineageView.budgetLimited && (
            <div className="notice warn">
              Stopped at <strong>{lineageView.reached}</strong>{' '}
              {lineageView.reached === 1 ? 'generation' : 'generations'} of advisors: the next
              would add {lineageView.nextRingSize.toLocaleString()} more people.
            </div>
          )}

          <GraphView
            nodes={nodes}
            edges={((mode === 'neighbourhood' ? neighborhoodView?.edges : lineageView?.edges) ?? []).map(
              ([from, to]) => ({ from, to }),
            )}
            overflows={neighborhoodView?.overflows ?? []}
            onSelect={(target) => navigate(`/person/${dataset.ids[target]}`)}
            onExpand={toggleExpand}
            focusIndex={index}
            emptyMessage="No advisors or students recorded for this person."
          />
        </>
      )}

    </div>
  );
}
