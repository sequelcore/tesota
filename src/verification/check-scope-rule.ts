/**
 * Decision 052's rule for which form of a check a round runs: the related
 * form, for only the tests related to the changed files, or the whole
 * command. A round runs the
 * related form only when the operator gave one, the candidate changed files
 * for it to select by, it deletes no file, whose dependents a related form
 * cannot find from a path that is gone, it does not change what checks it,
 * and the round is not the last that can send work back. Every other round
 * runs the whole command.
 */
//@ ensures \result <==> (hasRelatedForm && changedFiles && !deletesFiles && !changesWhatChecks && !lastRound)
export function runsRelatedForm(hasRelatedForm: boolean, changedFiles: boolean, deletesFiles: boolean,
  changesWhatChecks: boolean, lastRound: boolean): boolean {
  if (!hasRelatedForm || !changedFiles) return false;
  if (deletesFiles || changesWhatChecks) return false;
  return !lastRound;
}

/**
 * Whether the whole command still runs before the operator decides: a result
 * whose last round ran only a related form is never presented on that form
 * alone.
 */
//@ ensures \result <==> ranRelatedForm
export function owesWholeCommand(ranRelatedForm: boolean): boolean {
  return ranRelatedForm;
}
