// The horizontal lockup from assets/brand/meterkat-lockup-*.svg (docs/brand.md: the wordmark is drawn, never typed).
// Inline, so the pages' CSP needs nothing extra; CSS colours the symbol (.symbol) and the wordmark (.word) per tone.
const SYMBOL = "M52 70A34 34 0 0 1 120 70V186A34 34 0 0 1 52 186Z M85 74A11 11 0 1 0 107 74A11 11 0 1 0 85 74Z M136 118A34 34 0 0 1 204 118V186A34 34 0 0 1 136 186Z M169 122A11 11 0 1 0 191 122A11 11 0 1 0 169 122Z";
const WORDMARK = [
  "M0 72L0 148A12 12 0 0 0 24 148L24 72A12 12 0 0 0 0 72Z",
  "M68 94A34 34 0 0 0 0 94A12 12 0 0 0 24 94A10 10 0 0 1 44 94A12 12 0 0 0 68 94Z",
  "M44 94L44 148A12 12 0 0 0 68 148L68 94A12 12 0 0 0 44 94Z",
  "M112 94A34 34 0 0 0 44 94A12 12 0 0 0 68 94A10 10 0 0 1 88 94A12 12 0 0 0 112 94Z",
  "M88 94L88 148A12 12 0 0 0 112 148L112 94A12 12 0 0 0 88 94Z",
  "M136 122L210 122A12 12 0 0 0 210 98L136 98A12 12 0 0 0 136 122Z",
  "M222 110A50 50 0 1 0 209.16 143.46A12 12 0 0 0 191.32 127.4A26 26 0 1 1 198 110A12 12 0 0 0 222 110Z",
  "M246 36L246 126A12 12 0 0 0 270 126L270 36A12 12 0 0 0 246 36Z",
  "M246 126A34 34 0 0 0 280 160A12 12 0 0 0 280 136A10 10 0 0 1 270 126A12 12 0 0 0 246 126Z",
  "M244 84L288 84A12 12 0 0 0 288 60L244 60A12 12 0 0 0 244 84Z",
  "M316 122L390 122A12 12 0 0 0 390 98L316 98A12 12 0 0 0 316 122Z",
  "M402 110A50 50 0 1 0 389.16 143.46A12 12 0 0 0 371.32 127.4A26 26 0 1 1 378 110A12 12 0 0 0 402 110Z",
  "M412 72L412 148A12 12 0 0 0 436 148L436 72A12 12 0 0 0 412 72Z",
  "M458 60A46 46 0 0 0 412 106A12 12 0 0 0 436 106A22 22 0 0 1 458 84A12 12 0 0 0 458 60Z",
  "M482 36L482 148A12 12 0 0 0 506 148L506 36A12 12 0 0 0 482 36Z",
  "M503.3 133.58L547.3 79.58A12 12 0 0 0 528.7 64.42L484.7 118.42A12 12 0 0 0 503.3 133.58Z",
  "M502.24 112.97L532.24 154.97A12 12 0 0 0 551.76 141.03L521.76 99.03A12 12 0 0 0 502.24 112.97Z",
  "M568 110A50 50 0 1 1 668 110A50 50 0 1 1 568 110Z M592 110A26 26 0 1 1 644 110A26 26 0 1 1 592 110Z",
  "M644 72L644 148A12 12 0 0 0 668 148L668 72A12 12 0 0 0 644 72Z",
  "M692 36L692 126A12 12 0 0 0 716 126L716 36A12 12 0 0 0 692 36Z",
  "M692 126A34 34 0 0 0 726 160A12 12 0 0 0 726 136A10 10 0 0 1 716 126A12 12 0 0 0 692 126Z",
  "M690 84L734 84A12 12 0 0 0 734 60L690 60A12 12 0 0 0 690 84Z",
];

/** The symbol alone (decorative, the lockup names the app), e.g. above the setup steps. */
export const SYMBOL_MARK = `<svg class="symbol-mark" viewBox="44 30 168 196" aria-hidden="true"><path fill-rule="evenodd" d="${SYMBOL}"/></svg>`;

/** The lockup as inline SVG markup, at least 120 px wide (docs/brand.md minimum size). */
export const LOCKUP = `<svg class="lockup" viewBox="0 24 922 136" role="img" aria-label="Meterkat"><g class="symbol" transform="translate(-38.43 -2.61) scale(0.7391)"><path fill-rule="evenodd" d="${SYMBOL}"/></g><g class="word" transform="translate(176.35 0)">${WORDMARK.map(d => `<path fill-rule="evenodd" d="${d}"/>`).join("")}</g></svg>`;
