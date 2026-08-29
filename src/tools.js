import { detectorTypes, MAX_CUSTOM_PATTERNS, validateCustomPattern } from "./detectors.js";
import { scanText } from "./scanner.js";
import { createTextArtifact } from "./textDocument.js";
import { verifyArtifact } from "./verify.js";

const safeError = (message) => ({ status: "error", message });
const builtInCategoryNames = detectorTypes.join(", ");
async function digestBlob(blob) {
  const bytes = await blob.arrayBuffer();
  if (!globalThis.crypto?.subtle) return "";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export const TOOL_SCHEMAS = {
  inspectDocument: { type: "object", properties: {}, additionalProperties: false },
  scanDocumentPII: { type: "object", properties: { categories: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  applyRedactions: { type: "object", properties: { targetIds: { type: "array", items: { type: "string" } }, maskMode: { type: "string", enum: ["blackout", "synthetic_replacement"] } }, additionalProperties: false },
  verifyRedaction: { type: "object", properties: { categories: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  getFindingDetails: { type: "object", properties: { findingId: { type: "string" } }, required: ["findingId"], additionalProperties: false },
  exportSanitizedDocument: { type: "object", properties: { filename: { type: "string" } }, additionalProperties: false },
  getVerificationCertificate: { type: "object", properties: {}, additionalProperties: false },
  registerCustomPattern: { type: "object", properties: { name: { type: "string" }, pattern: { type: "string" }, flags: { type: "string" } }, required: ["name", "pattern"], additionalProperties: false },
};

export const TOOL_DESCRIPTIONS = {
  inspectDocument: "Inspect local document metadata without returning document contents or sensitive values.",
  scanDocumentPII: `Scan the local document for selected sensitive categories and return privacy-safe findings only; valid values are ${builtInCategoryNames}, plus registered custom names; never returns document contents or sensitive values.`,
  applyRedactions: "Apply selected local redactions and generate a sanitized artifact; never returns document contents or sensitive values.",
  verifyRedaction: `Rescan the generated artifact bytes and report whether redaction passed; valid values are ${builtInCategoryNames}, plus registered custom names; never returns document contents or sensitive values.`,
  getFindingDetails: "Retrieve privacy-safe details for one finding; never returns document contents or sensitive values.",
  exportSanitizedDocument: "Download the verified local artifact; never returns document contents or sensitive values.",
  getVerificationCertificate: "Retrieve metadata-only proof that the local artifact passed verification; never returns document contents or sensitive values.",
  registerCustomPattern: "Register a custom pattern locally after human approval; results expose counts and locations only and never include document contents or sensitive values.",
};

function validCategories(context) {
  return [...detectorTypes, ...(context.state?.customPatterns ?? []).map(({ name }) => `custom:${name}`)];
}

function categoryScope(context, categories) {
  const available = validCategories(context);
  const scope = categories?.length ? categories : available;
  if (scope.some((category) => !available.includes(category))) {
    return { error: safeError(`Unknown category. Valid categories: ${available.join(", ")}.`) };
  }
  return { scope };
}

function invalidate(context) {
  context.state.revision = (context.state.revision || 0) + 1;
  context.state.artifact = null;
  context.state.verification = null;
  context.onStateChanged?.();
}

export async function inspectDocument(context) {
  const document = context.document;
  if (!document) return safeError("No document loaded.");
  return { status: "success", fileType: document.format, filename: document.name, documentSize: document.sizeLabel, pageCount: document.pageCount, processingStatus: "ready" };
}

export async function scanDocumentPII(context, { categories } = {}) {
  if (!context.document) return safeError("No document loaded.");
  const selection = categoryScope(context, categories);
  if (selection.error) return selection.error;
  const candidates = await scanText(context.document.text, selection.scope, context.onProgress, context.state?.customPatterns ?? []);
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
  if (context.callSource === "agent" && context.requestConfirmation) {
    const count = targetIds?.length || context.registry.selected().length;
    const allowed = await context.requestConfirmation(`Agent requested: Redact ${count} findings`);
    if (!allowed) return { status: "denied", message: "User denied the redaction request." };
  }
  context.registry.markRedacted(targetIds);
  context.state.maskMode = maskMode;
  invalidate(context);
  await buildArtifact(context, { maskMode });
  context.onFindingsChanged?.();
  return { status: "success", totalRedacted: context.registry.active().length, maskMode, findings: context.registry.projectAll() };
}

export async function verifyRedaction(context, { categories } = {}) {
  if (!context.document) return { status: "failed", passed: false, remainingFindings: 0, remaining: [], categories: {}, message: "No document loaded." };
  const selection = categoryScope(context, categories);
  if (selection.error) return selection.error;
  const scope = selection.scope;
  if (!context.state.artifact || context.state.artifact.revision !== context.state.revision) {
    await buildArtifact(context, { maskMode: context.state.maskMode });
  }
  if (context.state.artifact.digest) {
    const actualDigest = await digestBlob(context.state.artifact.blob);
    if (actualDigest !== context.state.artifact.digest) {
      const result = {
        status: "failed",
        passed: false,
        remainingFindings: 0,
        remaining: [],
        categories: Object.fromEntries(scope.map((type) => [type, 0])),
        message: "Generated artifact integrity check failed.",
        integrityFailure: true,
        syntheticPlaceholders: 0,
        originalValuesFound: 0,
        certificate: null,
      };
      context.state.verification = result;
      context.onVerificationChanged?.(result);
      return result;
    }
  }
  const result = await verifyArtifact(
    context.state.artifact,
    scope,
    context.registry.project,
    context.registry.all().map((finding) => ({ type: finding.type, value: finding.value })),
    context.state.customPatterns ?? [],
  );
  const unmasked = context.registry.all().filter((finding) => finding.status !== "redacted" && scope.includes(finding.type));
  const countFor = (type) => Math.max(
    result.remaining.filter((finding) => finding.type === type).length,
    unmasked.filter((finding) => finding.type === type).length,
  );
  result.categories = Object.fromEntries(scope.map((type) => [type, countFor(type)]));
  result.extractableFindings = result.remaining.length;
  result.unmaskedRegions = unmasked.length;
  result.unmasked = unmasked.map(context.registry.project);
  result.remainingFindings = Object.values(result.categories).reduce((total, count) => total + count, 0);
  result.passed = result.remainingFindings === 0 && result.originalValuesFound === 0;
  result.status = result.passed ? "verified" : "failed";
  result.artifactDigest = context.state.artifact.digest;
  if (result.passed && result.artifactDigest) {
    const groups = context.state.artifact.digest.slice(0, 12).toUpperCase().match(/.{4}/g).join("-");
    result.certificate = {
      certificateId: `RDCT-${groups}`,
      digestAlgorithm: "SHA-256",
      artifactDigest: result.artifactDigest,
      issuedAt: new Date().toISOString(),
      documentName: context.document.name,
      fileType: context.document.format,
      pageCount: context.document.pageCount,
      maskMode: context.state.artifact.maskMode,
      findingsRedacted: context.registry.active().length,
      categoriesChecked: scope.length,
      extractableFindings: result.extractableFindings,
      unmaskedRegions: result.unmaskedRegions,
      syntheticPlaceholders: result.syntheticPlaceholders,
      originalValuesFound: result.originalValuesFound,
    };
  } else {
    result.certificate = null;
  }
  context.state.verification = result;
  context.onVerificationChanged?.(result);
  return result;
}

export async function getVerificationCertificate(context) {
  const verification = context.state.verification;
  const artifact = context.state.artifact;
  if (verification?.passed && !verification.artifactDigest) {
    return { status: "blocked", message: "A verification digest is unavailable in this context." };
  }
  if (!verification?.passed || !verification.certificate || !artifact?.blob) {
    return { status: "blocked", message: "A verified artifact is required before retrieving its certificate." };
  }
  const actualDigest = await digestBlob(artifact.blob);
  if (actualDigest !== verification.artifactDigest || actualDigest !== verification.certificate.artifactDigest) {
    return { status: "blocked", message: "The verified artifact is stale. Verify it again before retrieving its certificate." };
  }
  return { status: "success", certificate: verification.certificate };
}

export async function registerCustomPattern(context, { name, pattern, flags = "" } = {}) {
  const customPatterns = context.state.customPatterns ?? [];
  const validation = validateCustomPattern({ name, pattern, flags }, customPatterns.map(({ name: existingName }) => existingName));
  if (!validation.ok) return safeError(validation.message);
  if (customPatterns.length >= MAX_CUSTOM_PATTERNS) return safeError(`A maximum of ${MAX_CUSTOM_PATTERNS} custom patterns is allowed.`);
  if (context.callSource === "agent") {
    const preview = validation.value.source.slice(0, 80);
    const allowed = context.requestConfirmation
      ? await context.requestConfirmation(`Agent requested: register custom pattern "${validation.value.name}" (${preview})`)
      : false;
    if (!allowed) return { status: "denied", message: "User denied the custom pattern request." };
  }
  context.state.customPatterns = [...customPatterns, validation.value];
  invalidate(context);
  return { status: "success", name: validation.value.name, totalPatterns: context.state.customPatterns.length };
}

export async function getFindingDetails(context, { findingId } = {}) {
  const finding = context.registry.get(findingId);
  return finding ? context.registry.project(finding) : safeError("Finding not found.");
}

export async function exportSanitizedDocument(context, { filename } = {}) {
  if (!context.state.verification?.passed) return { status: "blocked", verified: false, message: "Verification must pass before export." };
  const artifact = context.state.artifact;
  if (!artifact?.blob || (context.state.verification.artifactDigest && await digestBlob(artifact.blob) !== context.state.verification.artifactDigest)) {
    return { status: "blocked", verified: false, integrityFailure: true, message: "Generated artifact integrity check failed." };
  }
  if (context.callSource === "agent" && context.requestConfirmation) {
    const allowed = await context.requestConfirmation("Agent requested: Export the verified sanitized document");
    if (!allowed) return { status: "denied", verified: false, message: "User denied the export request." };
  }
  const outputName = filename || `redacta-sanitized.${context.document.kind === "pdf" ? "pdf" : "txt"}`;
  context.downloadArtifact?.(artifact.blob, outputName);
  return { status: "success", filename: outputName, size: artifact.blob.size, verified: true };
}

export async function buildArtifact(context, { maskMode = "blackout" } = {}) {
  if (!context.document) return safeError("No document loaded.");
  const blob = context.document.kind === "pdf"
    ? await (await import("./pdfDocument.js")).rasterizePdf(context.document, context.registry, maskMode)
    : createTextArtifact(context.document, context.registry, maskMode);
  context.state.artifact = { kind: context.document.kind, blob, maskMode, revision: context.state.revision || 0, digest: await digestBlob(blob) };
  context.state.verification = null;
  return { status: "success", size: blob.size, type: blob.type };
}
