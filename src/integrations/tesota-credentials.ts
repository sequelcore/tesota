import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { windowsPowerShell, windowsSystemProgram } from "../windows-system.js";

const maxBytes = 64 * 1024;

/**
 * The credentials Tesota keeps, and the kinds each provider may hold
 * (decisions 021 and 031): Codex's OAuth login, an Anthropic API key, an
 * OpenRouter key, pasted or issued by its browser sign-in, and one OpenCode
 * key that Zen and Go share, kept in one file, and a TypeSafe key for the
 * answer check's first pass on Jev (decision 035). An Anthropic OAuth credential
 * is never accepted: a claude.ai login belongs to Claude Code, not to Tesota.
 */
const providers = {
  "openai-codex": { types: ["oauth"], file: "codex", refused: "Only valid Codex OAuth credentials are supported" },
  anthropic: { types: ["api_key"], file: "anthropic", refused: "Only an Anthropic API key can be stored" },
  openrouter: { types: ["api_key", "issued_key"], file: "openrouter", refused: "Only an OpenRouter key can be stored" },
  opencode: { types: ["api_key"], file: "opencode", refused: "Only an OpenCode API key can be stored" },
  "opencode-go": { types: ["api_key"], file: "opencode", refused: "Only an OpenCode API key can be stored" },
  typesafe: { types: ["api_key"], file: "typesafe", refused: "Only a TypeSafe API key can be stored" },
} as const satisfies Record<string, { types: readonly ("oauth" | "api_key" | "issued_key")[]; file: string; refused: string }>;
type ProviderId = keyof typeof providers;

function isProvider(id: string): id is ProviderId {
  return Object.hasOwn(providers, id);
}

function isOAuthCredential(value: unknown): value is Credential {
  return typeof value === "object" && value !== null && "type" in value && value.type === "oauth" &&
    "access" in value && typeof value.access === "string" && value.access.length > 0 &&
    "refresh" in value && typeof value.refresh === "string" && value.refresh.length > 0 &&
    "expires" in value && typeof value.expires === "number" && Number.isFinite(value.expires);
}

/**
 * OpenRouter's sign-in exchanges its code for a lasting, user-controlled key,
 * which Pi keeps as an OAuth credential with no refresh token.
 */
function isIssuedKeyCredential(value: unknown): value is Credential {
  return typeof value === "object" && value !== null && "type" in value && value.type === "oauth" &&
    "access" in value && typeof value.access === "string" && value.access.length > 0 &&
    "refresh" in value && value.refresh === "" && "expires" in value && value.expires === Number.MAX_SAFE_INTEGER;
}

function isApiKeyCredential(value: unknown): value is Credential {
  return typeof value === "object" && value !== null && "type" in value && value.type === "api_key" &&
    "key" in value && typeof value.key === "string" && value.key.trim().length > 0 && !("env" in value);
}

const kinds = { oauth: isOAuthCredential, api_key: isApiKeyCredential, issued_key: isIssuedKeyCredential } as const;

/** Whether a record is a kind of credential this provider may hold. */
function isStorable(id: ProviderId, value: unknown): value is Credential {
  return (providers[id].types as readonly (keyof typeof kinds)[]).some((kind) => kinds[kind](value));
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Pi owns OAuth and API-key use. This store owns each provider's private persistence and mutation lock. */
export class TesotaCredentials implements CredentialStore {
  private readonly directory: string;
  private readonly files: Readonly<Record<string, string>>;
  private prepared: Promise<void> | undefined;
  /**
   * `files` names the file a provider's credential is kept in, for a route
   * the operator added (decision 050): its own account, beside the default
   * route's.
   */
  constructor(directory: string = join(homedir(), ".tesota", "auth"), files: Readonly<Record<string, string>> = {}) {
    this.directory = directory;
    this.files = files;
  }

  /** The credential store of an added route of a Pi kind: the kind's provider kept in the route's own file. */
  static forRoute(route: string, provider: string, directory?: string): TesotaCredentials {
    return new TesotaCredentials(directory, { [provider]: route });
  }

  private fileOf(id: ProviderId): string {
    return this.files[id] ?? providers[id].file;
  }

  private checkProvider(id: string): ProviderId {
    if (!isProvider(id)) throw new Error("Unsupported credential provider");
    return id;
  }

  private ensurePrivate(): Promise<void> { return this.prepared ??= this.prepare(); }

  private async prepare(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 }) !== undefined;
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Credential directory is not private storage");
    if (process.platform === "win32") {
      // No credentials pass through subprocesses. Grant only the current Windows user.
      const identity = execFileSync(windowsSystemProgram("whoami.exe"), ["/user", "/fo", "csv", "/nh"],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (sid === undefined) throw new Error("Cannot establish credential directory owner");
      const path = this.directory.replaceAll("'", "''");
      execFileSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; $directory=[System.IO.DirectoryInfo]::new('${path}'); ` +
        `$owner=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner); ` +
        `$sid=[System.Security.Principal.SecurityIdentifier]::new('${sid}'); ` +
        `$current=$owner.GetOwner([System.Security.Principal.SecurityIdentifier]); ` +
        `if($current.Value -ne $sid.Value){` +
        `if(-not $${created ? "true" : "false"}){throw 'Unexpected owner'}; ` +
        `$owner.SetOwner($sid); $directory.SetAccessControl($owner); ` +
        `$owner=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner); ` +
        `if($owner.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Cannot establish owner'}}; ` +
        `$acl=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); ` +
        `$acl.SetAccessRuleProtection($true,$false); ` +
        `foreach($entry in @($acl.Access)){$acl.RemoveAccessRuleSpecific($entry)}; ` +
        `$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); ` +
        `$acl.AddAccessRule($rule); $directory.SetAccessControl($acl)`],
        { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    } else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error("Credential directory must be owned by this user with mode 0700");
    }
  }

  private async load(id: ProviderId): Promise<Credential | undefined> {
    const path = join(this.directory, `${this.fileOf(id)}.json`);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error("Invalid credential file");
      if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
        throw new Error("Credential file is not private");
      }
      const file = await open(path, "r");
      let bytes: Buffer;
      try {
        bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const chunk = await file.read(bytes, length, bytes.length - length, null);
          if (chunk.bytesRead === 0) break;
          length += chunk.bytesRead;
        }
        if (length > maxBytes) throw new Error("Credential exceeds storage bound");
        bytes = bytes.subarray(0, length);
      } finally { await file.close(); }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isStorable(id, value)) throw new Error("Invalid credential");
      return value;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return undefined;
      throw new Error("Cannot read Tesota credentials; repair private storage before continuing");
    }
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const provider = this.checkProvider(id);
    options?.signal?.throwIfAborted();
    await this.ensurePrivate();
    return this.load(provider);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const saved: CredentialInfo[] = [];
    for (const id of Object.keys(providers) as ProviderId[]) {
      const credential = await this.read(id, options);
      if (credential !== undefined) saved.push({ providerId: id, type: credential.type });
    }
    return saved;
  }

  private async locked<T>(id: ProviderId, operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    await this.ensurePrivate();
    const name = `${this.fileOf(id)}.lock`;
    const lock = join(this.directory, name);
    const deadline = Date.now() + 10_000;
    let handle;
    while (handle === undefined) {
      options?.signal?.throwIfAborted();
      try { handle = await open(lock, "wx", 0o600); }
      catch (error) {
        if (readErrorCode(error) !== "EEXIST") throw new Error("Cannot lock Tesota credentials");
        if (Date.now() >= deadline) throw new Error(`Tesota credentials are busy; a stopped process may have left ${name}`);
        await setTimeout(50, undefined, options?.signal === undefined ? {} : { signal: options.signal });
      }
    }
    try { options?.signal?.throwIfAborted(); return await operation(); }
    finally { await handle.close(); await rm(lock); }
  }

  async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions): Promise<Credential | undefined> {
    const provider = this.checkProvider(id);
    return this.locked(provider, async () => {
      const current = await this.load(provider);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      if (!isStorable(provider, next)) throw new Error(providers[provider].refused);
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > maxBytes) throw new Error("Credential exceeds storage bound");
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        options?.signal?.throwIfAborted();
        await rename(temporary, join(this.directory, `${this.fileOf(provider)}.json`));
      } finally { await rm(temporary, { force: true }); }
      return next;
    }, options);
  }

  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    const provider = this.checkProvider(id);
    await this.locked(provider, async () => { await rm(join(this.directory, `${this.fileOf(provider)}.json`), { force: true }); }, options);
  }
}
