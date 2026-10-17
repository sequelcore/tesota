import { fileURLToPath } from "node:url";

/**
 * Whether this code runs inside a binary `bun build --compile` made (#472).
 * Its modules live in Bun's embedded folder, `/$bunfs/root/` or
 * `B:\~BUN\root\`, where the files beside the code are the ones the build
 * embedded (`packages/core/scripts/build.ts`) and no package can be resolved.
 */
export const inBinary: boolean = /^(?:\/\$bunfs\/|[A-Za-z]:\\~BUN\\)/u.test(fileURLToPath(import.meta.url));
