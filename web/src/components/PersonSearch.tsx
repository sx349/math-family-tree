/**
 * The search form, shared by the search page and the common-ancestor page.
 *
 * Both want the same fields and the same result list and differ only in what a
 * click on a result does — navigate, or add to a selection — so that is the one
 * thing passed in.
 *
 * Results are set as a table of contents: name, dotted leader, then where and
 * when. It reads far better than a two-column grid at this density, and it is
 * the pattern this typography already has for "label, then where to find it".
 *
 * Searching is explicit — submit, or press Enter. Results that rearranged
 * themselves under the cursor on every keystroke made the list impossible to
 * read while typing, and re-ran a full scan for every prefix of the query.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { useDataset } from '../DatasetContext';
import { DEFAULT_RESULT_LIMIT, search, type Query } from '../lib/search';

interface PersonSearchProps {
  /** Rendered at the end of each row; the row itself is the click target. */
  renderAction?: (index: number) => ReactNode;
  onPick: (index: number) => void;
  autoFocus?: boolean;
}

const EMPTY: Query = {};

export function PersonSearch({ renderAction, onPick, autoFocus }: PersonSearchProps) {
  const dataset = useDataset();
  const [query, setQuery] = useState<Query>(EMPTY);
  const [submitted, setSubmitted] = useState<Query | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const result = useMemo(
    () => (submitted ? search(dataset, submitted, DEFAULT_RESULT_LIMIT) : null),
    [dataset, submitted],
  );
  const update = (patch: Partial<Query>) => setQuery((current) => ({ ...current, ...patch }));
  const hasInput = Object.values(query).some((value) => value !== undefined && value !== '');

  const clear = () => {
    setQuery(EMPTY);
    setSubmitted(null);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(hasInput ? query : null);
      }}
    >
      <div className="field-grid">
        <div>
          <label htmlFor="family">Last / family name</label>
          <input
            id="family" type="text" autoFocus={autoFocus} placeholder="Erdős"
            value={query.family ?? ''}
            onChange={(event) => update({ family: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="given">First / given name</label>
          <input
            id="given" type="text" placeholder="Paul"
            value={query.given ?? ''}
            onChange={(event) => update({ given: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="school">School</label>
          <input
            id="school" type="text" placeholder="Princeton"
            value={query.school ?? ''}
            onChange={(event) => update({ school: event.target.value })}
          />
        </div>
      </div>

      {showAdvanced && (
        <div className="field-grid" style={{ marginTop: 22 }}>
          <div>
            <label htmlFor="country">Country</label>
            <input
              id="country" type="text" value={query.country ?? ''}
              onChange={(event) => update({ country: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="yearFrom">Degree year from</label>
            <input
              id="yearFrom" type="number" value={query.yearFrom ?? ''}
              onChange={(event) => update({ yearFrom: Number(event.target.value) || undefined })}
            />
          </div>
          <div>
            <label htmlFor="yearTo">Degree year to</label>
            <input
              id="yearTo" type="number" value={query.yearTo ?? ''}
              onChange={(event) => update({ yearTo: Number(event.target.value) || undefined })}
            />
          </div>
          <div>
            <label htmlFor="msc">Subject</label>
            <select
              id="msc" value={query.msc ?? ''}
              onChange={(event) => update({ msc: event.target.value || undefined })}
            >
              <option value="">Any subject</option>
              {dataset.dicts.mscs.filter(Boolean).sort().map((code) => (
                <option key={code} value={code}>
                  {code} — {dataset.dicts.mscLabels[code] ?? 'Other'}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="controls">
        <button className="button" type="submit" disabled={!hasInput}>Search</button>
        <button className="button quiet" type="button" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? 'Fewer fields' : 'More fields'}
        </button>
        {(hasInput || submitted) && (
          <button className="button quiet" type="button" onClick={clear}>Clear</button>
        )}
      </div>

      {result && (
        <>
          <p className="small faint" style={{ margin: 0 }}>
            {result.total === 0
              ? 'No matches.'
              : `${result.total.toLocaleString()} match${result.total === 1 ? '' : 'es'}` +
                (result.truncated ? `, showing the first ${result.indices.length}` : '')}
          </p>

          <ul className="contents">
            {result.indices.map((index) => {
              const person = dataset.person(index);
              const where = [person.school, person.year].filter(Boolean).join(', ');
              const students = person.studentCount > 0
                ? `${person.studentCount} student${person.studentCount === 1 ? '' : 's'}`
                : '';
              // Someone we hold only a name for simply has nothing to the right
              // of their name. Saying so, or ruling a leader out to a dash, is
              // noise — the empty column already reads as "nothing recorded".
              const meta = [where, students].filter(Boolean).join(' · ');
              return (
                <li key={index}>
                  <div className="row">
                    <button className="entry" type="button" onClick={() => onPick(index)}>
                      <span className="entry-who">
                        {dataset.displayName(index)} <span className="entry-id">#{person.id}</span>
                      </span>
                      {meta && (
                        <>
                          <span className="entry-leader" aria-hidden="true" />
                          <span className="entry-where">{meta}</span>
                        </>
                      )}
                    </button>
                    {renderAction?.(index)}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </form>
  );
}
