import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assets the compiler does not emit.
 *
 * `schema.sql` is read at runtime by `db/client.ts`, so a `dist` without it compiles cleanly and
 * then fails on the first line of `connect()`. Which is precisely how this was found.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(join(root, "src", "schema.sql"), join(root, "dist", "schema.sql"));
console.log("copied schema.sql -> dist/");
