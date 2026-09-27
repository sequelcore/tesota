import { createInterface } from "node:readline/promises";

export interface CliChoice {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export async function chooseCliOption(title: string, choices: readonly CliChoice[]): Promise<string | undefined> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let shown = choices;
    for (;;) {
      const page = shown.slice(0, 20);
      process.stdout.write(`${title}${shown.length === choices.length ? "" : ` (${shown.length} matches)`}:\n` +
        `${page.map((choice, index) => `  ${index + 1}. ${choice.label}${choice.detail === undefined ? "" : ` — ${choice.detail}`}`)
          .join("\n")}\n${shown.length > page.length ? `Showing first ${page.length} of ${shown.length}; type to filter.\n` : ""}`);
      const answer = (await reader.question("Number, filter text, or Enter to cancel: ")).trim();
      if (answer === "") return undefined;
      const choice = /^[1-9]\d*$/u.test(answer) ? page[Number(answer) - 1] : undefined;
      if (choice !== undefined) return choice.value;
      if (/^\d+$/u.test(answer)) { process.stdout.write("Choose a listed number.\n"); continue; }
      shown = choices.filter((entry) => `${entry.label} ${entry.detail ?? ""}`.toLowerCase().includes(answer.toLowerCase()));
      if (shown.length === 0) { process.stdout.write("No matches; showing all choices.\n"); shown = choices; }
    }
  } finally { reader.close(); }
}
