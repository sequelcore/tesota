import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Session } from "../../src/contract.ts";
import { createSession, type EngineSession, openSession } from "../../src/session.ts";
import type { SessionOptions, TestEngine } from "../engine.ts";
import { accepts, scriptedReply } from "../scripted.ts";

/** Pi's scripted model playing `options.script`, with the test's extensions and a verifier that settles every run. */
function scripted(options: SessionOptions) {
  const faux = fauxProvider(options.slow === true ? { tokensPerSecond: 20 } : {});
  faux.setResponses(options.script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), extensions: options.extensions, verifier: accepts };
}

/**
 * `@tesota/core` on Pi's scripted model, with its sessions in the test's
 * own home folder (#437). Its extensions get the events and settle (#439);
 * tests that register tools or read the branch, settings or context usage
 * wait for slice 5.
 */
export const tesotaEngine: TestEngine = {
  name: "@tesota/core",
  lacks: new Set(),
  pending: new Map([["tools", "slice 5 of #432"]]),
  shell: process.platform === "win32" ? "powershell" : "bash",
  createSession(options: SessionOptions): Promise<Session> {
    return Promise.resolve(createSession({ cwd: options.cwd, ...scripted(options) }));
  },
  async resume(session: Session, options: SessionOptions): Promise<Session> {
    await session.dispose();
    return openSession((session as EngineSession).file, scripted(options));
  },
};
