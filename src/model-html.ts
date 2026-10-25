import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { modelHtmlBundle } from "../packages/core/scripts/model-html-bundle.js" with { type: "macro" };
import type { ReachedGraph, TraceState } from "./model-graph.js";
import { GROUPED_MOVES, type ModelView } from "./model-view.js";

export interface HtmlModel {
  readonly model: string;
  readonly graph: ReachedGraph;
  readonly reports: { readonly trace: readonly TraceState[]; readonly violations: Readonly<Record<string, readonly string[]>>; readonly ruleDefinitions?: Readonly<Record<string, string>> };
  readonly header: string;
  readonly view: ModelView;
}
const script = modelHtmlBundle();
const css = `:root{color-scheme:light dark;--bg:#faf8f4;--fg:#302d35;--panel:#eee9e2;--error:#a23d48;--accent:#71567e}@media(prefers-color-scheme:dark){:root{--bg:#202020;--fg:#f2eee6;--panel:#312b38;--error:#d88c8c;--accent:#c6a8d2}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui;height:100dvh;overflow:hidden;display:grid;grid-template-rows:auto auto minmax(0,1fr)}header{padding:16px 20px}h1{font-size:16px;font-weight:600;margin:0}h2,h3{font-size:15px;margin:0 0 12px}p{margin:6px 0;overflow-wrap:anywhere}#caveats,#counts,#grouping,.secondary,.help{font-size:12px}nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 20px;background:var(--panel)}label{display:flex;align-items:center;gap:6px}button,input,select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--accent);border-radius:6px;padding:6px}button{cursor:pointer}button:disabled{cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,#graph:focus-visible{outline:3px solid var(--accent);outline-offset:2px}main{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);min-height:0}.panel-collapsed main{grid-template-columns:minmax(0,1fr)}#graph{padding:0;border:0 solid transparent;position:relative;height:100%;min-width:0;min-height:0}aside{overflow:auto;min-width:0;padding:16px;border-left:1px solid var(--accent);background:var(--panel)}[hidden]{display:none!important}.break{color:var(--error)}#groups>.group-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:10px 0;padding:6px;border-left:2px solid var(--accent)}.group-row>.break{margin:3px}.rule-definition code{font:inherit}.rule-definition{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.group-row>.rule-definition{flex-basis:100%}.help{opacity:.8}#groups button{max-width:100%;text-align:left;overflow-wrap:anywhere;margin:3px}#trace{margin-top:20px}.trace-step{display:block;width:100%;text-align:left;margin:8px 0}dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere;font-family:monospace}.secondary{font-family:monospace;overflow-wrap:anywhere}.legend{border-block:1px solid var(--accent);padding:10px 0;margin:16px 0}@media(max-width:650px){main{grid-template-columns:minmax(0,1fr) 230px}header{padding:10px}nav{padding:8px;gap:6px}#search{width:155px}}`;
const hash = (text: string): string => createHash("sha256").update(text).digest("base64");

/** This is invoked only by the disposable worker. No model text enters markup or code. */
export async function writeModelHtml(manifest: string, data: HtmlModel): Promise<string> {
  const code = await script;
  const json = JSON.stringify(data).replace(/[<>&\u2028\u2029]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const csp = `default-src 'none'; script-src 'sha256-${hash(code)}'; style-src-elem 'sha256-${hash(css)}'; style-src-attr 'none'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tesota model graph</title><style id="__________cytoscape_stylesheet">${css}</style></head><body>
<header><h1 id="title"></h1><p id="summary-values"></p><div id="summary-rules"></div><p id="explainer" class="help">TLC, the model checker, tried every order of the model's actions it could reach. Each box is a situation the system can be in, called a state. ${GROUPED_MOVES} Only the failing run is a real execution.</p><p id="caveats"></p><p id="counts" role="status"></p></header>
<nav aria-label="Graph controls"><label>Group by <select id="first"></select></label><label>Then <select id="second"></select></label><label>Search <input id="search" type="search" placeholder="Find a value, action or rule"></label><button id="trace-toggle" aria-expanded="false" aria-controls="trace" title="TLC's counterexample, the only real execution shown">Show the failing run</button><button id="fit">Fit</button><button id="download-png">Download PNG</button><button id="panel-toggle" aria-expanded="true" aria-controls="panel">Hide panel</button></nav>
<main><div id="graph" tabindex="0" role="region" aria-label="Model graph; arrows pan, plus and minus zoom"></div><aside id="panel" aria-label="Graph inspection"><div id="details"><h2>Inspect the graph</h2><p>Choose a group or state.</p></div><div class="legend"><p>Box: a situation (state) · start: where it begins</p><p>Arrow: a possible move, not a story</p><p class="break">⚠: breaks a rule</p><p>Highlighted path: the failing run, a real story</p><p class="help">Drag to pan; wheel to zoom. Focus graph: arrows pan, +/− zoom.</p></div><p id="grouping"></p><section id="groups" aria-label="Groups and states"></section><section id="trace" aria-label="Failing run" hidden></section></aside></main>
<script id="model-data" type="application/json">${json}</script><script>${code}</script></body></html>`;
  const extension = manifest.endsWith(".manifest.json") ? ".manifest.json" : extname(manifest);
  const path = resolve((extension === "" ? manifest : manifest.slice(0, -extension.length)) + ".html");
  await writeFile(path, html);
  return path;
}
