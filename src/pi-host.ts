import { CustomEditor, getShellConfig, keyText, VERSION } from "@earendil-works/pi-coding-agent";
import type { HostParts } from "./host.js";

/**
 * Pi's editor, key names, version and shell, as Tesota takes them on Pi
 * (#446). Temporary until slice 11 of #432 removes Pi.
 */
export const piHost: HostParts = {
  EditorBase: CustomEditor as never,
  keyText: (action) => keyText(action as Parameters<typeof keyText>[0]),
  version: VERSION,
  shellConfig: () => getShellConfig(),
};
