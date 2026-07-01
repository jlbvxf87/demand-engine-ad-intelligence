// Single source of truth for the Remotion composition is `remotion/`. The
// draft-render-worker builds from its own directory (Railway rootDirectory =
// /draft-render-worker), so it needs a physical copy at
// `draft-render-worker/remotion/`. This script mirrors the canonical files into
// the worker so the two can never drift. Run: `npm run sync-remotion`.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "remotion");
const DST = join(root, "draft-render-worker", "remotion");

mkdirSync(DST, { recursive: true });

let changed = 0;
for (const name of readdirSync(SRC)) {
  if (!/\.(ts|tsx)$/.test(name)) continue;
  const src = readFileSync(join(SRC, name));
  let dst = null;
  try {
    dst = readFileSync(join(DST, name));
  } catch {
    /* new file */
  }
  if (!dst || !src.equals(dst)) {
    writeFileSync(join(DST, name), src);
    console.log(`synced remotion/${name} -> draft-render-worker/remotion/${name}`);
    changed++;
  }
}
console.log(changed ? `sync-remotion: ${changed} file(s) updated` : "sync-remotion: already in sync");
