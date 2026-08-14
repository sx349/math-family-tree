/**
 * The search form, shared by the search page and the LCA page.
 *
 * Both pages want the same fields and the same result list and differ only in
 * what a click on a result does — navigate, or add to a selection — so that is
 * the one thing passed in.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { useDataset } from '../DatasetContext';
import { DEFAULT_RESULT_LIMIT, search, type Query } from '../lib/search';

interface PersonSearchProps {
  /** Rendered at the right of each row; the row itself is the click target. */
  renderAction?: (index: number) => ReactNode;
  onPick: (index: number) => void;
  autoFocus?: boolean;
}

const EMPTY: Query = {};

export function PersonSearch({ renderAction, onPick, autoFocus }: PersonSearchProps) {
  const dataset = useDataset();
  const [query, setQuery] = useState<Query>(EMPTY);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const result = useMemo(() => search(dataset, query, DEFAULT_RESULT_LIMIT), [dataset, query]);

  const update = (patch: Partial<Query>) => setQuery((current) => ({ ...current, ...patch }));
  const hasInput = Object.values(query).some((value) => value !== undefined && value !== '');

  return (
    <div>
      <div className="card">
        <div className="field-grid">
          <div>
            <label htmlFor="family">Last / family name</label>
            <input
              id="family"
              type="text"
              autoFocus={autoFocus}
              placeholder="Wang"
              value={query.family ?? ''}
              onChange={(event) => update({ family: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="given">First / given name</label>
            <input
              id="given"
              type="text"
              placeholder="Hong"
              value={query.given ?? ''}
              onChange={(event) => update({ given: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="school">School</label>
            <input
              id="school"
              type="text"
              placeholder="Princeton"
              value={query.school ?? ''}
              onChange={(event) => update({ school: event.target.value })}
            />
          </div>
        </div>

        {showAdvanced && (
          <div className="field-grid" style={{ marginTop: 14 }}>
            <div>
              <label htmlFor="country">Country</label>
              <input
                id="country"
                type="text"
                value={query.country ?? ''}
                onChange={(event) => update({ country: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="yearFrom">Degree year from</label>
              <input
                id="yearFrom"
                type="number"
                value={query.yearFrom ?? ''}
                onChange={(event) => update({ yearFrom: Number(event.target.value) || undefined })}
              />
            </div>
            <div>
              <label htmlFor="yearTo">Degree year to</label>
              <input
                id="yearTo"
                type="number"
                value={query.yearTo ?? ''}
                onChange={(event) => update({ yearTo: Number(event.target.value) || undefined })}
              />
            </div>
            <div>
              <label htmlFor="msc">Subject</label>
              <select
                id="msc"
                value={query.msc ?? ''}
                onChange={(event) => update({ msc: event.target.value || undefined })}
              >
                <option value="">Any subject</option>
                {dataset.dicts.mscs
                  .filter(Boolean)
                  .sort()
                  .map((code) => (
                    <option key={code} value={code}>
                      {code} — {dataset.dicts.mscLabels[code] ?? 'Other'}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14 }}>
          <button className="button" type="button" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Fewer fields' : 'More fields'}
          </button>
          {hasInput && (
            <button className="button" type="button" onClick={() => setQuery(EMPTY)}>
              Clear
            </button>
          )}
          <span className="small muted">
            All fields are combined with <strong>and</strong>.
          </span>
        </div>
      </div>

      {hasInput && (
        <>
          <p className="small muted" style={{ marginTop: 16 }}>
            {result.total === 0
              ? 'No matches.'
              : `${result.total.toLocaleString()} match${result.total === 1 ? '' : 'es'}` +
                (result.truncated ? `, showing the first ${result.indices.length}` : '')}
            {result.scanned && result.total > 0 && ' · add a family name to narrow this faster'}
          </p>

          <ul className="results">
            {result.indices.map((index) => {
              const person = dataset.person(index);
              return (
                <li key={index}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className="result-row" type="button" onClick={() => onPick(index)}>
                      <span>
                        <span className="result-name">{dataset.displayName(index)}</span>{' '}
                        <span className="small muted">#{person.id}</span>
                        {person.isStub && (
                          <span className="small muted stub-note"> · name only</span>
                        )}
                      </span>
                      <span className="result-meta">
                        {[person.school, person.year].filter(Boolean).join(' · ')}
                        {person.studentCount > 0 && (
                          <>
                            <br />
                            {person.studentCount} student{person.studentCount === 1 ? '' : 's'}
                          </>
                        )}
                      </span>
                    </button>
                    {renderAction?.(index)}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
