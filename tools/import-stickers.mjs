#!/usr/bin/env node
// Convert local PNG/JPEG stickers into SQL for the 0007/0009 asset schema.
// The generated SQL contains image bytes: keep it local and never commit it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { STICKER_MAX_BYTES } from "../src/config.js";
import { normalizeStickerNote } from "../src/stickers.js";
const args = process.argv.slice(2);
const inputDir = path.resolve(args[0] ?? "stickers");

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node tools/import-stickers.mjs [stickers-directory] > local/stickers.sql");
  console.log('Optional manifest maps filename stems to {"name":"name","tags":[],"note":"usage"} entries.');
  process.exit(0);
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeName(value) {
  const name = String(value ?? "").trim();
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) {
    throw new Error(`invalid sticker name: ${name}`);
  }
  return name;
}

const manifestPath = path.join(inputDir, "manifest.json");
let manifest = {};
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const files = readdirSync(inputDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name))
  .map((entry) => entry.name)
  .sort();
if (files.length === 0) throw new Error(`no PNG/JPEG stickers found in ${inputDir}`);

const now = Date.now();
const statements = [];
const names = new Set();
const fingerprints = new Set();
for (const filename of files) {
  const stem = path.basename(filename, path.extname(filename));
  const metadata = manifest[stem] ?? {};
  const name = safeName(metadata.name ?? stem);
  if (names.has(name)) throw new Error(`duplicate sticker name: ${name}`);
  names.add(name);

  const bytes = readFileSync(path.join(inputDir, filename));
  if (bytes.length === 0 || bytes.length > STICKER_MAX_BYTES) {
    throw new Error(`${filename}: size must be 1..${STICKER_MAX_BYTES} bytes`);
  }
  const extension = path.extname(filename).toLowerCase();
  const isPng = extension === ".png";
  const isValidImage = isPng
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isValidImage) throw new Error(`${filename}: file signature does not match PNG/JPEG extension`);
  const mimeType = isPng ? "image/png" : "image/jpeg";
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  if (fingerprints.has(fingerprint)) {
    throw new Error(`${filename}: identical image bytes already exist in this import set`);
  }
  fingerprints.add(fingerprint);
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags
        .filter((tag) => typeof tag === "string" && /^[\p{L}\p{N}_ -]{1,24}$/u.test(tag))
        .slice(0, 12)
    : [];
  const note = normalizeStickerNote(metadata.note ?? "");

  statements.push(
    `INSERT INTO sticker_assets ` +
      `(name, mime_type, data_base64, tags_json, fingerprint, note, created_at, updated_at) ` +
      `VALUES (${sql(name)}, ${sql(mimeType)}, ${sql(bytes.toString("base64"))}, ` +
      `${sql(JSON.stringify(tags))}, ${sql(fingerprint)}, ${sql(note)}, ${now}, ${now}) ` +
      `ON CONFLICT(name) DO UPDATE SET ` +
      `mime_type = excluded.mime_type, data_base64 = excluded.data_base64, ` +
      `tags_json = excluded.tags_json, fingerprint = excluded.fingerprint, ` +
      `note = excluded.note, enabled = 1, updated_at = excluded.updated_at;`,
  );
}

for (const statement of statements) console.log(statement);
console.error(`Prepared ${statements.length} sticker asset(s). SQL contains image bytes; keep it local.`);
