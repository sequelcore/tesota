/** #318: a directory is a strict descendant only across a folder boundary; the root contains every other directory. */
//@ ensures \result <==> (folder !== other && (folder === "" || other.startsWith(folder + "/")))
//@ ensures folder === other ==> !\result
//@ ensures folder === "" && other !== "" ==> \result
export function below(folder: string, other: string): boolean {
  return folder !== other && (folder === "" || other.startsWith(folder + "/"));
}

/** A build is shown by an exact marker, or a filename ending in a wildcard marker's suffix. Version files are not build markers. */
//@ ensures \result <==> exists(m: nat, m < markers.length && exists(n: nat, n < entries.length && (markers[m].startsWith("*") ? entries[n].endsWith(markers[m].slice(1)) : entries[n] === markers[m])))
export function builtIn(markers: readonly string[], entries: readonly string[]): boolean {
  return markers.some((marker) => marker.startsWith("*") ? entries.some((name) => name.endsWith(marker.slice(1))) : entries.includes(marker));
}

/** A version-only directory has a version file but no build of that language, so it cannot claim descendant builds. */
//@ ensures \result <==> (!builtIn(markers, entries) && exists(n: nat, n < versionFiles.length && entries.includes(versionFiles[n])))
export function pinnedIn(markers: readonly string[], versionFiles: readonly string[], entries: readonly string[]): boolean {
  return !builtIn(markers, entries) && versionFiles.some((file) => entries.includes(file));
}

/** A version-only directory retains its kind unless a descendant builds it; another version-only directory builds nothing. */
//@ ensures \result <==> (!versionOnly || !descendantBuild)
export function keepsProjectKind(versionOnly: boolean, descendantBuild: boolean): boolean {
  return !versionOnly || !descendantBuild;
}

/** A path, relative to the repository, lies in a project's folder; the root holds every path. */
//@ ensures \result <==> (folder === "" || path.startsWith(folder + "/"))
export function holds(folder: string, path: string): boolean {
  return folder === "" || path.startsWith(folder + "/");
}

/**
 * The project a changed file belongs to: the deepest of `folders` that holds
 * it (`holds`), or -1 when none does.
 */
//@ ensures \result >= -1 && \result < folders.length
//@ ensures \result === -1 <==> forall(k: nat, k < folders.length ==> !holds(folders[k], path))
//@ ensures \result >= 0 ==> holds(folders[\result], path)
//@ ensures \result >= 0 ==> forall(k: nat, k < folders.length && holds(folders[k], path) ==> folders[k].length <= folders[\result].length)
export function owner(folders: readonly string[], path: string): number {
  let found = -1;
  let k = 0;
  while (k < folders.length) {
    //@ invariant 0 <= k && k <= folders.length
    //@ invariant found >= -1 && found < k
    //@ invariant found === -1 <==> forall(j: nat, j < k ==> !holds(folders[j], path))
    //@ invariant found >= 0 ==> holds(folders[found], path)
    //@ invariant found >= 0 ==> forall(j: nat, j < k && holds(folders[j], path) ==> folders[j].length <= folders[found].length)
    if (holds(folders[k]!, path) && (found === -1 || folders[k]!.length > folders[found]!.length)) found = k;
    k = k + 1;
  }
  return found;
}
