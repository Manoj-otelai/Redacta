import { syntheticReplacement } from "./detectors.js";

export async function loadTextDocument(file) {
  const text = typeof file === "string" ? file : await file.text();
  const name = file?.name ?? "document.txt";
  const format = name.toLowerCase().match(/\.(txt|json|csv)$/)?.[1] ?? "txt";
  const size = new TextEncoder().encode(text).byteLength;
  return {
    kind: "text",
    format,
    name,
    type: file?.type || "text/plain",
    size,
    sizeLabel: formatBytes(size),
    pageCount: 1,
    text,
    bytes: new TextEncoder().encode(text),
  };
}

function formatBytes(size) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

export function createTextArtifact(document, registry, maskMode = "blackout") {
  let output = document.text;
  for (const finding of registry.active().sort((left, right) => right.offset - left.offset)) {
    const replacement = maskMode === "synthetic_replacement"
      ? syntheticReplacement(finding.type, finding.value)
      : "█".repeat(Math.max(4, finding.value.length));
    output = `${output.slice(0, finding.offset)}${replacement}${output.slice(finding.offset + finding.length)}`;
  }
  return new Blob([output], { type: document.type || "text/plain" });
}
