import { Link } from 'react-router-dom';

import { Ornament, Wordmark } from '../components/Marks';
import { useDataset } from '../DatasetContext';

/** "2026-06-22" -> "22 June 2026". */
function longDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function Home() {
  const dataset = useDataset();
  const { manifest } = dataset;

  return (
    <div className="page narrow">
      {/* The home page is set as a title page: centred, because a title page
          has no work to do. Every other page is set left, because they do. */}
      <header className="cover">
        <Wordmark />

        <p className="cover-lede">
          Every doctorate has a supervisor, and every supervisor had one. Follow the line back
          far enough and most of mathematics converges.
        </p>

        {/* Read from the manifest so a data refresh updates the cover without
            anyone having to remember to edit it. */}
        <p className="cover-count label">
          <span className="num">{manifest.nodeCount.toLocaleString()}</span> mathematicians
          &nbsp;·&nbsp;
          <span className="num">{manifest.edgeCount.toLocaleString()}</span> advisor links
        </p>
        <p className="cover-source label">
          From the Mathematics Genealogy Project &nbsp;·&nbsp;
          <span className="num">{longDate(manifest.dataDate ?? manifest.builtAt)}</span>
        </p>

        <nav className="cover-actions">
          <Link className="action" to="/search">Search for a mathematician</Link>
          <Link className="action" to="/lca">Find a common ancestor</Link>
        </nav>

        <Ornament />
      </header>

      <h2>What you can do here</h2>
      <p>
        Every mathematician has a page showing their immediate neighbourhood — advisors above,
        students below — which you can widen a generation at a time. Because prolific advisors
        expand quickly, the diagram grows only as far as it can stay readable and offers the
        rest as <em>+N</em> handles you can open where you want them.
      </p>
      <p>
        The <Link to="/lca">common ancestor</Link> page takes up to five people and finds the
        lowest advisor they all descend from, drawing only the paths that connect them. Advisor
        relationships form a directed acyclic graph rather than a tree — tens of thousands of
        people here have two advisors — so there can be several equally-lowest ancestors, and
        all of them are shown. Where the selected people share no ancestry, the result is a
        forest rather than a single tree.
      </p>

      <h2>About the data</h2>
      <ul className="facts">
        <li>
          <span className="key">People</span>
          <span>
            <span className="num">{manifest.nodeCount.toLocaleString()}</span>
            {manifest.stubCount > 0 && (
              <span className="faint small">
                {' '}({manifest.stubCount.toLocaleString()} of them name-only)
              </span>
            )}
          </span>
        </li>
        <li>
          <span className="key">Advisor links</span>
          <span className="num">{manifest.edgeCount.toLocaleString()}</span>
        </li>
        <li>
          <span className="key">Data collected</span>
          <span className="num">{longDate(manifest.dataDate ?? manifest.builtAt)}</span>
        </li>
      </ul>
      <p className="small faint" style={{ marginTop: 20 }}>
        A static snapshot, not a live mirror. Names, theses and advisor links all come from the
        Mathematics Genealogy Project; corrections belong upstream with them, and every person
        here links back to their MGP page. Some people are referenced by MGP as an advisor or a
        student without our snapshot holding their record — those appear as name-only entries.
      </p>
    </div>
  );
}
