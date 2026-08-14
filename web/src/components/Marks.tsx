/**
 * The wordmark and the ornament.
 *
 * Both are drawn as SVG rather than set as HTML text: the wordmark needs the
 * descriptor centred between rules at a fixed relation to the capitals, and
 * the ornament is a drawing. Keeping them here means the cover stays free of
 * fifty lines of path data.
 */

const INK = '#262d28';

/**
 * Set solid in Caslon Open Face. The face is *inline* — the light line is cut
 * into each letterform by the punchcutter and varies with the stroke — so it
 * must not be stroked or outlined, which would fight the drawing already there.
 */
export function Wordmark() {
  return (
    <svg className="wordmark" viewBox="0 0 720 220" role="img" aria-label="Mathematics Genealogy Visualizer">
      <g fontFamily="'Caslon Open Face', Cochin, 'Hoefler Text', Baskerville, Georgia, serif" textAnchor="middle" fill={INK}>
        <text x="360" y="70" fontSize="76" letterSpacing="4">MATHEMATICS</text>
        <text x="360" y="150" fontSize="76" letterSpacing="4">GENEALOGY</text>
      </g>
      {/* The descriptor is subordinate: tracked capitals between short rules,
          rather than a third line of display type competing with the name. */}
      <g stroke={INK} strokeWidth="0.9">
        <line x1="168" y1="190" x2="258" y2="190" />
        <line x1="462" y1="190" x2="552" y2="190" />
      </g>
      <text
        x="360" y="195" textAnchor="middle" fill={INK} fontSize="20" letterSpacing="4"
        fontFamily="Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif"
        fontWeight="500"
      >
        VISUALIZER
      </text>
    </svg>
  );
}

/**
 * An eight-pointed interlace whose interior is a three-node lineage rather
 * than a monogram, so the mark states the subject instead of decorating it.
 */
export function Ornament({ size = 132 }: { size?: number }) {
  return (
    <svg className="ornament" width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="An advisor and three students within an eight-pointed star">
      <g fill="none" stroke={INK} strokeWidth="1.6" strokeLinejoin="round">
        <path d="M66 6 L84 24 L109 20 L105 45 L126 66 L105 87 L109 112 L84 108 L66 126 L48 108 L23 112 L27 87 L6 66 L27 45 L23 20 L48 24 Z" />
        <path d="M66 18 L79 31 L97 28 L94 46 L109 66 L94 86 L97 104 L79 101 L66 114 L53 101 L35 104 L38 86 L23 66 L38 46 L35 28 L53 31 Z" strokeWidth="1" />
      </g>
      <g fill="none" stroke={INK} strokeWidth="1.2">
        <path d="M66 48 L48 78 M66 48 L66 78 M66 48 L84 78" />
      </g>
      <g fill={INK}>
        <circle cx="66" cy="46" r="4.2" />
        <circle cx="48" cy="80" r="3.4" />
        <circle cx="66" cy="80" r="3.4" />
        <circle cx="84" cy="80" r="3.4" />
      </g>
    </svg>
  );
}
