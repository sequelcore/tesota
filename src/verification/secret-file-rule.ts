/**
 * The rule for hiding a file from the agent (docs/design/workspace.md): a
 * file whose name marks it as a secret is hidden, unless the operator allowed
 * it, or the source is a repository whose Git tracks it, since a tracked file
 * is shared work whose history is readable anyway. A folder has no Git of its
 * own, so every secret it holds is hidden. No other file is ever hidden.
 */
//@ ensures \result <==> (secretName && !allowed && (!repository || !tracked))
//@ ensures !secretName ==> !\result
//@ ensures secretName && !allowed && !repository ==> \result
export function hidesFile(secretName: boolean, repository: boolean, tracked: boolean, allowed: boolean): boolean {
  if (!secretName || allowed) return false;
  return !repository || !tracked;
}
