/**
 * Loads the dataset once for the whole app and shares it via context.
 *
 * The core bundle is ~7 MB gzipped and every page needs it, so it is fetched on
 * first mount and then held for the session — navigating between search, a
 * person and the LCA page costs no further network traffic.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { Wordmark } from './components/Marks';
import { Dataset, type LoadStage } from './lib/dataset';

const DATA_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/data`;

const DatasetContext = createContext<Dataset | null>(null);

export function useDataset(): Dataset {
  const dataset = useContext(DatasetContext);
  if (!dataset) throw new Error('useDataset used outside DatasetProvider');
  return dataset;
}

export function DatasetProvider({ children }: { children: ReactNode }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [stage, setStage] = useState<LoadStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Dataset.load(DATA_BASE, setStage, controller.signal)
      .then(setDataset)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="page narrow loading">
        <div className="loading-inner">
          <h1>Could not load the genealogy data</h1>
          <p className="muted">{error}</p>
          <p className="small faint">
            The data files are expected under <code>{DATA_BASE}/</code>. Building locally, run{' '}
            <code>python3 pipeline/build_web.py</code> and link the output into{' '}
            <code>web/public/data</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!dataset) {
    const percent = stage && stage.total ? Math.round((stage.loaded / stage.total) * 100) : 0;
    return (
      <div className="page narrow loading">
        <div className="loading-inner">
          <Wordmark />
          <div className="progress" role="progressbar" aria-valuenow={percent}>
            <div style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    );
  }

  return <DatasetContext.Provider value={dataset}>{children}</DatasetContext.Provider>;
}
