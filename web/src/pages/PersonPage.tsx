import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { GraphView, type GraphNodeSpec } from '../components/GraphView';
import { useDataset } from '../DatasetContext';
import type { PersonDetail } from '../lib/dataset';
import {
  DEFAULT_EXPANSION_BUDGET,
  DEFAULT_NODE_BUDGET,
  MAX_DEPTH,
  depthProfile,
  neighborhood,
} from '../lib/neighborhood';

const BUDGET_CHOICES = [75, 150, 300, 600];

export function PersonPage() {
  const dataset = useDataset();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const index = dataset.indexOfId(Number(id));

  const [depth, setDepth] = useState(1);
  const [budget, setBudget] = useState(DEFAULT_NODE_BUDGET);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  // Opened "+N more" handles belong to the person being viewed; carrying them
  // across a navigation would expand the wrong node.
  useEffect(() => {
    setExpanded(new Set());
    setDepth(1);
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

  const profile = useMemo(
    () => (index < 0 ? [] : depthProfile(dataset, index, MAX_DEPTH)),
    [dataset, index],
  );

  const view = useMemo(
    () =>
      index < 0
        ? null
        : neighborhood(dataset, index, {
            depth,
            nodeBudget: budget,
            expanded,
            expansionBudget: DEFAULT_EXPANSION_BUDGET,
          }),
    [dataset, index, depth, budget, expanded],
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
      <h1 style={{ marginBottom: 4 }}>{dataset.displayName(index)}</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        MGP <a href={dataset.mgpUrl(index)} target="_blank" rel="noreferrer">#{person.id}</a>
        {person.isStub && ' · name only in this snapshot'}
      </p>

      {person.isStub ? (
        <div className="notice">
          MGP references this person as an advisor or student, but our snapshot does not hold
          their own record — only their name and their links. Their{' '}
          <a href={dataset.mgpUrl(index)} target="_blank" rel="noreferrer">MGP page</a> will have
          the full entry.
        </div>
      ) : (
        <ul className="facts" style={{ margin: '18px 0 26px' }}>
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
          {person.mscLabel && (
            <li>
              <span className="key">Subject</span>
              <span>
                {person.mscLabel} <span className="muted small">(MSC {person.msc})</span>
              </span>
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
                `${students.length.toLocaleString()} recorded`
              )}
            </span>
          </li>
        </ul>
      )}

      <h2>Genealogy</h2>

      <div className="controls">
        <div className="group">
          <label htmlFor="depth">Depth</label>
          <input
            id="depth"
            type="range"
            min={1}
            max={MAX_DEPTH}
            value={depth}
            style={{ width: 120 }}
            onChange={(event) => setDepth(Number(event.target.value))}
          />
          <strong>{depth}</strong>
          <span className="muted small">
            {profile[depth] !== undefined && `· ${profile[depth].toLocaleString()} within reach`}
          </span>
        </div>

        <div className="group">
          <label htmlFor="budget">Max nodes</label>
          <select
            id="budget"
            value={budget}
            style={{ width: 'auto' }}
            onChange={(event) => setBudget(Number(event.target.value))}
          >
            {BUDGET_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>

        {expanded.size > 0 && (
          <button className="button" type="button" onClick={() => setExpanded(new Set())}>
            Collapse expansions
          </button>
        )}

        <span className="muted small">
          Showing {view?.nodes.length.toLocaleString()} people
        </span>
      </div>

      {view?.budgetLimited && (
        <div className="notice warn">
          Stopped at depth <strong>{view.depthReached}</strong> of the {depth} requested: the next
          generation would add {view.nextRingSize.toLocaleString()} more people, over the{' '}
          {budget}-node limit. Open a <em>+N more</em> handle to follow a specific branch, or
          raise the limit.
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

      <div className="legend">
        <span><i className="swatch" style={{ background: 'var(--root)' }} /> this person</span>
        <span><i className="swatch" style={{ background: 'var(--ancestor)' }} /> advisors</span>
        <span><i className="swatch" style={{ background: 'var(--descendant)' }} /> students</span>
        <span><i className="swatch" style={{ background: 'var(--muted)' }} /> related both ways</span>
        <span>
          <i className="swatch" style={{ background: 'var(--surface)', border: '1px solid var(--stub)' }} />{' '}
          name only
        </span>
        <span>
          Arrows point from advisor to student. <strong>+N</strong> marks hidden advisors (above)
          or students (below) — click to open that branch. Click any person to go to their page.
        </span>
      </div>
    </div>
  );
}
