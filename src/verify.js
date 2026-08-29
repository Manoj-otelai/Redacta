import { detectCandidates } from "./detectors.js";

export async function verifyArtifact(artifact, categories, project) {
  const bytes = await artifact.blob.arrayBuffer();
  const text = artifact.kind === "pdf"
    ? await (await import("./pdfDocument.js")).extractPdfText(bytes)
    : new TextDecoder().decode(bytes);
  const findings = detectCandidates(text, categories);
  const remaining = findings.map(project).filter(Boolean);
  const categoryNames = categories?.length ? categories : [...new Set(findings.map((finding) => finding.type))];
  return {
    status: remaining.length ? "failed" : "verified",
    passed: remaining.length === 0,
    remainingFindings: remaining.length,
    remaining,
    categories: Object.fromEntries(categoryNames.map((type) => [type, remaining.filter((finding) => finding.type === type).length])),
  };
}
