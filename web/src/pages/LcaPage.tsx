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

  // Computed as soon as there are two people to compare, rather than behind a
  // button: the search costs single-digit milliseconds, and a "Find" step only
  // stood between the reader and the answer they had already asked for.
  const result = useMemo(
    () => (selected.length >= 2 ? lowestCommonAncestors(dataset, selected, DEFAULT_MAX_DEPTH) : null),
    [dataset, selected],
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
        height: group.heights.get(index),
      }));
      return { group, nodes };
    });
  }, [result]);

  return (
    <div className="page">
      <h1>Common Ancestors</h1>

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
          {selected.length > 1 && (
            <button className="button quiet" type="button" onClick={() => setSelected([])}>
              Clear
            </button>
          )}
        </div>
      )}

      {result && (
        <>
          {result.groups.length === 0 && (
            <div className="notice warn">
              No shared advisor lineage within {generations(DEFAULT_MAX_DEPTH)}.
            </div>
          )}

          {result.isolated.length > 0 && result.groups.length > 0 && (
            <div className="notice">
              {/* Names contain commas, so they are separated with a middle dot. */}
              {result.isolated.map((index) => dataset.displayName(index)).join(' · ')}
              {result.isolated.length === 1 ? ' shares' : ' share'} no ancestry with the rest within{' '}
              {generations(DEFAULT_MAX_DEPTH)}.
            </div>
          )}

          {graphs.map(({ group, nodes }, position) => (
            <section key={position} style={{ marginTop: 28 }}>
              {/* Named only when there is more than one, where the heading
                  separates the families. A single diagram needs no label: the
                  people in it are the ones just chosen. */}
              {graphs.length > 1 && (
                <h2 style={{ marginBottom: 6 }}>
                  {group.targets.map((index) => dataset.displayName(index)).join(' · ')}
                </h2>
              )}
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
    </div>
  );
}
