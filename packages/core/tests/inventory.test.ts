import { expect, test } from "bun:test";
import { join } from "node:path";
import { type Node, Project, type PropertyAccessExpression, SyntaxKind } from "ts-morph";

/**
 * Where each Pi type Tesota's `src/` uses goes once Pi is gone (#433):
 * - `contract`: the engine provides it through `src/contract.ts`;
 * - `engine`: the engine exports an equivalent (a version, a shell);
 * - `model`: `pi-ai` types, which Tesota keeps;
 * - `shell`: the terminal interface, which moves to the `tesota` shell.
 */
const owners: Record<string, "contract" | "engine" | "model" | "shell"> = {
  // The extension API and what handlers see.
  ExtensionAPI: "contract", ExtensionContext: "contract", InputEvent: "contract", ToolExecutionStartEvent: "contract",
  ToolResultEventBase: "contract", BashToolResultEvent: "contract", BoundaryState: "contract",
  AgentBeforeSettleEventResult: "contract", ContextUsage: "contract", ModelRegistry: "contract", SessionManager: "contract",
  SessionEntry: "contract", SessionMessageEntry: "contract", ToolDefinition: "contract", AgentToolResult: "contract",
  TypeLiteral: "contract",
  // What the engine exports beside the API.
  VERSION: "engine", getShellConfig: "engine", ShellConfig: "engine",
  // pi-ai, which stays.
  AssistantMessage: "model", BaseModel: "model", Model: "model", TextContent: "model", ToolCall: "model", SystemMessage: "model",
  // The terminal interface.
  ExtensionUIContext: "shell", CustomMessage: "shell", MessageRenderOptions: "shell", Theme: "shell", ThemeColor: "shell",
  CustomEditor: "shell", Editor: "shell", EditorTheme: "shell", KeybindingsManager: "shell", keyText: "shell",
  FooterDataProvider: "shell", ReadonlyFooterDataProvider: "shell", TUI: "shell", Terminal: "shell", TerminalColors: "shell",
  TerminalColorMode: "shell", TuiMouseEvent: "shell", TuiMouseEventResult: "shell", MouseRegion: "shell", Box: "shell",
  Component: "shell", Color: "shell", colorToRgb: "shell", foregroundAnsi: "shell", sliceByColumn: "shell",
  truncateToWidth: "shell", visibleWidth: "shell", wrapTextWithAnsi: "shell",
};

/** Members of contract types that are interface, not contract: they move to the shell. */
const shellMembers = new Set(["ExtensionAPI.registerMessageRenderer", "ExtensionContext.ui"]);

/** The contract interface each Pi type corresponds to, member for member. */
const contractNames: Record<string, string> = {
  ExtensionAPI: "ExtensionAPI", ExtensionContext: "ExtensionContext", InputEvent: "InputEvent",
  ToolExecutionStartEvent: "ToolExecutionStartEvent", ToolResultEventBase: "ToolResultEvent",
  BashToolResultEvent: "ToolResultEvent", BoundaryState: "SettleEvent", ContextUsage: "ContextUsage",
  ModelRegistry: "ModelRegistry", ToolDefinition: "ToolDefinition", AgentToolResult: "ToolResult",
};

const root = join(import.meta.dir, "..", "..", "..");
const fromPi = (node: Node) => /[\\/]@earendil-works[\\/]pi-/.test(node.getSourceFile().getFilePath());

/** The interface or class a member is declared in, or the kind of node it sits in when it has no name. */
function ownerOf(declaration: Node): string {
  const parent = declaration.getParent();
  if (parent?.isKind(SyntaxKind.InterfaceDeclaration) || parent?.isKind(SyntaxKind.ClassDeclaration)) return parent.getName() ?? "";
  return parent?.getKindName() ?? "";
}

/** `on:<event>` for a call to `on` with an event name, otherwise the member's name. */
function memberOf(access: PropertyAccessExpression): string {
  const name = access.getName();
  const event = name === "on" ? access.getParentIfKind(SyntaxKind.CallExpression)?.getArguments()[0]
    ?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() : undefined;
  return event === undefined ? name : `on:${event}`;
}

/** Every Pi type Tesota uses, with the members and events it uses on each. */
function used(): Map<string, Set<string>> {
  const project = new Project({ tsConfigFilePath: join(root, "tsconfig.json"), skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(join(root, "src", "**", "*.ts"));
  const uses = new Map<string, Set<string>>();
  const add = (owner: string, member?: string) => {
    const members = uses.get(owner) ?? new Set<string>();
    if (member !== undefined) members.add(member);
    uses.set(owner, members);
  };
  for (const file of project.getSourceFiles()) {
    for (const declaration of file.getImportDeclarations()) {
      if (!declaration.getModuleSpecifierValue().startsWith("@earendil-works/")) continue;
      for (const named of declaration.getNamedImports()) add(named.getName());
    }
    for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const declaration = access.getNameNode().getSymbol()?.getDeclarations()[0];
      if (declaration !== undefined && fromPi(declaration)) add(ownerOf(declaration), memberOf(access));
    }
  }
  return uses;
}

/** The members each interface in `src/contract.ts` declares, with `on:<event>` for each event it accepts. */
function contract(): Map<string, Set<string>> {
  const file = new Project({ skipAddingFilesFromTsConfig: true }).addSourceFileAtPath(join(import.meta.dir, "..", "src", "contract.ts"));
  return new Map(file.getInterfaces().map((declaration) => [declaration.getName(), new Set(declaration.getMembers().flatMap((member) => {
    const name = member.getSymbol()?.getName() ?? "";
    const event = member.asKind(SyntaxKind.MethodSignature)?.getParameters()[0]?.getTypeNode()
      ?.asKind(SyntaxKind.LiteralType)?.getLiteral().asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
    return name === "on" && event !== undefined ? [`on:${event}`] : [name];
  }))]));
}

test("every Pi API Tesota uses is in the contract, an engine export, pi-ai or the shell", () => {
  const uses = used();
  const declared = contract();
  const unplaced = [...uses.keys()].filter((owner) => owners[owner] === undefined);
  const missing = [...uses].flatMap(([owner, members]) => {
    const name = contractNames[owner];
    if (owners[owner] !== "contract" || name === undefined) return [];
    return [...members].filter((member) => !shellMembers.has(`${owner}.${member}`) && !declared.get(name)?.has(member))
      .map((member) => `${owner}.${member} (contract: ${name})`);
  });
  const stale = Object.keys(owners).filter((owner) => !uses.has(owner));
  expect({ unplaced, missing, stale }).toEqual({ unplaced: [], missing: [], stale: [] });
}, 120_000);
