import type { CommandApproval, CommandRequest, NetworkDecision } from "./integrations/pi-coding-session.js";
import type { ShellQuestion } from "./tesota-shell-question.js";
import type { NoticeTone } from "./tesota-shell-transcript.js";
import { type ApprovedCheck, parseApprovedCheck } from "./workspace-checks.js";

/** What becomes of a result worked on in a copy: applied to the source, discarded, or kept pending. */
export type ResultDecision = "apply" | "reject" | "keep";

/**
 * Every point where a session waits for someone: the operator answering at
 * the shell's prompt, or a policy stated up front where nobody is at the
 * keyboard. Each answer is typed, so how a question is worded never changes
 * what it decides. What follows an answer, such as saving a rule or allowing
 * a destination for the repository, belongs to the session, not to whoever
 * answered.
 */
export interface SessionDecisions {
  /** The next request; empty ends the session. */
  nextRequest(): Promise<string>;
  /**
   * Whether the operator has already typed the next request. It goes before
   * a correction round and answers the result decision with "keep", since the
   * operator's own message may be the correction.
   */
  queued(): boolean;
  /** The commands to run after each change, chosen once per repository from those suggested. */
  checks(suggested: readonly string[]): Promise<readonly ApprovedCheck[]>;
  /** Which of the hidden files the chosen checks may read. */
  checkSecrets(hidden: readonly string[]): Promise<readonly string[]>;
  /** What becomes of a reviewed result in a copy. */
  result(): Promise<ResultDecision>;
  /** Whether a command runs where it needs approval. */
  command(request: CommandRequest): Promise<CommandApproval>;
  /** Whether destinations the sandbox refused may be reached. */
  network(destinations: readonly string[]): Promise<NetworkDecision>;
  /** Whether the agent may read pages from a site. */
  site(host: string): Promise<NetworkDecision>;
  /** Whether the session may enter Full access, asked the first time it would in a session. */
  fullAccess(): Promise<boolean>;
  /** Whether to install, in the sandbox, the tools the repository's changed toolchain files now declare. */
  toolchain(files: readonly string[]): Promise<boolean>;
  /** Whether to bring the repository's newer changes into the workspace and check the result again. */
  refresh(paths: readonly string[]): Promise<boolean>;
}

/**
 * The question for a command on this computer: where it runs, why, and the rule the operator may save (decision 049).
 * Enter declines, and each answer leaves a line in the conversation under the command.
 */
export function commandQuestion(request: CommandRequest): ShellQuestion<CommandApproval> {
  const host = request.reason !== undefined;
  const rule = request.rule === undefined ? undefined : `\`${request.rule.join(" ")} …\``;
  return {
    title: host ? `Run \`${request.command}\` on this computer, outside the sandbox?` : `Run \`${request.command}\`?`,
    ...host ? { detail: request.reason } : {},
    options: [
      { value: "once", key: "y", label: "Yes, once",
        decided: { text: `✓ Allowed \`${request.command}\` once${host ? ", on this computer, outside the sandbox" : ""}.`, tone: "info" } },
      ...rule === undefined ? [] : [{ value: "rule" as const, key: "a", label: `Always ${rule} in this repository`,
        decided: { text: `✓ Allowed \`${request.command}\`; always allow ${rule} in this repository.`, tone: "info" as const } }],
      { value: "deny", key: "n", label: "No",
        decided: { text: `✗ Declined \`${request.command}\`; the command did not run.`, tone: "warning" } },
    ],
    initial: "deny",
  };
}

/** The question for network access, to destinations the sandbox refused or to a site the agent would read; Enter declines. */
function networkQuestion(title: string, what: string): ShellQuestion<NetworkDecision> {
  return {
    title,
    options: [
      { value: "session", key: "y", label: "Yes, this session",
        decided: { text: `✓ Allowed ${what} for this session.`, tone: "info" } },
      { value: "repository", key: "a", label: "Always, in this repository",
        decided: { text: `✓ Allowed ${what} in this repository from now on.`, tone: "info" } },
      { value: "deny", key: "n", label: "No", decided: { text: `✗ Declined ${what}.`, tone: "warning" } },
    ],
    initial: "deny",
  };
}

/**
 * Entering Full access, the first time in a session, worded as Codex words its own: what it allows, the risk in the
 * warning color, and what still protects the operator. Enter cancels, as for every question that would widen what
 * the agent may do.
 */
export const fullAccessQuestion: ShellQuestion<"allow" | "deny"> = {
  title: "Enable Full access?",
  detail: "In Full access, the agent's commands run on this computer without asking, outside the sandbox, with your " +
    "programs, logins, files and network, including files hidden from its file tools such as .env. /revert still " +
    "undoes a turn's changes in this project, but not what a command did elsewhere.",
  caution: "This significantly increases the risk of data loss, leaked credentials or changes you did not expect.",
  options: [
    { value: "allow", key: "y", label: "Yes, continue anyway",
      decided: { text: "Full access: commands run on this computer without asking.", tone: "warning" } },
    { value: "deny", key: "n", label: "Cancel", decided: { text: "Full access was not enabled.", tone: "info" } },
  ],
  initial: "deny",
};

/**
 * The question for a toolchain the repository now declares differently, as when the agent adds a tool a check needs:
 * installing runs the sandbox's setup, which downloads only while it runs. Enter declines.
 */
export function toolchainQuestion(files: readonly string[]): ShellQuestion<"install" | "decline"> {
  const named = files.map((file) => `\`${file}\``).join(", ");
  return {
    title: `The repository's toolchain changed${files.length === 0 ? "" : ` (${named})`}. Install it in the sandbox now?`,
    detail: "Tesota runs the sandbox's setup again. It may download from the tools' release hosts, such as GitHub, and " +
      "from package registries, only while setup runs; the sandbox's network closes again afterwards.",
    options: [
      { value: "install", key: "y", label: "Yes, install it",
        decided: { text: files.length === 0 ? "✓ Installing the declared tools in the sandbox."
          : `✓ Installing what ${named} ${files.length === 1 ? "declares" : "declare"} in the sandbox.`, tone: "info" } },
      { value: "decline", key: "n", label: "No",
        decided: { text: `✗ Not installed; the agent is told the declared tools are unavailable.`, tone: "warning" } },
    ],
    initial: "decline",
  };
}

/**
 * After an application refused because the repository changed since the check (decision 042's refresh): bring those
 * changes in and check again, as a pull request's "Update branch" does, with no agent turn. Enter declines.
 */
export function refreshQuestion(paths: readonly string[]): ShellQuestion<"refresh" | "keep"> {
  const count = paths.length;
  return {
    title: `Your repository changed since this result was checked${count === 0 ? "" : ` (${count} ${count === 1 ? "file" : "files"})`}. ` +
      "Bring those changes in and check again?",
    detail: "Tesota brings them into the workspace, runs the approved checks and the review again, and asks again. " +
      "No agent turn runs unless the checks or the review send something back.",
    options: [
      { value: "refresh", key: "y", label: "Yes, bring them in and check again" },
      { value: "keep", key: "n", label: "No, keep the result in the workspace" },
    ],
    initial: "keep",
  };
}

/** What becomes of a reviewed result; Enter keeps working, and what follows the answer says what was done. */
const resultQuestion: ShellQuestion<ResultDecision> = {
  title: "What becomes of these changes?",
  options: [
    { value: "apply", key: "a", label: "Apply them to your repository" },
    { value: "reject", key: "r", label: "Reject them" },
    { value: "keep", key: "k", label: "Keep working" },
  ],
  initial: "keep",
};

/** The checks an answer names, or the reason one of them cannot be used. */
function parseChecks(answer: string): readonly ApprovedCheck[] | string {
  const checks: ApprovedCheck[] = [];
  for (const text of answer.split(";").filter((part) => part.trim().length > 0)) {
    const check = parseApprovedCheck(text);
    if (typeof check === "string") return check;
    checks.push(check);
  }
  return checks;
}

/**
 * The operator's decisions: requests and checks typed at the shell's prompt,
 * and questions with fixed answers picked with `choose`; `write` shows what a
 * question needs before it is asked, and why an answer cannot be used, and
 * `queued` whether requests wait.
 */
export function askingDecisions(ask: (prompt: string) => Promise<string>,
  choose: <V extends string>(question: ShellQuestion<V>) => Promise<V>,
  write: (text: string, tone?: NoticeTone) => void, queued: () => boolean): SessionDecisions {
  return {
    nextRequest: () => ask("> "),
    queued,
    checks: async (suggested) => {
      write(suggested.length === 0
        ? "No checks were found for this repository.\n"
        : `Suggested checks:\n${suggested.map((command) => `  ${command}`).join("\n")}\n`);
      write("To compare failures test by test with the repository as it was, follow a command with " +
        "=> and the JUnit XML reports it writes, in paths Git ignores" +
        (suggested.length === 0 ? "\n" : `: ${suggested[0]} => reports/unit.xml, reports/e2e.xml\n`));
      for (;;) {
        const answer = (await ask(suggested.length === 0
          ? "Commands to run after each change (separate with ;), or Enter for none: "
          : "Enter to use these, type other commands (separate with ;), or 'none': ")).trim();
        const chosen = answer.length === 0 ? suggested.map((command) => ({ command, reports: [] }))
          : answer.toLowerCase() === "none" ? [] : parseChecks(answer);
        if (typeof chosen !== "string") return chosen;
        write(`${chosen}\n`, "warning");
      }
    },
    checkSecrets: async (hidden) => {
      write(`Hidden from the agent and its checks, since they may hold credentials:\n${hidden.map((path) => `  ${path}`).join("\n")}\n`);
      const answer = await ask("Checks that need some of them may read them: type their paths (separate with ;), or Enter for none: ");
      return answer.split(";").map((path) => path.trim()).filter((path) => hidden.includes(path));
    },
    result: () => choose(resultQuestion),
    command: (request) => choose(commandQuestion(request)),
    network: (destinations) => choose(networkQuestion(
      `The sandbox refused network access to ${destinations.join(", ")}. Allow it?`,
      `network access to ${destinations.join(", ")}`)),
    site: (host) => choose(networkQuestion(`Read pages from ${host}?`, `reading pages from ${host}`)),
    fullAccess: async () => await choose(fullAccessQuestion) === "allow",
    toolchain: async (files) => await choose(toolchainQuestion(files)) === "install",
    refresh: async (paths) => await choose(refreshQuestion(paths)) === "refresh",
  };
}
