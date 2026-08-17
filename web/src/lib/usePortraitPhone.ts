import { useEffect, useState } from 'react';

// Matches the codebase's existing 640px breakpoint. A phone in portrait
// cannot show a genealogy diagram at any useful depth — dagre's layout
// needs width to spread generations sideways — so below this size the
// pages skip the graph computation entirely rather than shrink it.
const QUERY = '(max-width: 640px) and (orientation: portrait)';

export function usePortraitPhone(): boolean {
  const [portrait, setPortrait] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setPortrait(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return portrait;
}
