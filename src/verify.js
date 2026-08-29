import { detectCandidates, syntheticReplacement } from "./detectors.js";

const placeholderValues = new Set([
  syntheticReplacement("ssn", ""),
  syntheticReplacement("credit_card", ""),
  syntheticReplacement("email", ""),
  syntheticReplacement("phone", ""),
  syntheticReplacement("api_key", "sk_live_example"),
  syntheticReplacement("api_key", "ghp_example"),
  syntheticReplacement("bearer_token", ""),
  syntheticReplacement("private_key", ""),
]);
const dbPlaceholderTail = syntheticReplacement("db_connection_string", "postgres://user:password@localhost/database").split("://")[1];

function isSyntheticPlaceholder(finding) {
  if (placeholderValues.has(finding.value)) return true;
  return finding.type === "db_connection_string" && finding.value.split("://")[1] === dbPlaceholderTail;
}

export async function verifyArtifact(artifact, categories, project, originalValues = []) {
  const bytes = await artifact.blob.arrayBuffer();
  const text = artifact.kind === "pdf"
    ? await (await import("./pdfDocument.js")).extractPdfText(bytes)
    : new TextDecoder().decode(bytes);
  const findings = detectCandidates(text, categories);
  const syntheticFindings = findings.filter(isSyntheticPlaceholder);
  const remaining = findings.filter((finding) => !isSyntheticPlaceholder(finding)).map(project).filter(Boolean);
  const originalValuesFound = originalValues.filter(({ type, value }) => {
    if (typeof value !== "string" || value.length === 0 || value === syntheticReplacement(type, value)) return false;
    return text.includes(value);
  }).length;
  const categoryNames = categories?.length ? categories : [...new Set(findings.map((finding) => finding.type))];
  return {
    status: remaining.length || originalValuesFound ? "failed" : "verified",
    passed: remaining.length === 0 && originalValuesFound === 0,
    remainingFindings: remaining.length,
    remaining,
    categories: Object.fromEntries(categoryNames.map((type) => [type, remaining.filter((finding) => finding.type === type).length])),
    syntheticPlaceholders: syntheticFindings.length,
    originalValuesFound,
  };
}
