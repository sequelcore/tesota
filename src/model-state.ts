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

/**
 * A TLC value as a reading gets it: integers, strings and booleans as themselves, tuples and sets as arrays,
 * records and functions (`a :> b @@ c :> d`) as objects. A model value is its name; text this cannot read
 * stays the text TLC printed.
 */
export function tlaValue(text: string): unknown {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|<<|>>|\|->|:>|@@|-?\d+|[A-Za-z_]\w*|[{}[\](),]|\S/gu) ?? [];
  let at = 0;
  const take = (expected?: string): string => {
    const token = tokens[at++];
    if (token === undefined || (expected !== undefined && token !== expected)) throw new Error("unreadable");
    return token;
  };
  const list = (close: string): unknown[] => {
    const items: unknown[] = [];
    while (tokens[at] !== close) {
      items.push(value());
      if (tokens[at] !== close) take(",");
    }
    take(close);
    return items;
  };
  const value = (): unknown => {
    const token = take();
    if (token === "<<") return list(">>");
    if (token === "{") return list("}");
    if (token === "[") {
      const record: Record<string, unknown> = {};
      while (tokens[at] !== "]") {
        const key = take();
        take("|->");
        record[key] = value();
        if (tokens[at] !== "]") take(",");
      }
      take("]");
      return record;
    }
    if (token === "(") {
      const mapping: Record<string, unknown> = {};
      for (;;) {
        const key = value();
        take(":>");
        mapping[String(key)] = value();
        if (take() === ")") break;
        if (tokens[at - 1] !== "@@") throw new Error("unreadable");
      }
      return mapping;
    }
    if (/^-?\d+$/u.test(token)) return Number(token);
    if (token.startsWith("\"")) return JSON.parse(token) as string;
    if (token === "TRUE" || token === "FALSE") return token === "TRUE";
    if (/^[A-Za-z_]/u.test(token)) return token;
    throw new Error("unreadable");
  };
  try {
    const result = value();
    return at === tokens.length ? result : text;
  } catch { return text; }
}

/** A TLC state's variables as values (`tlaValue`), for a reading. */
export function stateValues(valuation: string): Record<string, unknown> {
  return Object.fromEntries([...stateVariables(valuation.split(/\r?\n/u))].map(([name, text]) => [name, tlaValue(text)]));
}
