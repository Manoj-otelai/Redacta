import { syntheticReplacement } from "./detectors.js";

export async function loadTextDocument(file) {
  const text = typeof file === "string" ? file : await file.text();
  return {
    kind: "text",
    name: file?.name ?? "document.txt",
    type: file?.type || "text/plain",
    size: new TextEncoder().encode(text).byteLength,
    pageCount: 1,
    text,
    bytes: new TextEncoder().encode(text),
  };
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
