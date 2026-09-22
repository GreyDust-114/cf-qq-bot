// Syntax-check every source file that ships with the Worker.
// Works on Windows and POSIX without shell glob expansion.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const files = readdirSync(path.join(root, "src"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => `src/${name}`);

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  });
}

console.log(`syntax ok: ${files.length} files`);
