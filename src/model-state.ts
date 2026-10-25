/** TLC state assignments, including multiline records, sets, tuples and functions. */
export function stateVariables(lines: readonly string[]): Map<string, string> {
  const variables = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines) {
    const assignment = /^(?:\/\\\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/u.exec(line.trim());
    if (assignment !== null && (line.trimStart().startsWith("/\\") || variables.size === 0)) {
      current = assignment[1] ?? "";
      variables.set(current, assignment[2] ?? "");
    } else if (current !== undefined && line.trim() !== "") {
      variables.set(current, `${variables.get(current) ?? ""} ${line.trim()}`);
    }
  }
  return variables;
}
