/**
 * Epigraphs for the cover, one drawn per visit.
 *
 * Every line here is one the speaker is actually on record for, with the source
 * kept beside it so the attribution can be checked rather than trusted. Two are
 * reported remarks rather than published writing — Kronecker's and Gauss's come
 * from people who knew them, written down after the fact — and they are marked
 * as such. Mathematics is full of quotations that have drifted from whoever
 * really said them, and a genealogy has no business adding to that.
 *
 * The cover shows the words and the name; the source is here.
 */

export interface Epigraph {
  text: string;
  who: string;
  /** Where it is on record, for anyone checking. */
  source: string;
}

export const EPIGRAPHS: readonly Epigraph[] = [
  {
    text: 'If I have seen further it is by standing on the shoulders of Giants.',
    who: 'Isaac Newton',
    source: 'Letter to Robert Hooke, 5 February 1676',
  },
  {
    text: 'We must know. We will know.',
    who: 'David Hilbert',
    source: 'Address to the Society of German Scientists and Physicians, Königsberg, 8 September 1930',
  },
  {
    text: 'The essence of mathematics lies precisely in its freedom.',
    who: 'Georg Cantor',
    source: 'Grundlagen einer allgemeinen Mannigfaltigkeitslehre, 1883, §8',
  },
  {
    text: 'God made the integers; all else is the work of man.',
    who: 'Leopold Kronecker',
    source: 'Reported by Heinrich Weber, Jahresbericht der DMV, 1893',
  },
  {
    text: 'Beauty is the first test: there is no permanent place in the world for ugly mathematics.',
    who: 'G. H. Hardy',
    source: 'A Mathematician’s Apology, 1940, §10',
  },
  {
    text: 'It is by logic that we prove, but by intuition that we discover.',
    who: 'Henri Poincaré',
    source: 'Science et méthode, 1908',
  },
  {
    text: 'Mathematics is the queen of the sciences.',
    who: 'Carl Friedrich Gauss',
    source: 'Reported by Sartorius von Waltershausen, Gauss zum Gedächtniss, 1856',
  },
];

/** A different one each visit; the cover is a printed page, not a carousel. */
export function pickEpigraph(): Epigraph {
  return EPIGRAPHS[Math.floor(Math.random() * EPIGRAPHS.length)];
}
