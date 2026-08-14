import { Link } from 'react-router-dom';

import { useDataset } from '../DatasetContext';

export function Home() {
  const dataset = useDataset();
  const { manifest } = dataset;
  const snapshotDate = manifest.builtAt.slice(0, 10);

  return (
    <div className="page narrow">
      <h1>Math Family Tree</h1>
      <p className="lede">
        Mathematicians inherit their subject from their doctoral advisors, and those advisors
        from theirs. This site draws those lineages as graphs, using data from the{' '}
        <a href="https://www.genealogy.math.ndsu.nodak.edu/" target="_blank" rel="noreferrer">
          Mathematics Genealogy Project
        </a>
        .
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '28px 0 8px' }}>
        <Link className="button primary" to="/search">
          Search for a mathematician
        </Link>
        <Link className="button" to="/lca">
          Find a common ancestor
        </Link>
      </div>

      <h2>What you can do here</h2>
      <p>
        Every mathematician has a page showing their <strong>immediate neighbourhood</strong> —
        advisors above, students below — which you can widen a generation at a time. Because
        prolific advisors explode quickly (David Hilbert has 82 people one step away, 544 within
        two steps and 2,770 within three), the diagram expands only as far as it can stay
        readable, and shows the rest as <em>+N more</em> handles you can open where you want them.
      </p>
      <p>
        The <Link to="/lca">common ancestor</Link> page takes up to five people and finds the
        lowest advisor they all descend from, drawing only the paths that connect them. Advisor
        relationships form a directed acyclic graph rather than a tree — 55,201 people here have
        two advisors and 5,112 have three — so there can be several equally-lowest ancestors, and
        all of them are shown. If the selected people share no ancestor within the depth limit,
        the result is a forest rather than a single tree.
      </p>

      <h2>About the data</h2>
      <ul className="facts">
        <li>
          <span className="key">People</span>
          <span>
            {manifest.nodeCount.toLocaleString()}
            {manifest.stubCount > 0 && (
              <span className="muted small">
                {' '}
                ({manifest.stubCount.toLocaleString()} of them name-only)
              </span>
            )}
          </span>
        </li>
        <li>
          <span className="key">Advisor links</span>
          <span>{manifest.edgeCount.toLocaleString()}</span>
        </li>
        <li>
          <span className="key">Snapshot built</span>
          <span>{snapshotDate}</span>
        </li>
      </ul>
      <p className="small muted" style={{ marginTop: 18 }}>
        This is a static snapshot, not a live mirror. Names, theses and advisor links all come
        from the Mathematics Genealogy Project; corrections belong upstream with them, and every
        person here links back to their MGP page. Some people are referenced by MGP as an advisor
        or student without our snapshot holding their record — those appear as name-only entries.
      </p>
    </div>
  );
}
