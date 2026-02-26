/**
 * Build hash computation for code staleness detection.
 *
 * Both the server (at startup) and the plugin (at connect time) compute
 * a hash of the key source files. If the hashes differ, the server is
 * running stale code and should be restarted.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

/** Files whose content determines the server's behavior */
const HASH_FILES = [
  "server/index.ts",
  "server/routes.ts",
  "server/state.ts",
  "server/pid.ts",
  "server/sse.ts",
  "shared/types.ts",
  "shared/version.ts",
  "plugin/index.ts",
];

/** Package root directory (one level up from shared/) */
const PACKAGE_ROOT = join(import.meta.dir, "..");

/**
 * Compute a deterministic hash of the key source files.
 * Returns a 12-character hex string.
 *
 * Both the server and plugin call this — if the result differs,
 * the server is running stale code.
 */
export function computeBuildHash(): string {
  const hasher = createHash("sha256");
  for (const relPath of HASH_FILES) {
    try {
      const content = readFileSync(join(PACKAGE_ROOT, relPath), "utf-8");
      hasher.update(content);
    } catch {
      // File missing — hash the path as placeholder to maintain consistency
      hasher.update(`__missing__:${relPath}`);
    }
  }
  return hasher.digest("hex").slice(0, 12);
}
