import { Link } from 'react-router-dom';

import { Ornament, Wordmark } from '../components/Marks';
import { useDataset } from '../DatasetContext';

/** "2026-06-22" -> "22 June 2026". */
function longDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * A title page, and nothing else. It has one job — say what this is and let you
 * in — and the counts already answer the only question a reader has before
 * clicking, which is whether the thing is any good.
 */
export function Home() {
  const { manifest } = useDataset();

  return (
    <div className="page narrow">
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
    </div>
  );
}
