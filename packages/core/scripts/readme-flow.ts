import { readFileSync } from "node:fs";
import { register, render } from "pele/core";
import flowchart from "pele/diagrams/flowchart";

register(flowchart);

/** The README's flow diagram, `docs/assets/tesota-flow.mmd`, and the SVGs drawn from it. */
export const flowSource: URL = new URL("../../../docs/assets/tesota-flow.mmd", import.meta.url);
export const flowSvgPath = (appearance: "dark" | "light"): URL =>
  new URL(`../../../docs/assets/tesota-flow-${appearance}.svg`, import.meta.url);

/**
 * The flow drawn with Pele in the theme's colors. GitHub renders Mermaid with its own palette and
 * controls, so the README shows this SVG instead, one per appearance, regenerated with the screenshots.
 */
export function flowSvg(appearance: "dark" | "light"): string {
  const theme = JSON.parse(readFileSync(new URL(`../../../themes/tesota-${appearance}.json`, import.meta.url), "utf8")) as
    { vars: Record<string, string>; colors: Record<string, string> };
  const { vars, colors } = theme;
  const tokens = [["bg", vars["canvas"]], ["fg", vars["text"]], ["muted", vars["muted"]], ["line", vars["dim"]],
    ["surface", vars["panel"]], ["surface-alt", vars["panel"]], ["border", colors["border"]], ["accent", vars["accent"]]]
    .map(([name, value]) => `--pele-${name}:${value};`).join("");
  const { svg } = render(readFileSync(flowSource, "utf8"), { fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", fontSize: 14 });
  return `${svg.replace(' style="', ` style="${tokens}`)}\n`;
}
