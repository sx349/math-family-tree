import { useNavigate } from 'react-router-dom';

import { PersonSearch } from '../components/PersonSearch';
import { useDataset } from '../DatasetContext';

export function SearchPage() {
  const dataset = useDataset();
  const navigate = useNavigate();

  return (
    <div className="page narrow">
      <h1>Search</h1>
      <p className="lede">
        Click any result to open their genealogy.
      </p>
      <PersonSearch autoFocus onPick={(index) => navigate(`/person/${dataset.ids[index]}`)} />
    </div>
  );
}
