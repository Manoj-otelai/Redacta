import test from "node:test";
import assert from "node:assert/strict";
import { isLuhnValid, isStructurallyValidSsn } from "../src/validators.js";
import { confidenceScore } from "../src/scoring.js";
import { detectCandidates } from "../src/detectors.js";
import { createFindingRegistry } from "../src/registry.js";
import { loadTextDocument, createTextArtifact } from "../src/textDocument.js";
import { applyRedactions, exportSanitizedDocument, scanDocumentPII, verifyRedaction } from "../src/tools.js";
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
  assert.equal(result.remainingFindings, result.remaining.length);
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
