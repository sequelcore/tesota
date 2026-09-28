// A control sequence: CSI (colors, cursor movement, erasing), OSC ended by BEL or ST, or a two-byte escape.
// oxlint-disable-next-line no-control-regex
const controlSequence = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/gu;

/**
 * What a command's output reads as once a terminal has drawn it: colors and
 * cursor sequences removed, and each line as the last carriage return left
 * it, so a progress line that redraws itself shows its final state. Other
 * control characters stay for the display to escape.
 */
export function terminalOutputText(output: string): string {
  return output.replace(controlSequence, "").split("\n")
    .map((line) => line.replace(/\r$/u, "").split("\r").at(-1) ?? "").join("\n");
}
