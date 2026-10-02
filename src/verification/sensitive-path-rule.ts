/**
 * Decision 053's rule for whether a changed path makes a review thorough as
 * sensitive. A path declared sensitive always does, a test included: by the
 * repository's own file, read from the change's base, or by the list the
 * operator confirmed. Otherwise a test file never does: changing an existing
 * test makes the review thorough on its own, and a test named after what it
 * tests is not that code. A name counts when it holds an unambiguous term,
 * such as auth or credentials; an ambiguous term, such as token or session,
 * counts only as a whole folder or file name, so token-usage is not an auth
 * token; and infrastructure files, such as a Dockerfile, count. Until the
 * operator confirms a list, code that imports process, cryptography or
 * network APIs counts too, so a repository nobody configured leans toward the
 * thorough review, never away from it.
 */
//@ ensures \result <==> (declared || (!isTest && (unambiguousTerm || wholeAmbiguousTerm || infrastructureFile || (!confirmed && importsAuthority))))
export function sensitivePath(declared: boolean, confirmed: boolean, isTest: boolean, unambiguousTerm: boolean,
  wholeAmbiguousTerm: boolean, infrastructureFile: boolean, importsAuthority: boolean): boolean {
  if (declared) return true;
  if (isTest) return false;
  if (unambiguousTerm || wholeAmbiguousTerm || infrastructureFile) return true;
  return !confirmed && importsAuthority;
}
