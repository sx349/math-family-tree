import { Link, NavLink, Route, Routes } from 'react-router-dom';

import { DatasetProvider } from './DatasetContext';
import { Home } from './pages/Home';
import { LcaPage } from './pages/LcaPage';
import { PersonPage } from './pages/PersonPage';
import { SearchPage } from './pages/SearchPage';

export function App() {
  return (
    <DatasetProvider>
      <header className="masthead">
        <div className="inner">
          <Link className="brand" to="/">
            Math Family Tree
          </Link>
          <nav>
            <NavLink to="/search">Search</NavLink>
            <NavLink to="/lca">Common ancestors</NavLink>
          </nav>
        </div>
      </header>

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
              <p>
                <Link to="/">Back to the start</Link>
              </p>
            </div>
          }
        />
      </Routes>

      <footer className="site">
        <div className="inner">
          Data from the{' '}
          <a href="https://www.genealogy.math.ndsu.nodak.edu/" target="_blank" rel="noreferrer">
            Mathematics Genealogy Project
          </a>
          , North Dakota State University. This site is an independent visualisation and is not
          affiliated with them.
        </div>
      </footer>
    </DatasetProvider>
  );
}
