import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import pin from "../../../ripgrep.json" with { type: "json" };

const repository = join(import.meta.dir, "..", "..", "..");
const archives = new Map<string, Buffer>();
const force = process.argv.includes("--force");

/** Reads one executable from a checksum-verified release archive, without platform archive commands. */
async function extract(archive: Buffer, asset: string, name: string): Promise<Buffer> {
  const entry = `${asset.replace(/\.(?:tar\.gz|zip)$/u, "")}/${name}`;
  if (asset.endsWith(".tar.gz")) {
    const file = (await new Bun.Archive(archive).files()).get(entry);
    if (file === undefined) throw new Error(`Missing ${entry}`);
    return Buffer.from(await file.arrayBuffer());
  }
  // These pinned ZIPs use ordinary central-directory records and deflated entries (no ZIP64).
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`Missing ZIP directory: ${asset}`);
  let offset = archive.readUInt32LE(end + 16);
  const entries = archive.readUInt16LE(end + 10);
  for (let index = 0; index < entries; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Invalid ZIP directory: ${asset}`);
    const length = archive.readUInt16LE(offset + 28);
    const path = archive.subarray(offset + 46, offset + 46 + length).toString("utf8");
    if (path === entry) {
      if (archive.readUInt16LE(offset + 10) !== 8) throw new Error(`Expected a deflated executable in ${asset}`);
      const local = archive.readUInt32LE(offset + 42);
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      return inflateRawSync(archive.subarray(start, start + archive.readUInt32LE(offset + 20)));
    }
    offset += 46 + length + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  throw new Error(`Missing ${entry}`);
}

for (const [target, triple] of Object.entries(pin.targets)) {
  const asset = pin.assets[triple as keyof typeof pin.assets];
  const name = target.includes("windows") ? "rg.exe" : "rg";
  const directory = join(repository, "vendor", "ripgrep", target);
  const destination = join(directory, name);
  const existing = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!force && existing !== undefined && createHash("sha256").update(existing).digest("hex") === asset.executableSha256) {
    if (!target.includes("windows")) await chmod(destination, 0o755);
    console.log(`Verified ${target}`);
    continue;
  }
  let executable = archives.get(asset.asset);
  if (executable === undefined) {
    const response = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${pin.version}/${asset.asset}`);
    if (!response.ok) throw new Error(`Downloading ${asset.asset}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== asset.sha256) throw new Error(`SHA-256 mismatch: ${asset.asset}`);
    executable = await extract(archive, asset.asset, name);
    if (createHash("sha256").update(executable).digest("hex") !== asset.executableSha256) throw new Error(`SHA-256 mismatch: ${name}`);
    archives.set(asset.asset, executable);
  }
  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, executable, { flag: "wx", mode: 0o755 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  console.log(`Vendored ${target}`);
}
