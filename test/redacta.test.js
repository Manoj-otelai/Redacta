import test from "node:test";
import assert from "node:assert/strict";
import { isLuhnValid, isStructurallyValidSsn } from "../src/validators.js";
import { confidenceScore } from "../src/scoring.js";
import { detectCandidates } from "../src/detectors.js";
import { createFindingRegistry } from "../src/registry.js";
import { loadTextDocument, createTextArtifact } from "../src/textDocument.js";
import { applyRedactions, exportSanitizedDocument, getVerificationCertificate, scanDocumentPII, verifyRedaction } from "../src/tools.js";
import { reconstructPageText } from "../src/pdfDocument.js";

test("Luhn accepts valid cards and rejects invalid cards", () => {
  assert.equal(isLuhnValid("4111 1111 1111 1111"), true);
  assert.equal(isLuhnValid("4111 1111 1111 1112"), false);
});

test("SSN structural validation rejects reserved ranges", () => {
  for (const value of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-3456", "123-45-0000"]) {
    assert.equal(isStructurallyValidSsn(value), false, value);
  }
  assert.equal(isStructurallyValidSsn("123-45-6789"), true);
});

test("confidence score reflects validation layer", () => {
  assert.ok(confidenceScore({ type: "ssn", candidate: true, validated: true }) > confidenceScore({ type: "ssn", candidate: true, validated: false }));
  assert.equal(confidenceScore({ type: "ssn", candidate: false, validated: true }), 0);
});

test("tool payload projection never contains planted sensitive values", async () => {
  const planted = "123-45-6789 and jordan@example.com and 4111 1111 1111 1111";
  const registry = createFindingRegistry();
  const document = await loadTextDocument({ name: "fixture.txt", type: "text/plain", text: async () => planted });
  const result = await scanDocumentPII({ document, registry, onFindingsChanged() {} });
  const payload = JSON.stringify(result);
  assert.equal(payload.includes("123-45-6789"), false);
  assert.equal(payload.includes("jordan@example.com"), false);
  assert.equal(payload.includes("4111 1111 1111 1111"), false);
  assert.equal(result.findings.every((finding) => !("value" in finding)), true);
  const activity = JSON.stringify({ args: { targetIds: result.findings.map((finding) => finding.id) }, result });
  assert.equal(activity.includes("123-45-6789"), false);
  const failure = await applyRedactions({ document: null, registry, state: {}, onStateChanged() {} }, { targetIds: [] });
  assert.equal(failure.status, "error");
  assert.equal(failure.message.includes("123-45-6789"), false);
  assert.equal(failure.message.includes("jordan@example.com"), false);
});

test("detector validates API and connection shapes", () => {
  const findings = detectCandidates("key sk_live_abc123456 and postgres://u:p@host/db");
  assert.deepEqual(findings.map((finding) => finding.type), ["api_key", "db_connection_string"]);
});

test("verification exposes a count and projected remaining list", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789 and email test@example.com");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  const first = registry.all()[0].id;
  await applyRedactions(context, { targetIds: [first] });
  const result = await verifyRedaction(context);
  assert.equal(typeof result.remainingFindings, "number");
  assert.equal(result.remainingFindings, 1);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining.every((finding) => !("value" in finding)), true);
});

test("verification fails on an unmasked finding even when the artifact has no extractable text", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789 and email test@example.com");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  const [excludedFinding] = registry.all();
  registry.exclude([excludedFinding.id]);
  await applyRedactions(context, { targetIds: registry.all().filter((finding) => finding.status === "pending").map((finding) => finding.id) });
  context.state.artifact = { ...context.state.artifact, blob: new Blob([""], { type: "text/plain" }), digest: "" };
  const result = await verifyRedaction(context);
  assert.equal(result.passed, false);
  assert.equal(result.extractableFindings, 0);
  assert.equal(result.unmaskedRegions, 1);
  assert.equal(result.categories[excludedFinding.type], 1);
  assert.equal(JSON.stringify(result).includes("123-45-6789"), false);
});

test("verification blocks a tampered generated artifact", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id) });
  context.state.artifact.blob = new Blob(["tampered"], { type: "text/plain" });
  const result = await verifyRedaction(context);
  assert.equal(result.passed, false);
  assert.equal(result.remainingFindings, 0);
  assert.equal(result.integrityFailure, true);
});

test("export blocks an artifact changed after verification", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {}, downloadArtifact() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id) });
  const verification = await verifyRedaction(context);
  assert.equal(verification.passed, true);
  context.state.artifact.blob = new Blob(["changed"], { type: "text/plain" });
  const result = await exportSanitizedDocument(context, { filename: "changed.txt" });
  assert.equal(result.status, "blocked");
  assert.equal(result.integrityFailure, true);
});

test("manual findings participate in text artifact masking", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("ordinary local note");
  const manual = registry.addManual({ type: "manual_phrase", page: 1, location: "manual text selection", charStart: 0, charEnd: 8, value: "ordinary" });
  assert.equal(manual.type, "manual_phrase");
  registry.markRedacted([manual.id]);
  const artifact = createTextArtifact(document, registry);
  const output = await artifact.text();
  assert.equal(output.includes("ordinary"), false);
  assert.equal(output.endsWith(" local note"), true);
});

test("registry exclude, restore, and undo-style transitions preserve statuses", () => {
  const registry = createFindingRegistry();
  registry.replace([{ type: "ssn", value: "123-45-6789", offset: 0, length: 11, confidence: 0.9 }]);
  const id = registry.all()[0].id;
  registry.exclude([id]);
  assert.equal(registry.get(id).status, "excluded");
  registry.restore([id]);
  assert.equal(registry.get(id).status, "pending");
  registry.markRedacted([id]);
  registry.restore([id]);
  assert.equal(registry.get(id).status, "pending");
});

test("PDF text reconstruction joins adjacent items and maps offsets", () => {
  const result = reconstructPageText([
    { str: "123-45-", width: 42, transform: [1, 0, 0, 12, 10, 700] },
    { str: "6789", width: 24, transform: [1, 0, 0, 12, 52, 700] },
  ]);
  assert.equal(result.text, "123-45-6789\n");
  assert.equal(result.items[0].start, 0);
  assert.equal(result.items[1].start, 7);
});

test("synthetic text replacement removes originals, reports placeholders, and opens export", async () => {
  const originals = ["123-45-6789", "test@example.com", "4111 1111 1111 1111"];
  const registry = createFindingRegistry();
  const document = await loadTextDocument(`SSN ${originals[0]} email ${originals[1]} card ${originals[2]}`);
  const state = { artifact: null, verification: null, revision: 0, maskMode: "synthetic_replacement" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {}, downloadArtifact() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id), maskMode: "synthetic_replacement" });
  const artifactText = await state.artifact.blob.text();
  assert.equal(originals.some((value) => artifactText.includes(value)), false);
  const result = await verifyRedaction(context);
  assert.equal(result.passed, true);
  assert.equal(result.remainingFindings, 0);
  assert.equal(result.syntheticPlaceholders, 3);
  assert.equal(result.originalValuesFound, 0);
  assert.equal((await exportSanitizedDocument(context)).status, "success");
});

test("original values fail verification independently of detector counts", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id) });
  state.artifact = { ...state.artifact, blob: new Blob(["SSN 123-45-6789"], { type: "text/plain" }), digest: "" };
  const result = await verifyRedaction(context);
  assert.equal(result.passed, false);
  assert.equal(result.originalValuesFound, 1);
});

test("certificate IDs are deterministic for identical bytes and differ for different bytes", async () => {
  async function verify(source) {
    const registry = createFindingRegistry();
    const document = await loadTextDocument(source);
    const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
    const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
    await scanDocumentPII(context);
    await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id) });
    return verifyRedaction(context);
  }
  const first = await verify("A SSN 123-45-6789");
  const second = await verify("A SSN 123-45-6789");
  const different = await verify("B SSN 234-56-7890");
  assert.equal(first.certificate.certificateId, second.certificate.certificateId);
  assert.notEqual(first.certificate.certificateId, different.certificate.certificateId);
  assert.match(first.certificate.certificateId, /^RDCT-[0-9A-F]{4}(?:-[0-9A-F]{4}){2}$/);
});

test("certificate metadata contains no original values and is available through its tool", async () => {
  const original = "123-45-6789";
  const registry = createFindingRegistry();
  const document = await loadTextDocument(`SSN ${original}`);
  const state = { artifact: null, verification: null, revision: 0, maskMode: "synthetic_replacement" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id), maskMode: "synthetic_replacement" });
  const result = await verifyRedaction(context);
  const certificate = result.certificate;
  assert.equal(JSON.stringify(certificate).includes(original), false);
  const exposed = await getVerificationCertificate(context);
  assert.deepEqual(exposed.certificate, certificate);
});

test("digest-less passing verification has no certificate and blocks certificate retrieval", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id) });
  state.artifact = { ...state.artifact, digest: "" };
  const result = await verifyRedaction(context);
  assert.equal(result.passed, true);
  assert.equal(result.certificate, null);
  const certificate = await getVerificationCertificate(context);
  assert.equal(certificate.status, "blocked");
  assert.match(certificate.message, /digest is unavailable/i);
});

test("blackout mode still reports no synthetic placeholders", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("SSN 123-45-6789");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id), maskMode: "blackout" });
  const result = await verifyRedaction(context);
  assert.equal(result.passed, true);
  assert.equal(result.syntheticPlaceholders, 0);
});
