import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const provider = "openai-codex";
const maxBytes = 64 * 1024;

/** Pi owns OAuth. This store owns one provider's private persistence and mutation lock. */
export class CodexCredentials implements CredentialStore {
  private readonly directory: string;
  private prepared: Promise<void> | undefined;
  constructor(directory: string = join(homedir(), ".tesota", "auth")) { this.directory = directory; }

  private checkProvider(id: string): void {
    if (id !== provider) throw new Error("Unsupported credential provider");
  }

  private ensurePrivate(): Promise<void> { return this.prepared ??= this.prepare(); }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Credential directory is not private storage");
    if (process.platform === "win32") {
      // No credentials pass through subprocesses. Grant only the current Windows user.
      const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (sid === undefined) throw new Error("Cannot establish credential directory owner");
      const path = this.directory.replaceAll("'", "''");
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; $directory=[System.IO.DirectoryInfo]::new('${path}'); ` +
        `$owner=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner); ` +
        `$acl=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access); ` +
        `$sid=[System.Security.Principal.SecurityIdentifier]::new('${sid}'); ` +
        `if($owner.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected owner'}; ` +
        `$acl.SetAccessRuleProtection($true,$false); ` +
        `foreach($entry in @($acl.Access)){$acl.RemoveAccessRuleSpecific($entry)}; ` +
        `$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); ` +
        `$acl.AddAccessRule($rule); $directory.SetAccessControl($acl)`],
        { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    } else if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error("Credential directory must be owned by this user with mode 0700");
    }
  }

  private async load(): Promise<Credential | undefined> {
    const path = join(this.directory, "codex.json");
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
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "oauth" ||
          !("access" in value) || typeof value.access !== "string" || !value.access ||
          !("refresh" in value) || typeof value.refresh !== "string" || !value.refresh ||
          !("expires" in value) || typeof value.expires !== "number" || !Number.isFinite(value.expires)) {
        throw new Error("Invalid OAuth credential");
      }
      return value as Credential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read Tesota credentials; repair private storage before continuing");
    }
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.checkProvider(id);
    options?.signal?.throwIfAborted();
    await this.ensurePrivate();
    return this.load();
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return await this.read(provider, options) === undefined ? [] : [{ providerId: provider, type: "oauth" }];
  }

  private async locked<T>(operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    await this.ensurePrivate();
    const lock = join(this.directory, "codex.lock");
    const deadline = Date.now() + 10_000;
    let handle;
    while (handle === undefined) {
      options?.signal?.throwIfAborted();
      try { handle = await open(lock, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Cannot lock Tesota credentials");
        if (Date.now() >= deadline) throw new Error("Tesota credentials are busy; a stopped process may have left codex.lock");
        await setTimeout(50, undefined, options?.signal === undefined ? {} : { signal: options.signal });
      }
    }
    try { options?.signal?.throwIfAborted(); return await operation(); }
    finally { await handle.close(); await rm(lock); }
  }

  async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.checkProvider(id);
    return this.locked(async () => {
      const current = await this.load();
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      if (next.type !== "oauth" || typeof next.access !== "string" || !next.access ||
          typeof next.refresh !== "string" || !next.refresh || !Number.isFinite(next.expires)) {
        throw new Error("Only valid Codex OAuth credentials are supported");
      }
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > maxBytes) throw new Error("Credential exceeds storage bound");
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        options?.signal?.throwIfAborted();
        await rename(temporary, join(this.directory, "codex.json"));
      } finally { await rm(temporary, { force: true }); }
      return next;
    }, options);
  }

  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    this.checkProvider(id);
    await this.locked(async () => { await rm(join(this.directory, "codex.json"), { force: true }); }, options);
  }
}
