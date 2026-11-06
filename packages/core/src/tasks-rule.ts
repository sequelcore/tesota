/**
 * Whether a task list keeps Tesota's bounds: at most one item in progress,
 * no blank title, the longest title within 1,024 UTF-8 bytes and the whole
 * list within 16 KiB.
 */
//@ requires inProgress >= 0 && blank >= 0 && longest >= 0 && bytes >= 0
//@ ensures \result <==> inProgress <= 1 && blank === 0 && longest <= 1024 && bytes <= 16384
export function taskListAccepted(inProgress: number, blank: number, longest: number, bytes: number): boolean {
  return inProgress <= 1 && blank === 0 && longest <= 1024 && bytes <= 16384;
}

/** Whether a run's recorded continuation names a run its list may come from: an earlier run of the session. */
//@ ensures \result <==> 1 <= parent && parent < run
export function linkAccepted(parent: number, run: number): boolean {
  return parent >= 1 && parent < run;
}
