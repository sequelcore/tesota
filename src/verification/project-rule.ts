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

/** An exact local declaration wins; otherwise an ancestor's version-file pin wins over a local minimum or absence. */
//@ ensures \result === "ancestor" <==> (local !== "pin" && ancestorPin)
//@ ensures \result === "local" <==> (local === "pin" || !ancestorPin)
export function versionSource(local: "pin" | "minimum" | "none", ancestorPin: boolean): "local" | "ancestor" {
  return local !== "pin" && ancestorPin ? "ancestor" : "local";
}
