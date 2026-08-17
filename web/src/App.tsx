import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { DatasetProvider } from './DatasetContext';
import { Home } from './pages/Home';
import { LcaPage } from './pages/LcaPage';
import { PersonPage } from './pages/PersonPage';
import { SearchPage } from './pages/SearchPage';

function Chrome() {
  const { pathname } = useLocation();
  // The cover carries the wordmark itself; a running head above it would say
  // the same thing twice.
  const onCover = pathname === '/';

  return (
    <>
      {!onCover && (
        <header className="runhead">
          <div className="inner">
            <Link className="brand" to="/">Mathematics Genealogy Visualizer</Link>
            <nav>
              <NavLink to="/search">Search</NavLink>
              <NavLink to="/lca">Common ancestors</NavLink>
            </nav>
          </div>
        </header>
      )}

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/person/:id" element={<PersonPage />} />
        <Route path="/lca" element={<LcaPage />} />
        <Route
          path="*"
          element={
            <div className="page narrow">
              <h1>Page not found</h1>
              <p style={{ marginTop: 16 }}><Link to="/">Back to the start</Link></p>
            </div>
          }
        />
      </Routes>

      {/* Attribution is an obligation; everything else was padding. */}
      <footer className="colophon">
        <div className="inner">
          Data from the{' '}
          <a href="https://www.genealogy.math.ndsu.nodak.edu/" target="_blank" rel="noreferrer">
            Mathematics Genealogy Project
          </a>
          . Snapshot seeded from{' '}
          <a href="https://github.com/pablit0o/MGP-visualizer" target="_blank" rel="noreferrer">
            pablit0o/MGP-visualizer
          </a>
          .
        </div>
      </footer>
    </>
  );
}

export function App() {
  return (
    <DatasetProvider>
      <Chrome />
    </DatasetProvider>
  );
}
