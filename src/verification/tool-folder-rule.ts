/**
 * Decision 043's rule for the tool folders a WSL sandbox command may read,
 * taken from `PATH`: never a folder that is the operator's home or holds it,
 * since the home holds their credentials; never one on Windows' drives, whose
 * programs a command may not start; and a system folder is already mounted.
 * Every other installation on `PATH`, such as Node's, is readable, so the
 * command finds its tools and their libraries.
 */
//@ ensures \result <==> (!holdsHome && !onWindowsDrive && !systemFolder)
export function readsToolFolder(holdsHome: boolean, onWindowsDrive: boolean, systemFolder: boolean): boolean {
  if (holdsHome || onWindowsDrive) return false;
  return !systemFolder;
}
