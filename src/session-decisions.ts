import type { CommandApproval, CommandRequest, NetworkDecision } from "./integrations/pi-coding-session.js";
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
}

/** The question for a command on this computer: where it runs, why, and the rule the operator may save (decision 049). */
export function commandQuestion(request: CommandRequest): string {
  const where = request.reason === undefined ? `Run \`${request.command}\`?`
    : `Run \`${request.command}\` on this computer, outside the sandbox? ${request.reason}`;
  const rule = request.rule === undefined ? "" : `, [a]lways \`${request.rule.join(" ")} …\` in this repository`;
  return `${where} [y]es${rule}, [n]o: `;
}

/** The operator's answer; "always" counts only when a rule was offered, and anything else declines. */
export function parseApproval(answer: string, ruleOffered: boolean): CommandApproval {
  const value = answer.trim().toLowerCase();
  if (value === "y" || value === "yes") return "once";
  if (ruleOffered && (value === "a" || value === "always")) return "rule";
  return "deny";
}

function parseNetworkDecision(answer: string): NetworkDecision {
  const value = answer.trim().toLowerCase();
  if (value === "y" || value === "yes") return "session";
  if (value === "a" || value === "always") return "repository";
  return "deny";
}

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
 * The operator's decisions, asked as questions at the shell's prompt and read
 * from their replies; `write` shows what a question needs before it is asked,
 * and why an answer cannot be used.
 */
export function askingDecisions(ask: (prompt: string) => Promise<string>,
  write: (text: string, tone?: NoticeTone) => void): SessionDecisions {
  return {
    nextRequest: () => ask("> "),
    checks: async (suggested) => {
      write(suggested.length === 0
        ? "No checks were found for this repository.\n"
        : `Suggested checks:\n${suggested.map((command) => `  ${command}`).join("\n")}\n`);
      write("To compare failures test by test with the repository as it was, follow a command with " +
        "=> and the JUnit XML reports it writes, in paths Git ignores: bun run test => reports/unit.xml, reports/e2e.xml\n");
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
    result: async () => {
      for (;;) {
        const answer = (await ask("[a]pply, [r]eject, or [k]eep working: ")).trim().toLowerCase();
        if (answer === "a" || answer === "apply") return "apply";
        if (answer === "r" || answer === "reject") return "reject";
        if (answer === "k" || answer === "keep" || answer === "") return "keep";
      }
    },
    command: async (request) => parseApproval(await ask(commandQuestion(request)), request.rule !== undefined),
    network: async (destinations) => parseNetworkDecision(await ask(`The sandbox refused network access to ` +
      `${destinations.join(", ")}. Allow it? [y]es this session, [a]lways for this repository, [n]o: `)),
    site: async (host) => parseNetworkDecision(await ask(`Read pages from ${host}? [y]es this session, ` +
      "[a]lways for this repository, [n]o: ")),
  };
}
