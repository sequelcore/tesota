/** A repository is eligible when its start cannot be known or its observed state may have changed. */
//@ ensures \result <==> (!known || headMoved || pathChanged || unmeasured)
export function fingerprintEligible(known: boolean, headMoved: boolean, pathChanged: boolean, unmeasured: boolean): boolean {
  return !known || headMoved || pathChanged || unmeasured;
}

/** Contribution credit needs readable captures whose HEADs both equal the admission HEAD. Snapshots have no Git history. */
//@ ensures \result <==> (!repository || (startKnown && endKnown && startAtBase && endAtBase))
export function historyAttributable(repository: boolean, startKnown: boolean, endKnown: boolean,
  startAtBase: boolean, endAtBase: boolean): boolean {
  return !repository || (startKnown && endKnown && startAtBase && endAtBase);
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
