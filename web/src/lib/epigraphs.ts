/**
 * Epigraphs for the cover, one drawn per visit.
 *
 * Mathematics is full of quotations that have drifted from whoever really said
 * them, and a genealogy is the wrong place to add to that. So every line here
 * carries its source, and the sources fall into three kinds:
 *
 *   · published — the speaker wrote it, and the work is named.
 *   · reported  — someone who knew them wrote it down afterwards, and that
 *                 person is named. Kronecker's and Gauss's are of this kind.
 *   · attributed — widely quoted, no contemporary source anyone agrees on.
 *                 Kept because they are worth keeping, marked because they are
 *                 not evidence.
 *
 * The cover shows the words and the name; the source is here, so an attribution
 * can be checked rather than trusted.
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
    text: 'Nothing at all takes place in the universe in which some rule of maximum or minimum does not appear.',
    who: 'Leonhard Euler',
    source: 'Methodus inveniendi lineas curvas maximi minimive proprietate gaudentes, 1744, Additamentum I',
  },
  {
    text: 'The profound study of nature is the most fertile source of mathematical discoveries.',
    who: 'Joseph Fourier',
    source: 'Théorie analytique de la chaleur, 1822, Discours préliminaire',
  },
  {
    text: 'This leads us into the domain of another science, into the realm of physics, which the nature of the present occasion does not allow us to enter.',
    who: 'Bernhard Riemann',
    source: 'Über die Hypothesen, welche der Geometrie zu Grunde liegen — habilitation lecture, Göttingen, 10 June 1854, closing words',
  },
  {
    text: 'The essence of mathematics lies precisely in its freedom.',
    who: 'Georg Cantor',
    source: 'Grundlagen einer allgemeinen Mannigfaltigkeitslehre, 1883, §8',
  },
  {
    text: 'We must know. We will know.',
    who: 'David Hilbert',
    source: 'Address to the Society of German Scientists and Physicians, Königsberg, 8 September 1930',
  },
  {
    text: 'It is by logic that we prove, but by intuition that we discover.',
    who: 'Henri Poincaré',
    source: 'Science et méthode, 1908',
  },
  {
    text: 'Beauty is the first test: there is no permanent place in the world for ugly mathematics.',
    who: 'G. H. Hardy',
    source: 'A Mathematician’s Apology, 1940, §10',
  },
  {
    text: 'God made the integers; all else is the work of man.',
    who: 'Leopold Kronecker',
    source: 'Reported by Heinrich Weber, Jahresbericht der DMV, 1893',
  },
  {
    text: 'Mathematics is the queen of the sciences.',
    who: 'Carl Friedrich Gauss',
    source: 'Reported by Sartorius von Waltershausen, Gauss zum Gedächtniss, 1856',
  },
  {
    text: 'My work always tried to unite the true with the beautiful; but when I had to choose one or the other, I usually chose the beautiful.',
    who: 'Hermann Weyl',
    source: 'Reported by Freeman Dyson, obituary of Weyl, Nature, 1956',
  },
  {
    text: 'It is impossible to be a mathematician without being a poet in soul.',
    who: 'Sofia Kovalevskaya',
    source: 'Attributed — widely quoted from her letters, with no single agreed source',
  },
  {
    text: 'An equation for me has no meaning unless it expresses a thought of God.',
    who: 'Srinivasa Ramanujan',
    source: 'Attributed — reported by his biographers, with no contemporary source',
  },
];

/** A different one each visit; the cover is a printed page, not a carousel. */
export function pickEpigraph(): Epigraph {
  return EPIGRAPHS[Math.floor(Math.random() * EPIGRAPHS.length)];
}
