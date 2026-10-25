import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { modelHtmlBundle } from "../packages/core/scripts/model-html-bundle.js" with { type: "macro" };
import type { ReachedGraph, TraceState } from "./model-graph.js";
import type { ModelView } from "./model-view.js";

export interface HtmlModel {
  readonly model: string;
  readonly graph: ReachedGraph;
  readonly reports: { readonly trace: readonly TraceState[]; readonly violations: Readonly<Record<string, readonly string[]>> };
  readonly header: string;
  readonly view: ModelView;
}
const script = modelHtmlBundle();
const css = `:root{color-scheme:light dark;--bg:#faf8f4;--fg:#302d35;--panel:#eee9e2;--error:#a23d48;--accent:#71567e} @media(prefers-color-scheme:dark){:root{--bg:#202020;--fg:#f2eee6;--panel:#312b38;--error:#d88c8c;--accent:#c6a8d2}} *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px system-ui}header,nav,aside{padding:1rem}h1{font-size:1.2rem;margin:0}p{margin:.5rem 0}nav{display:flex;gap:1rem;flex-wrap:wrap;background:var(--panel)}button,input,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--accent);border-radius:4px;padding:.35rem}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,#graph:focus-visible{outline:3px solid var(--accent);outline-offset:2px}main{display:grid;grid-template-columns:minmax(0,1fr) 24rem;height:68vh;min-height:400px}#graph{position:relative;height:100%;min-width:0;padding:0;border:0 solid transparent}aside{overflow:auto;border-left:1px solid var(--accent)}pre{white-space:pre-wrap;overflow-wrap:anywhere}.break{color:var(--error)}#groups{max-height:16rem;overflow:auto;padding:1rem}#groups button{margin:.25rem}.trace-step{display:block;margin:.5rem 0}#trace{padding:1rem} @media(max-width:750px){main{grid-template-columns:1fr;height:auto}#graph{height:60vh}aside{max-height:40vh}}`;
const hash = (text: string): string => createHash("sha256").update(text).digest("base64");

/** This is invoked only by the disposable worker. No model text enters markup or code. */
export async function writeModelHtml(manifest: string, data: HtmlModel): Promise<string> {
  const code = await script;
  const json = JSON.stringify(data).replace(/[<>&\u2028\u2029]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const csp = `default-src 'none'; script-src 'sha256-${hash(code)}'; style-src-elem 'sha256-${hash(css)}'; style-src-attr 'none'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tesota model graph</title><style id="__________cytoscape_stylesheet">${css}</style></head><body>
<header><h1 id="title"></h1><p id="counts" role="status"></p><p id="grouping"></p><p>Grouped transitions are not an execution. Only TLC's concrete trace is an execution.</p></header>
<nav aria-label="Graph controls"><label>Group by <select id="first"></select></label><label>Then <select id="second"></select></label><label>Search <input id="search" type="search" placeholder="State, action, property or value"></label><button id="trace-toggle" aria-expanded="false" aria-controls="trace">TLC concrete trace</button><button id="fit">Fit graph</button></nav>
<main><div id="graph" tabindex="0" role="region" aria-label="Model graph; arrows pan, plus and minus zoom"></div><aside aria-label="State variables"><h2>Variables</h2><div id="details">Choose a group or state.</div></aside></main>
<p>Drag to pan; wheel to zoom. Focus the graph: arrows pan, +/− zoom. Choose a member below for full variables. ! BREAK counts reported violating members, not a whole group's verdict.</p><section id="groups" aria-label="Groups and members"></section><section id="trace" aria-label="TLC concrete trace" hidden></section>
<script id="model-data" type="application/json">${json}</script><script>${code}</script></body></html>`;
  const extension = extname(manifest);
  const path = resolve((extension === "" ? manifest : manifest.slice(0, -extension.length)) + ".html");
  await writeFile(path, html);
  return path;
}
