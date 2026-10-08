import type { Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/**
 * The `chatgpt` route's provider (#191): Pi's OpenAI provider with Sign in
 * with ChatGPT as its only sign-in, so an `OPENAI_API_KEY` in the environment
 * is never billed for a plan's route, and with only the models a ChatGPT plan
 * serves. Pi lists the whole OpenAI API catalog under the same provider.
 */

/** Pi's provider id, under which the route's sign-in is kept. */
export const CHATGPT_PROVIDER = "openai";

/**
 * The models a ChatGPT plan serves: those `GET /v1/models` lists as visible to
 * a signed-in account, as OpenAI's Sign in with ChatGPT documentation says to
 * choose them. On 2026-10-08 every plan that can sign in (Go, Plus, Pro,
 * Business, Enterprise, Edu) listed the same ones, so the list is not read per
 * account; it changes when OpenAI's does.
 */
export const CHATGPT_PLAN_MODELS: readonly string[] = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra",
  "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"];

/** How Tesota names itself on OpenAI's consent screen. */
export const CHATGPT_AGENT_NAME = "Tesota";

export function chatgptProvider(): Provider {
  const openai = openaiProvider();
  const { oauth } = openai.auth;
  if (oauth === undefined) throw new Error("Pi's OpenAI provider has no Sign in with ChatGPT");
  const planModels = (): ReturnType<Provider["getModels"]> =>
    openai.getModels().filter((model) => CHATGPT_PLAN_MODELS.includes(model.id));
  return { ...openai, auth: { oauth }, getModels: planModels, getAllModels: planModels };
}
