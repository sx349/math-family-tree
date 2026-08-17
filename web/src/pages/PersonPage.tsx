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
  drawnCounts,
  neighborhood,
} from '../lib/neighborhood';

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

export function PersonPage() {
  const dataset = useDataset();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const index = dataset.indexOfId(Number(id));

  const [mode, setMode] = useState<Mode>('neighbourhood');
  const [depth, setDepth] = useState(1);
  const [lineage, setLineage] = useState(DEFAULT_LINEAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  // Opened "+N more" handles belong to the person being viewed; carrying them
  // across a navigation would expand the wrong node.
  useEffect(() => {
    setExpanded(new Set());
    setMode('neighbourhood');
    setDepth(1);
    setLineage(DEFAULT_LINEAGE);
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

  const view = useMemo(
    () =>
      index < 0
        ? null
        : neighborhood(dataset, index, {
            ancestors: mode === 'lineage' ? lineage : depth,
            descendants: mode === 'lineage' ? 0 : depth,
            nodeBudget: mode === 'lineage' ? LINEAGE_NODE_BUDGET : DEFAULT_NODE_BUDGET,
            expanded,
            expansionBudget: DEFAULT_EXPANSION_BUDGET,
          }),
    [dataset, index, mode, depth, lineage, expanded],
  );

  // Counted off the diagram itself. Showing what lies within reach instead put
  // a number beside the slider that the picture below it contradicted whenever
  // anything stopped the walk short.
  const drawn = view ? drawnCounts(view) : { up: 0, down: 0 };

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

  const nodes: GraphNodeSpec[] = (view?.nodes ?? []).map((node) => ({
    index: node.index,
    kind: node.relation,
  }));

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
        <div className="notice">
          No record for this person in the snapshot — only their name and who they connect to.{' '}
          <a href={dataset.mgpUrl(index)} target="_blank" rel="noreferrer">Their MGP page</a>{' '}
          may have more.
        </div>
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

      <div className="controls">
        <div className="group">
          <button
            className={mode === 'neighbourhood' ? 'button' : 'button quiet'}
            type="button"
            aria-pressed={mode === 'neighbourhood'}
            onClick={() => setMode('neighbourhood')}
          >
            Neighbourhood
          </button>
          <button
            className={mode === 'lineage' ? 'button' : 'button quiet'}
            type="button"
            aria-pressed={mode === 'lineage'}
            onClick={() => setMode('lineage')}
          >
            Lineage
          </button>
        </div>

        {mode === 'neighbourhood' ? (
          <div className="group">
            <label htmlFor="depth">Depth</label>
            <input
              id="depth" type="range" min={0} max={MAX_DEPTH} value={depth}
              style={{ width: 150 }}
              onChange={(event) => setDepth(Number(event.target.value))}
            />
            <strong>{depth}</strong>
            <span className="faint small num">
              · {(drawn.up + drawn.down).toLocaleString()}
            </span>
          </div>
        ) : (
          <div className="group">
            <label htmlFor="lineage">Generations</label>
            <input
              id="lineage" type="range" min={1} max={MAX_LINEAGE} value={lineage}
              style={{ width: 150 }}
              onChange={(event) => setLineage(Number(event.target.value))}
            />
            <strong>{lineage}</strong>
            <span className="faint small num">· {drawn.up.toLocaleString()}</span>
          </div>
        )}

        {expanded.size > 0 && (
          <button className="button quiet" type="button" onClick={() => setExpanded(new Set())}>
            Reset
          </button>
        )}
      </div>

      {view && view.nextAncestorRing > 0 && (
        <div className="notice warn">
          Stopped at <strong>{view.ancestorsReached}</strong>{' '}
          {view.ancestorsReached === 1 ? 'generation' : 'generations'} of advisors: the next
          would add {view.nextAncestorRing.toLocaleString()} more people.
        </div>
      )}

      {view && view.nextRingSize > 0 && (
        <div className="notice warn">
          Stopped at <strong>{view.descendantsReached}</strong>{' '}
          {view.descendantsReached === 1 ? 'generation' : 'generations'} of students of the{' '}
          {view.requestedDescendants} requested: the next would add{' '}
          {view.nextRingSize.toLocaleString()} more people.
        </div>
      )}

      <GraphView
        nodes={nodes}
        edges={view?.edges ?? []}
        overflows={view?.overflows ?? []}
        onSelect={(target) => navigate(`/person/${dataset.ids[target]}`)}
        onExpand={toggleExpand}
        focusIndex={index}
        emptyMessage="No advisors or students recorded for this person."
      />

    </div>
  );
}
