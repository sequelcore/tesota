/**
 * Whether LemmaScript extracts a top-level function into the program it
 * proves, as `extract.js` in LemmaScript 0.6.4 decides: never one it skips
 * (`//@ skip`); a function it trusts (`//@ extern`) as an axiom; and any
 * other only when the file does not select functions with `//@ verify`
 * (`selective`), or selects this one (`marked`). Once any function in a file
 * carries `//@ verify`, the others are left out without a word.
 */
//@ ensures \result <==> !skipped && (externed || !selective || marked)
export function extracted(skipped: boolean, externed: boolean, selective: boolean, marked: boolean): boolean {
  return !skipped && (externed || !selective || marked);
}
