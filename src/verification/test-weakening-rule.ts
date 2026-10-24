import type { ChangeStatus } from "../diff-lines.js";

/**
 * Whether a line a change removed from a test file removes or changes what
 * its tests check: any line but a blank or comment-only one, an import
 * the change widened (`widenedImport`): one an added line replaces with an
 * import from the same module, in the same form, of every name it had and
 * more, or a line the change extended (`extended`): one the added line in
 * its place keeps whole, adding only arguments, properties or parameters
 * that check nothing (`addsItems`), or a line that only holds assertions the
 * change made stricter (`tightened`, `assertionChange`). A line that only
 * moved still counts, and so does an assertion commented out, since its
 * original line is removed.
 */
//@ ensures \result <==> !blank && !comment && !widenedImport && !extended && !tightened
export function removalCounts(blank: boolean, comment: boolean, widenedImport: boolean, extended: boolean, tightened: boolean): boolean {
  return !blank && !comment && !widenedImport && !extended && !tightened;
}

/**
 * How an assertion's check changed, read without its `not`: not at all
 * (`same`); to one that implies it, so it admits fewer values (`stricter`),
 * such as `toEqual(x)` to `toBe(x)` or more `toBeCloseTo` digits; to one it
 * implies, so it admits more (`weaker`), such as `toBe(3)` to `toBeTruthy()`;
 * to a matcher only ranked weaker, without either implying the other
 * (`ranked_weaker`), such as `toBe(x)` to `toBeTruthy()` for an `x` not
 * written as a value; or otherwise.
 */
export type CheckChange = "same" | "stricter" | "weaker" | "ranked_weaker" | "other";

/** What a change did to an assertion on the same subject (`assertionChange`). */
export type AssertionChange = "kept" | "tightened" | "loosened" | "dropped_not" | "changed";

/**
 * How a test edit changed an assertion on the same subject, from whether
 * each side is negated with `not` and how its check changed (`check`). A
 * dropped `not` is named; an added one changes what it checks. Under a `not`
 * on both sides an implication turns around, so a weaker check makes the
 * assertion stricter; a rank alone does not, so it changes it. Only an
 * implication ever makes an assertion stricter (`tightened`), which then
 * weakens nothing.
 */
//@ ensures beforeNot && !afterNot ==> \result === "dropped_not"
//@ ensures !beforeNot && afterNot ==> \result === "changed"
//@ ensures beforeNot === afterNot ==> (\result === "kept" <==> check === "same")
//@ ensures beforeNot === afterNot && check === "other" ==> \result === "changed"
//@ ensures beforeNot === afterNot && check === "stricter" && !beforeNot ==> \result === "tightened"
//@ ensures beforeNot === afterNot && check === "stricter" && beforeNot ==> \result === "loosened"
//@ ensures beforeNot === afterNot && check === "weaker" && !beforeNot ==> \result === "loosened"
//@ ensures beforeNot === afterNot && check === "weaker" && beforeNot ==> \result === "tightened"
//@ ensures beforeNot === afterNot && check === "ranked_weaker" && !beforeNot ==> \result === "loosened"
//@ ensures beforeNot === afterNot && check === "ranked_weaker" && beforeNot ==> \result === "changed"
//@ ensures \result === "tightened" ==> beforeNot === afterNot && ((check === "stricter" && !beforeNot) || (check === "weaker" && beforeNot))
export function assertionChange(beforeNot: boolean, afterNot: boolean, check: CheckChange): AssertionChange {
  if (beforeNot && !afterNot) return "dropped_not";
  if (beforeNot !== afterNot) return "changed";
  if (check === "same") return "kept";
  if (check === "other") return "changed";
  if (check === "ranked_weaker") return beforeNot ? "changed" : "loosened";
  return (check === "weaker") !== beforeNot ? "loosened" : "tightened";
}

/**
 * What a token of a line is to `addsItems`: a bracket that opens or closes a
 * list, a separator between its items, a token that checks or skips
 * something, or comments out or quotes what follows it (`check`), or any
 * other.
 */
export type TokenKind = "open" | "close" | "separator" | "check" | "plain";

export interface Token {
  readonly text: string;
  readonly kind: TokenKind;
}

/** How many more brackets `tokens[lo..hi]` open than they close. */
//@ requires 0 <= lo && lo <= hi && hi <= tokens.length
//@ decreases hi - lo
export function depth(tokens: readonly Token[], lo: number, hi: number): number {
  if (lo === hi) return 0;
  const kind = (tokens[hi - 1] as Token).kind;
  return depth(tokens, lo, hi - 1) + (kind === "open" ? 1 : kind === "close" ? -1 : 0);
}

/** Whether `tokens[lo..hi]` close no bracket before them: no prefix of them closes more than it opens. */
//@ requires 0 <= lo && lo <= hi && hi <= tokens.length
//@ decreases hi - lo
export function nested(tokens: readonly Token[], lo: number, hi: number): boolean {
  return lo === hi || (depth(tokens, lo, hi) >= 0 && nested(tokens, lo, hi - 1));
}

/**
 * Whether `tokens[lo..hi]`, not empty, sit where a list item can be added:
 * after an opening bracket, a separator or the start of the line and ending
 * in a separator, or starting with a separator before a closing bracket or
 * the end of the line, or as the only item between two brackets.
 */
//@ requires 0 <= lo && lo < hi && hi <= tokens.length
export function placed(tokens: readonly Token[], lo: number, hi: number): boolean {
  const opens = lo === 0 || (tokens[lo - 1] as Token).kind === "open" || (tokens[lo - 1] as Token).kind === "separator";
  const closes = hi === tokens.length || (tokens[hi] as Token).kind === "close";
  const first = (tokens[lo] as Token).kind;
  const last = (tokens[hi - 1] as Token).kind;
  return (opens && last === "separator") || (first === "separator" && closes) ||
    (lo > 0 && (tokens[lo - 1] as Token).kind === "open" && hi < tokens.length && (tokens[hi] as Token).kind === "close");
}

/**
 * Whether the tokens `tokens[lo..hi]` a replacement adds are whole list
 * items: none, or tokens that close every bracket they open and no other
 * (`depth`, `nested`), where an item can be added (`placed`).
 */
//@ requires 0 <= lo && lo <= hi && hi <= tokens.length
export function item(tokens: readonly Token[], lo: number, hi: number): boolean {
  return lo === hi || (depth(tokens, lo, hi) === 0 && nested(tokens, lo, hi) && placed(tokens, lo, hi));
}

/** `item`, in one pass over the tokens. */
//@ requires 0 <= lo && lo <= hi && hi <= tokens.length
//@ ensures \result <==> item(tokens, lo, hi)
export function isItem(tokens: readonly Token[], lo: number, hi: number): boolean {
  if (lo === hi) return true;
  let open = 0;
  let k = lo;
  while (k < hi) {
    //@ invariant lo <= k && k <= hi
    //@ invariant open === depth(tokens, lo, k)
    //@ invariant nested(tokens, lo, k)
    const kind = (tokens[k] as Token).kind;
    open = open + (kind === "open" ? 1 : kind === "close" ? -1 : 0);
    if (open < 0) return false;
    k = k + 1;
  }
  return open === 0 && placed(tokens, lo, hi);
}

/** Where the tokens a replacement adds before the `g`-th it keeps, or after the last, start. */
//@ requires 0 <= g && g <= at.length
export function gapStart(at: readonly number[], g: number): number {
  return g === 0 ? 0 : (at[g - 1] as number) + 1;
}

/** Where the tokens a replacement adds before the `g`-th it keeps, or after the last, end. */
//@ requires 0 <= g && g <= at.length
export function gapEnd(at: readonly number[], g: number, length: number): number {
  return g === at.length ? length : at[g] as number;
}

/**
 * Whether `after`, the line that replaces a removed line of a test file,
 * keeps every token of the removed line (`before`) in order and adds only
 * whole list items, such as arguments, properties or parameters (`item`),
 * none of them a check: `at` gives where `after` keeps each token of
 * `before`. A replacement that adds a check, or a token that comments out
 * or quotes what follows it, is never one, nor a removed line that holds a
 * check, since `after` keeps its tokens.
 */
//@ ensures \result ==> at.length === before.length
//@ ensures \result ==> forall(i: nat, i < at.length ==> 0 <= at[i] && at[i] < after.length && after[at[i]].text === before[i])
//@ ensures \result ==> forall(i: nat, i + 1 < at.length ==> at[i] < at[i + 1])
//@ ensures \result ==> forall(j: nat, j < after.length ==> after[j].kind !== "check")
//@ ensures \result ==> forall(g: nat, g <= at.length ==> item(after, gapStart(at, g), gapEnd(at, g, after.length)))
export function addsItems(before: readonly string[], after: readonly Token[], at: readonly number[]): boolean {
  if (at.length !== before.length) return false;
  let i = 0;
  while (i < at.length) {
    //@ invariant 0 <= i && i <= at.length
    //@ invariant forall(m: nat, m < i ==> 0 <= at[m] && at[m] < after.length && after[at[m]].text === before[m])
    //@ invariant forall(m: nat, m + 1 < i ==> at[m] < at[m + 1])
    const position = at[i] as number;
    if (position < 0 || position >= after.length || (after[position] as Token).text !== before[i]) return false;
    if (i > 0 && (at[i - 1] as number) >= position) return false;
    i = i + 1;
  }
  let j = 0;
  while (j < after.length) {
    //@ invariant 0 <= j && j <= after.length
    //@ invariant forall(m: nat, m < j ==> after[m].kind !== "check")
    if ((after[j] as Token).kind === "check") return false;
    j = j + 1;
  }
  let g = 0;
  while (g <= at.length) {
    //@ invariant 0 <= g && g <= at.length + 1
    //@ invariant forall(m: nat, m < g ==> item(after, gapStart(at, m), gapEnd(at, m, after.length)))
    if (!isItem(after, gapStart(at, g), gapEnd(at, g, after.length))) return false;
    g = g + 1;
  }
  return true;
}

/**
 * Whether a change to a test file may weaken the tests it held, against the
 * request's base: deleting the file, or editing it so that it removes a line
 * that counts (`removalCounts`, `removes`) or adds one that changes how its
 * existing tests run (`changesRuns`): a focus or skip marker, a setup or
 * teardown hook, or a module mock. A new test file, or one that only gains
 * tests, weakens nothing.
 */
//@ ensures \result <==> status === "deleted" || (status === "modified" && (removes || changesRuns))
export function testWeakens(status: ChangeStatus, removes: boolean, changesRuns: boolean): boolean {
  if (status === "deleted") return true;
  return status === "modified" && (removes || changesRuns);
}
