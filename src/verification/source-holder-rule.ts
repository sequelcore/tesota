/**
 * Which session of a shell works in the operator's own files (#246). One at a
 * time may, since a turn there records the whole source before and after it:
 * a second session's edits during that turn, or between its undecided turns,
 * would be counted as the first one's. A session that works there and is idle,
 * with every turn kept or reverted, holds nothing, so a new session works in
 * the operator's files instead of an isolated copy it must apply from.
 */

/**
 * Whether another session holds the operator's files now: it is taking them,
 * or it works in them and has a turn running or one the operator has not kept
 * or reverted yet. A session in an isolated copy never holds them.
 */
//@ ensures starting ==> \result
//@ ensures inSource && running ==> \result
//@ ensures inSource && undecided ==> \result
//@ ensures !starting && !inSource ==> !\result
//@ ensures !starting && !running && !undecided ==> !\result
export function holdsSourceFiles(starting: boolean, inSource: boolean, running: boolean, undecided: boolean): boolean {
  return starting || inSource && (running || undecided);
}

/**
 * Whether a new session works in the operator's files: only in a repository,
 * whose operator did not choose an isolated copy for it, while no other
 * session holds them. A plain folder always works in a copy.
 */
//@ ensures \result ==> repository
//@ ensures \result ==> !chosenCopy
//@ ensures \result ==> !heldElsewhere
//@ ensures repository && !chosenCopy && !heldElsewhere ==> \result
export function worksInSourceFiles(repository: boolean, chosenCopy: boolean, heldElsewhere: boolean): boolean {
  return repository && !chosenCopy && !heldElsewhere;
}
