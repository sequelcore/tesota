import { JSDOM, VirtualConsole } from "jsdom";

/** DOM integration, real Cytoscape/layout, no pixel assertions: jsdom has no canvas renderer. */
export function runHtml(html: string): { dom: JSDOM; errors: Error[] } {
  const errors: Error[] = [];
  const console = new VirtualConsole(); console.on("jsdomError", (error: Error) => errors.push(error));
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 1000 });
      Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { get: () => 600 });
      window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON() {} });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
      window.performance.mark = () => ({} as PerformanceMark);
      window.structuredClone = structuredClone;
      // Only the external Canvas API is stubbed, not our model, DOM or Cytoscape.
      window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({
        measureText: (text: string) => ({ width: text.length * 7 }),
        getLineDash: () => [],
      }, { get(target, key) { return Reflect.get(target, key) ?? (() => {}); }, set(target, key, value) { Reflect.set(target, key, value); return true; } })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
    } });
  return { dom, errors };
}
