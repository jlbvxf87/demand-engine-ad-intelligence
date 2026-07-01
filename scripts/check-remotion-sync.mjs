// CI/build guard: fail loudly if the worker's Remotion copy has drifted from the
// canonical `remotion/`. Runs as `prebuild`, so a Vercel/local build can't ship
// with a stale worker composition. Fix with `npm run sync-remotion`.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "remotion");
const DST = join(root, "draft-render-worker", "remotion");

const drift = [];
for (const name of readdirSync(SRC)) {
  if (!/\.(ts|tsx)$/.test(name)) continue;
  let dst = null;
  try {
    dst = readFileSync(join(DST, name));
  } catch {
    /* missing in worker */
  }
  if (!dst || !readFileSync(join(SRC, name)).equals(dst)) drift.push(name);
}

if (drift.length) {
  console.error(
    `\n✗ remotion/ and draft-render-worker/remotion/ have drifted: ${drift.join(", ")}\n` +
      `  Run 'npm run sync-remotion' and commit.\n`,
  );
  process.exit(1);
}
console.log("✓ remotion sync check passed");
