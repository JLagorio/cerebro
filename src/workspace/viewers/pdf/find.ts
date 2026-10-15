export interface PdfMatches {
  current: number;
  total: number;
}
/** PDF.js's find controller does literal strings; no user input becomes a regex. */
export function findRequest(query: string, again = false, previous = false) {
  return {
    type: again ? 'again' : '',
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  };
}
export function matchWords(matches: PdfMatches, query: string): string {
  if (!query) return '';
  return `${matches.current} of ${matches.total}`;
}
