import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { LIVE_CODEX_MODEL_ID } from "./integrations/pi-live.js";

/**
 * Which model each of Tesota's roles uses (decision 020). The operator
 * chooses; a role without a choice uses the default. Model choice is operator
 * configuration, kept in Tesota's own directory, never in a repository.
 */
export const MODEL_ROLES = ["agent", "helper", "reviewer", "refuter", "validator"] as const;
export type ModelRole = typeof MODEL_ROLES[number];

export const ROLE_DESCRIPTIONS: Readonly<Record<ModelRole, string>> = {
  agent: "the working agent, which changes the workspace",
  helper: "read-only helpers the agent starts",
  reviewer: "reviewers, focused lenses and ClaimCheck",
  refuter: "the refuter that tests every finding",
  validator: "the fix validator in correction rounds",
};

/** The model every role uses until the operator chooses another. */
export const DEFAULT_MODEL: string = LIVE_CODEX_MODEL_ID;
export const DEFAULT_MODELS_FILE: string = join(homedir(), ".tesota", "models.json");

export type ModelChoices = Readonly<Record<ModelRole, string>>;

const modelId = z.string().min(1).max(100);
const choicesSchema = z.strictObject({ agent: modelId.optional(), helper: modelId.optional(),
  reviewer: modelId.optional(), refuter: modelId.optional(), validator: modelId.optional() });
type StoredChoices = z.infer<typeof choicesSchema>;

export function isModelRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

function stored(path: string): StoredChoices {
  if (!existsSync(path)) return {};
  const parsed = choicesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid model choice file; fix or delete it`);
  return parsed.data;
}

/** Each role's model: the operator's choice, or the default. */
export function readModelChoices(path: string = DEFAULT_MODELS_FILE): ModelChoices {
  const choices = stored(path);
  return Object.fromEntries(MODEL_ROLES.map((role) => [role, choices[role] ?? DEFAULT_MODEL])) as Record<ModelRole, string>;
}

/**
 * Choose a role's model from the models the provider offers, or `default` to
 * clear the choice. The file is replaced whole, so a failed write leaves the
 * previous choices.
 */
export function chooseModel(role: ModelRole, model: string, available: readonly string[],
  path: string = DEFAULT_MODELS_FILE): ModelChoices {
  const choices: Record<string, string | undefined> = { ...stored(path) };
  if (model === "default") delete choices[role];
  else if (available.includes(model)) choices[role] = model;
  else throw new Error(`${model} is not offered; choose one of ${available.join(", ")}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(choicesSchema.parse(choices), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return readModelChoices(path);
}
