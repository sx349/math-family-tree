/**
 * Name search over the in-memory dataset.
 *
 * MGP's own search combines fields with OR — filling in both a first and a last
 * name returns everyone matching *either*, which makes finding a specific person
 * with a common name hard.  Every field here is combined with AND, which is what
 * people expect.
 *
 * Family-name queries binary-search the precomputed name order and touch only
 * matching records; every other field narrows that candidate set, or scans when
 * a family name was not given.
 */

import type { Dataset } from './dataset';

export interface Query {
  family?: string;
  given?: string;
  other?: string;
  school?: string;
  country?: string;
  msc?: string;
  yearFrom?: number;
  yearTo?: number;
  includeStubs?: boolean;
}

export interface SearchResult {
  indices: number[];
  /** Total matches, which may exceed `indices.length` when capped. */
  total: number;
  truncated: boolean;
  /** True when the query had to scan every node rather than seek. */
  scanned: boolean;
}

export const DEFAULT_RESULT_LIMIT = 100;

// Characters NFKD leaves alone but searchers expect to be interchangeable with
// their ASCII forms. Must stay in sync with FOLD_MAP in pipeline/build_web.py.
const FOLD_MAP: Record<string, string> = {
  ß: 'ss', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  đ: 'd', Đ: 'd', ł: 'l', Ł: 'l', ð: 'd', Ð: 'd', þ: 'th',
  Þ: 'th', ı: 'i', İ: 'i', ŉ: 'n',
};

/** Fold a query string the same way the pipeline folded the stored names. */
export function fold(text: string): string {
  let mapped = '';
  for (const character of text) mapped += FOLD_MAP[character] ?? character;
  return mapped.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * First position in the name order whose folded name is >= `prefix`.
 *
 * The order was produced by the pipeline using the same folding, so this is a
 * plain binary search: ~18 name decodes for a 332k-node dataset.
 */
function lowerBound(dataset: Dataset, prefix: string): number {
  let low = 0;
  let high = dataset.nameOrder.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (dataset.foldedName(dataset.nameOrder[mid]) < prefix) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Candidate nodes whose folded family name starts with `prefix`. */
function byFamilyPrefix(dataset: Dataset, prefix: string): number[] {
  const matches: number[] = [];
  for (let position = lowerBound(dataset, prefix); position < dataset.nameOrder.length; position++) {
    const index = dataset.nameOrder[position];
    if (!dataset.foldedName(index).startsWith(prefix)) break;
    matches.push(index);
  }
  return matches;
}

export function search(
  dataset: Dataset,
  query: Query,
  limit: number = DEFAULT_RESULT_LIMIT,
): SearchResult {
  const family = fold((query.family ?? '').trim());
  const given = fold((query.given ?? '').trim());
  const other = fold((query.other ?? '').trim());
  const school = fold((query.school ?? '').trim());
  const country = fold((query.country ?? '').trim());
  const msc = (query.msc ?? '').trim();
  const { yearFrom, yearTo, includeStubs = true } = query;

  const hasFilter =
    family || given || other || school || country || msc || yearFrom || yearTo;
  if (!hasFilter) return { indices: [], total: 0, truncated: false, scanned: false };

  // Cache folded dictionary entries so a scan does not refold them per node.
  const foldedSchools = school ? dataset.dicts.schools.map(fold) : null;
  const foldedCountries = country ? dataset.dicts.countries.map(fold) : null;

  const matches = (index: number): boolean => {
    if (!includeStubs && dataset.isStub(index)) return false;

    if (given || other) {
      const parts = dataset.foldedName(index).split('\t');
      // MGP splits names inconsistently across given/other, so a term typed in
      // either box is matched against both rather than only its own field.
      const tail = `${parts[1] ?? ''} ${parts[2] ?? ''}`;
      if (given && !tail.includes(given)) return false;
      if (other && !tail.includes(other)) return false;
    }
    if (foldedSchools && !foldedSchools[dataset.schoolIds[index]].includes(school)) return false;
    if (foldedCountries && !foldedCountries[dataset.countryIds[index]].includes(country)) return false;
    if (msc && dataset.dicts.mscs[dataset.mscIds[index]] !== msc) return false;

    if (yearFrom || yearTo) {
      const year = dataset.years[index];
      if (!year) return false; // an undated degree cannot satisfy a date range
      if (yearFrom && year < yearFrom) return false;
      if (yearTo && year > yearTo) return false;
    }
    return true;
  };

  const candidates = family ? byFamilyPrefix(dataset, family) : null;
  const indices: number[] = [];
  let total = 0;

  const consider = (index: number): void => {
    if (!matches(index)) return;
    total++;
    if (indices.length < limit) indices.push(index);
  };

  if (candidates) {
    for (const index of candidates) consider(index);
  } else {
    // No family name to seek on, so every node has to be examined. At ~332k
    // nodes this is tens of milliseconds — worth it to keep the feature working
    // for "everyone at Princeton in 1950" style queries.
    for (let index = 0; index < dataset.count; index++) consider(index);
  }

  // Family-prefix results arrive already sorted by name; scans arrive in id
  // order, which is meaningless to a reader, so sort those by name.
  if (!candidates) {
    indices.sort((a, b) => (dataset.foldedName(a) < dataset.foldedName(b) ? -1 : 1));
  }

  return { indices, total, truncated: total > indices.length, scanned: !candidates };
}

/** Fast path for the type-ahead box: family-name prefix only. */
export function quickSearch(dataset: Dataset, text: string, limit = 20): number[] {
  const trimmed = text.trim();
  if (trimmed.length < 2) return [];
  // "Deng, Yu" and "Deng Yu" both work: everything after the first separator is
  // treated as a given-name filter.
  const [familyPart, ...rest] = trimmed.split(/[,\s]+/);
  return search(
    dataset,
    { family: familyPart, given: rest.join(' ') || undefined },
    limit,
  ).indices;
}
