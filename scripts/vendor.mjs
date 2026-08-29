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
// Shim built-ins missing from the supported browser/Node runtime before pdf.js executes.
const compatibility = await readFile(resolve(root, "src/pdfCompat.js"), "utf8");
for (const destination of ["vendor/pdfjs/pdf.mjs", "vendor/pdfjs/pdf.worker.mjs"]) {
  const target = resolve(root, destination);
  await writeFile(target, compatibility + await readFile(target, "utf8"));
}
console.log(`Vendored ${copies.length} browser modules.`);
