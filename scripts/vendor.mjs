import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  ["node_modules/pdfjs-dist/build/pdf.mjs", "vendor/pdfjs/pdf.mjs"],
  ["node_modules/pdfjs-dist/build/pdf.worker.mjs", "vendor/pdfjs/pdf.worker.mjs"],
  ["node_modules/pdfjs-dist/build/pdf.sandbox.mjs", "vendor/pdfjs/pdf.sandbox.mjs"],
  ["node_modules/pdf-lib/dist/pdf-lib.esm.js", "vendor/pdf-lib/pdf-lib.esm.js"],
];
await rm(resolve(root, "vendor"), { recursive: true, force: true });
for (const [source, destination] of copies) {
  const target = resolve(root, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(root, source), target);
}
const compatibility = `if (typeof globalThis.Iterator !== "function") { globalThis.Iterator = function Iterator() {}; globalThis.Iterator.prototype = {}; }\nif (typeof Uint8Array.prototype.toHex !== "function") { Uint8Array.prototype.toHex = function toHex() { return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join(""); }; }\nif (typeof Uint8Array.prototype.toBase64 !== "function") { Uint8Array.prototype.toBase64 = function toBase64() { let binary = ""; for (const byte of this) binary += String.fromCharCode(byte); return btoa(binary); }; }\nif (typeof Map.prototype.getOrInsertComputed !== "function") { Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, callback) { if (!this.has(key)) this.set(key, callback(key)); return this.get(key); }; }\nif (typeof Map.prototype.getOrInsert !== "function") { Map.prototype.getOrInsert = function getOrInsert(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); }; }\n`;
for (const destination of ["vendor/pdfjs/pdf.mjs", "vendor/pdfjs/pdf.worker.mjs"]) {
  const target = resolve(root, destination);
  await writeFile(target, compatibility + await readFile(target, "utf8"));
}
console.log(`Vendored ${copies.length} browser modules.`);
