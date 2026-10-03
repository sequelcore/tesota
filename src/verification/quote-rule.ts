/**
 * Issue #300's rule for a page reader's quote. The reader is a model, so its
 * quotes are its claims about the page; Tesota records one as evidence only
 * when it found the quote on the page it fetched, the quote is not empty and
 * at most `lengthLimit` characters, and fewer than `countLimit` of that page's
 * quotes are already kept. Any other quote is left out, and counted.
 */
//@ requires length >= 0 && kept >= 0
//@ ensures \result <==> (found && length >= 1 && length <= lengthLimit && kept < countLimit)
export function quoteKept(found: boolean, length: number, kept: number, lengthLimit: number, countLimit: number): boolean {
  if (!found || length < 1) return false;
  return length <= lengthLimit && kept < countLimit;
}
