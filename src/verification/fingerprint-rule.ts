/** A repository is eligible when its start cannot be known or its observed state may have changed. */
//@ ensures \result <==> (!known || headMoved || pathChanged || unmeasured)
export function fingerprintEligible(known: boolean, headMoved: boolean, pathChanged: boolean, unmeasured: boolean): boolean {
  return !known || headMoved || pathChanged || unmeasured;
}

/** Credit needs unchanged history or a same-branch descent of exclusively reached, timely commits. */
//@ ensures \result <==> (!repository || (startKnown && endKnown && startAtBase && (endAtBase || (sameBranch && descends && exclusive && timely))))
export function historyAttributable(repository: boolean, startKnown: boolean, endKnown: boolean,
  startAtBase: boolean, endAtBase: boolean, sameBranch: boolean, descends: boolean, exclusive: boolean, timely: boolean): boolean {
  return !repository || (startKnown && endKnown && startAtBase && (endAtBase || (sameBranch && descends && exclusive && timely)));
}

/** Unmeasured paths cannot be called unchanged; commits since H remain part of the observed change. */
export type PathAttribution = "request" | "inherited" | "unmeasured" | "unchanged";

//@ ensures \result === "unmeasured" <==> !measured
//@ ensures \result === "request" <==> measured && (differs || committed)
//@ ensures \result === "inherited" <==> measured && !differs && !committed && dirtyAtStart
//@ ensures \result === "unchanged" <==> measured && !differs && !committed && !dirtyAtStart
export function attributePath(measured: boolean, differs: boolean, committed: boolean, dirtyAtStart: boolean): PathAttribution {
  if (!measured) return "unmeasured";
  if (differs || committed) return "request";
  return dirtyAtStart ? "inherited" : "unchanged";
}
