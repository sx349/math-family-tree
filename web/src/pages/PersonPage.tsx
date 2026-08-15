import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { GraphView, type GraphNodeSpec } from '../components/GraphView';
import { useDataset } from '../DatasetContext';
import type { PersonDetail } from '../lib/dataset';
import {
  DEFAULT_EXPANSION_BUDGET,
  DEFAULT_LINEAGE,
  DEFAULT_NODE_BUDGET,
  MAX_ANCESTORS,
  MAX_DESCENDANTS,
  MAX_LINEAGE,
  directionProfile,
  neighborhood,
} from '../lib/neighborhood';

/**
 * Two questions, two diagrams. Neighbourhood asks how someone sits among the
 * people around them, which needs both directions and stays local. Lineage
 * asks who they descend from, which needs one direction and goes far — and
 * mixing the two produced a view that answered neither well.
 */
type Mode = 'neighbourhood' | 'lineage';

export function PersonPage() {
  const dataset = useDataset();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const index = dataset.indexOfId(Number(id));

  const [mode, setMode] = useState<Mode>('neighbourhood');
  const [ancestors, setAncestors] = useState(1);
  const [descendants, setDescendants] = useState(1);
  const [lineage, setLineage] = useState(DEFAULT_LINEAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  // Opened "+N more" handles belong to the person being viewed; carrying them
  // across a navigation would expand the wrong node.
  useEffect(() => {
    setExpanded(new Set());
    setMode('neighbourhood');
    setAncestors(1);
    setDescendants(1);
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

  const upProfile = useMemo(
    () => (index < 0 ? [] : directionProfile(dataset, index, 'up', MAX_LINEAGE)),
    [dataset, index],
  );
  const downProfile = useMemo(
    () => (index < 0 ? [] : directionProfile(dataset, index, 'down', MAX_DESCENDANTS)),
    [dataset, index],
  );

  const view = useMemo(
    () =>
      index < 0
        ? null
        : neighborhood(dataset, index, {
            ancestors: mode === 'lineage' ? lineage : ancestors,
            descendants: mode === 'lineage' ? 0 : descendants,
            nodeBudget: DEFAULT_NODE_BUDGET,
            expanded,
            expansionBudget: DEFAULT_EXPANSION_BUDGET,
          }),
    [dataset, index, mode, ancestors, descendants, lineage, expanded],
  );

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
          <>
            <div className="group">
              <label htmlFor="ancestors">Advisors</label>
              <input
                id="ancestors" type="range" min={0} max={MAX_ANCESTORS} value={ancestors}
                style={{ width: 100 }}
                onChange={(event) => setAncestors(Number(event.target.value))}
              />
              <strong>{ancestors}</strong>
              <span className="faint small num">
                {upProfile[ancestors] !== undefined && `· ${upProfile[ancestors].toLocaleString()}`}
              </span>
            </div>

            <div className="group">
              <label htmlFor="descendants">Students</label>
              <input
                id="descendants" type="range" min={0} max={MAX_DESCENDANTS} value={descendants}
                style={{ width: 100 }}
                onChange={(event) => setDescendants(Number(event.target.value))}
              />
              <strong>{descendants}</strong>
              <span className="faint small num">
                {downProfile[descendants] !== undefined && `· ${downProfile[descendants].toLocaleString()}`}
              </span>
            </div>
          </>
        ) : (
          <div className="group">
            <label htmlFor="lineage">Generations</label>
            <input
              id="lineage" type="range" min={1} max={MAX_LINEAGE} value={lineage}
              style={{ width: 150 }}
              onChange={(event) => setLineage(Number(event.target.value))}
            />
            <strong>{lineage}</strong>
            <span className="faint small num">
              {upProfile[lineage] !== undefined && `· ${upProfile[lineage].toLocaleString()}`}
            </span>
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
