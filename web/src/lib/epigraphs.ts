/**
 * Epigraphs for the cover, one drawn per visit.
 *
 * Mathematics is full of quotations that have drifted from whoever really said
 * them, and a genealogy is the wrong place to add to that. So every line here
 * carries its source, and the sources fall into three kinds:
 *
 *   · published  — the speaker wrote it, and the work is named. Where the
 *                  original is not in English, the standard translation is
 *                  used and named, rather than a fresh paraphrase.
 *   · reported   — someone who knew them wrote it down afterwards, and that
 *                  person is named. Kronecker's, Gauss's and Weyl's.
 *   · unchecked  — exactly one, Deng's, which carries its link and says so.
 *
 * Where a translation has been modernised rather than quoted as printed, the
 * entry says which words were changed and why. That is the difference between
 * an edit and the drift this file exists to keep out.
 *
 * The wordings were checked against Wikiquote and the translations named below
 * in August 2026, after two were found to have drifted here: Euler's had become
 * "nothing at all takes place ... some rule of maximum or minimum", and
 * Riemann's was a paraphrase of Clifford rather than Clifford.
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
    text: 'Nothing whatsoever takes place in the universe in which some relation of maximum and minimum does not appear.',
    who: 'Leonhard Euler',
    source:
      'De Curvis Elasticis, Additamentum I to Methodus inveniendi lineas curvas maximi minimive ' +
      'proprietate gaudentes, 1744. The sentence opens "For since the fabric of the universe is ' +
      'most perfect, and is the work of a most wise Creator, …"; the cover carries the second half.',
  },
  {
    text: 'Profound study of nature is the most fertile source of mathematical discoveries.',
    who: 'Joseph Fourier',
    source: 'Théorie analytique de la chaleur, 1822 — Alexander Freeman’s translation, 1878, ch. 1, p. 7',
  },
  {
    text: 'The unique end of science is the honor of the human mind.',
    who: 'Carl Gustav Jacob Jacobi',
    source:
      'Letter to Legendre, 2 July 1830, answering Fourier’s report to the Paris Academy that ' +
      'mathematics should serve the natural sciences; as quoted in Science, 10 March 1911, ' +
      'vol. 33, p. 359. Part of a longer sentence, which ends "…and that from this point of view ' +
      'a question of number is as important as a question of the system of the world."',
  },
  {
    text: 'This leads us into the domain of another science, of physics, into which the object of this work does not allow us to go today.',
    who: 'Bernhard Riemann',
    source:
      'Über die Hypothesen, welche der Geometrie zu Grunde liegen — habilitation lecture, ' +
      'Göttingen, 10 June 1854, closing words; W. K. Clifford’s translation, Nature, 1873. ' +
      'Spelling modernised: the standard transcription reads "of physic" and "to-day". The ' +
      'latter is ordinary 1873 hyphenation rather than an error; the German is "das Gebiet der ' +
      'Physik", so "physics" is what it means either way.',
  },
  {
    text: 'The essence of mathematics lies precisely in its freedom.',
    who: 'Georg Cantor',
    source: 'Grundlagen einer allgemeinen Mannigfaltigkeitslehre, 1883, §8',
  },
  {
    text: 'It is impossible to be a mathematician without being a poet in soul.',
    who: 'Sofia Kovalevskaya',
    source: 'Letter to Madame Schabelskoy, in Sonya Kovalevsky: Her Recollections of Childhood, 1895, p. 316',
  },
  {
    text: 'It is by logic that we prove, but by intuition that we discover.',
    who: 'Henri Poincaré',
    source: 'Science et méthode, 1908 — part II, ch. 2, "Mathematical Definitions and Education", p. 129',
  },
  {
    text: 'We must know. We will know.',
    who: 'David Hilbert',
    source: 'Address to the Society of German Scientists and Physicians, Königsberg, 8 September 1930',
  },
  {
    text: 'Beauty is the first test: there is no permanent place in the world for ugly mathematics.',
    who: 'G. H. Hardy',
    source: 'A Mathematician’s Apology, 1940, §10',
  },
  {
    text: 'An equation for me has no meaning unless it expresses a thought of God.',
    who: 'Srinivasa Ramanujan',
    source: 'Reported by his biographers; no contemporary source is agreed on',
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
    // The one line here nobody need take seriously, and the only one I have not
    // been able to check. It is kept because a genealogy of advisors and
    // students is also a record of people, and people are not only theorems.
    text: 'What are some good yuri fan works?',
    who: 'Deng Yu',
    source:
      'Question posted on Zhihu — 有哪些优秀的百合同人作品？ ' +
      'https://www.zhihu.com/question/28176357 — supplied by this site’s maintainer; ' +
      'the one line here not checked against a source from this machine.',
  },
];

/** A different one each visit; the cover is a printed page, not a carousel. */
export function pickEpigraph(): Epigraph {
  return EPIGRAPHS[Math.floor(Math.random() * EPIGRAPHS.length)];
}
