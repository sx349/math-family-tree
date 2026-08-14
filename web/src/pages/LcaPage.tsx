import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { GraphView, type GraphNodeSpec } from '../components/GraphView';
import { PersonSearch } from '../components/PersonSearch';
import { useDataset } from '../DatasetContext';
import { DEFAULT_MAX_DEPTH, MAX_TARGETS, lowestCommonAncestors } from '../lib/lca';

const generations = (count: number) => `${count} generation${count === 1 ? '' : 's'}`;

export function LcaPage() {
  const dataset = useDataset();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<number[]>([]);
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  const [submitted, setSubmitted] = useState<number[] | null>(null);

  const result = useMemo(
    () => (submitted && submitted.length >= 2 ? lowestCommonAncestors(dataset, submitted, maxDepth) : null),
    [dataset, submitted, maxDepth],
  );

  const add = (index: number) =>
    setSelected((current) =>
      current.includes(index) || current.length >= MAX_TARGETS ? current : [...current, index],
    );
  const remove = (index: number) =>
    setSelected((current) => current.filter((value) => value !== index));

  // One diagram for every group, so an unconnected selection still renders as a
  // forest instead of failing.
  const graphs = useMemo(() => {
    if (!result) return [];
    return result.groups.map((group) => {
      const targets = new Set(group.targets);
      const ancestors = new Set(group.ancestors);
      const nodes: GraphNodeSpec[] = group.nodes.map((index) => ({
        index,
        kind: targets.has(index) ? 'target' : ancestors.has(index) ? 'lca' : 'relative',
      }));
      return { group, nodes };
    });
  }, [result]);

  return (
    <div className="page">
      <h1>Common ancestors</h1>
      <p className="lede">Pick up to {MAX_TARGETS} mathematicians.</p>

      {selected.length > 0 && (
        <div className="chips">
          {selected.map((index) => (
            <span className="chip" key={index}>
              {dataset.displayName(index)} <span className="chip-id">#{dataset.ids[index]}</span>
              <button type="button" aria-label={`Remove ${dataset.displayName(index)}`} onClick={() => remove(index)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="controls">
        <button
          className="button primary"
          type="button"
          disabled={selected.length < 2}
          onClick={() => setSubmitted(selected)}
        >
          Find common ancestors
        </button>
        <div className="group">
          <label htmlFor="maxDepth">Search up to</label>
          <input
            id="maxDepth"
            type="number"
            min={1}
            max={60}
            value={maxDepth}
            style={{ width: 72 }}
            onChange={(event) => setMaxDepth(Math.max(1, Number(event.target.value) || 1))}
          />
          <span className="muted small">generations</span>
        </div>
        {selected.length > 0 && (
          <button className="button" type="button" onClick={() => { setSelected([]); setSubmitted(null); }}>
            Clear
          </button>
        )}
      </div>

      {result && (
        <>
          {result.groups.length === 0 && (
            <div className="notice warn">
              None of the selected people share an advisor lineage within {generations(maxDepth)}.
            </div>
          )}

          {result.groups.length > 1 && (
            <div className="notice">
              The selection splits into {result.groups.length} separate families within{' '}
              {generations(maxDepth)}.
            </div>
          )}

          {result.isolated.length > 0 && result.groups.length > 0 && (
            <div className="notice">
              {/* Names contain commas, so they are separated with a middle dot. */}
              {result.isolated.map((index) => dataset.displayName(index)).join(' · ')}
              {result.isolated.length === 1 ? ' shares' : ' share'} no ancestry with the rest of
              the selection within {generations(maxDepth)}.
            </div>
          )}

          {graphs.map(({ group, nodes }, position) => (
            <section key={position} style={{ marginTop: 28 }}>
              <h2 style={{ marginBottom: 6 }}>
                {group.targets.map((index) => dataset.displayName(index)).join(' · ')}
              </h2>
              <p className="small muted" style={{ marginTop: 0 }}>
                {group.ancestors.length === 1 ? 'Lowest common ancestor: ' : 'Lowest common ancestors: '}
                {group.distances.map(({ ancestor, hops }, i) => (
                  <span key={ancestor}>
                    {i > 0 && ' · '}
                    <strong>{dataset.displayName(ancestor)}</strong> ({hops.join(', ')} generation
                    {hops.every((hop) => hop === 1) ? '' : 's'} down)
                  </span>
                ))}
              </p>
              <GraphView
                nodes={nodes}
                edges={group.edges}
                focusIndex={group.ancestors[0] ?? group.targets[0]}
                onSelect={(index) => navigate(`/person/${dataset.ids[index]}`)}
              />
            </section>
          ))}

        </>
      )}

      <h2>Add people</h2>
      <PersonSearch
        onPick={add}
        renderAction={(index) => (
          <button
            className="button"
            type="button"
            disabled={selected.includes(index) || selected.length >= MAX_TARGETS}
            onClick={() => add(index)}
          >
            {selected.includes(index) ? 'Added' : 'Add'}
          </button>
        )}
      />
    </div>
  );
}
