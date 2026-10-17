import { getNativeClipboard } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";

/** The platform's clipboard commands, in the order they are tried. */
function commands(): [string, string[]][] {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip", []]];
  return [
    ...process.env["WAYLAND_DISPLAY"] === undefined ? [] : [["wl-copy", []] as [string, string[]]],
    ...process.env["DISPLAY"] === undefined ? [] : [["xclip", ["-selection", "clipboard"]] as [string, string[]],
      ["xsel", ["--clipboard", "--input"]] as [string, string[]]],
  ];
}

/**
 * Copies `text` to the operator's clipboard (#444), as Pi does: the system's
 * clipboard, then its command, and last the terminal's own (OSC 52, written
 * through `write`), which reaches the clipboard over SSH but cannot be
 * checked. Resolves true once a route that can be checked took it.
 */
export async function copyToClipboard(text: string, write: (data: string) => void): Promise<boolean> {
  try {
    const native = getNativeClipboard();
    if (native?.setText !== undefined && process.platform !== "linux") {
      await native.setText(text);
      return true;
    }
  } catch { /* the platform's command next */ }
  for (const [command, args] of commands()) {
    if (spawnSync(command, args, { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] }).status === 0) return true;
  }
  write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
  return false;
}
