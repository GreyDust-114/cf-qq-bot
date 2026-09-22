// Syntax-check project JavaScript: Worker sources, dev scripts and tests.
// Works on Windows and POSIX without shell glob expansion.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const targets = ["src", "scripts", "test"];
const files = [];

for (const target of targets) {
  for (const entry of readdirSync(path.join(root, target), {
    recursive: true,
  })) {
    const relative = `${target}/${String(entry).replaceAll("\\", "/")}`;

    if (relative.endsWith(".js") || relative.endsWith(".mjs")) {
      files.push(relative);
    }
  }
}

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  });
}

console.log(`syntax ok: ${files.length} files`);
