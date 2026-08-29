import { detectorTypes } from "./detectors.js";
import { scanText } from "./scanner.js";
import { createTextArtifact } from "./textDocument.js";
import { verifyArtifact } from "./verify.js";

const safeError = (message) => ({ status: "error", message });

export async function inspectDocument(context) {
  const document = context.document;
  if (!document) return safeError("No document loaded.");
  return { status: "success", fileType: document.kind, filename: document.name, documentSize: document.size, pageCount: document.pageCount, processingStatus: "ready" };
}

export async function scanDocumentPII(context, { categories } = {}) {
  if (!context.document) return safeError("No document loaded.");
  const candidates = await scanText(context.document.text, categories, context.onProgress);
  const locate = context.document.kind === "pdf"
    ? (await import("./pdfDocument.js")).locatePdfFinding
    : () => null;
  context.registry.replace(candidates, (candidate) => context.document.kind === "pdf"
    ? locate(context.document, candidate)
    : { page: 1, location: `characters ${candidate.offset}-${candidate.offset + candidate.length}`, charStart: candidate.offset, charEnd: candidate.offset + candidate.length });
  context.onFindingsChanged?.();
  return { status: "success", totalDetected: candidates.length, findings: context.registry.projectAll() };
}

export async function applyRedactions(context, { targetIds, maskMode = "blackout" } = {}) {
  if (!context.document) return safeError("No document loaded.");
  if (!["blackout", "synthetic_replacement"].includes(maskMode)) return safeError("Unsupported mask mode.");
  context.registry.markRedacted(targetIds);
  context.state.artifact = null;
  context.state.verification = null;
  context.state.maskMode = maskMode;
  context.onFindingsChanged?.();
  return { status: "success", totalRedacted: context.registry.active().length, maskMode, findings: context.registry.projectAll() };
}

export async function verifyRedaction(context, { categories } = {}) {
  if (!context.state.artifact) return { status: "failed", passed: false, remainingFindings: [], categories: {}, message: "No generated artifact exists." };
  const result = await verifyArtifact(context.state.artifact, categories ?? detectorTypes, context.registry.project);
  context.state.verification = result;
  context.onVerificationChanged?.(result);
  return result;
}

export async function getFindingDetails(context, { findingId } = {}) {
  const finding = context.registry.get(findingId);
  return finding ? context.registry.project(finding) : safeError("Finding not found.");
}

export async function exportSanitizedDocument(context, { filename } = {}) {
  if (!context.state.verification?.passed) return { status: "blocked", verified: false, message: "Verification must pass before export." };
  const artifact = context.state.artifact;
  const outputName = filename || `privacyvault-sanitized.${context.document.kind === "pdf" ? "pdf" : "txt"}`;
  context.downloadArtifact?.(artifact.blob, outputName);
  return { status: "success", filename: outputName, size: artifact.blob.size, verified: true };
}

export async function buildArtifact(context, { maskMode = "blackout" } = {}) {
  if (!context.document) return safeError("No document loaded.");
  const blob = context.document.kind === "pdf"
    ? await (await import("./pdfDocument.js")).rasterizePdf(context.document, context.registry, maskMode)
    : createTextArtifact(context.document, context.registry, maskMode);
  context.state.artifact = { kind: context.document.kind, blob, maskMode };
  context.state.verification = null;
  return { status: "success", size: blob.size, type: blob.type };
}
