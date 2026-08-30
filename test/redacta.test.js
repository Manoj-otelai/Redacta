import test from "node:test";
import assert from "node:assert/strict";
import { isLuhnValid, isStructurallyValidSsn } from "../src/validators.js";
import { confidenceScore } from "../src/scoring.js";
import { detectCandidates, syntheticReplacement, validateCustomPattern } from "../src/detectors.js";
import { createFindingRegistry } from "../src/registry.js";
import { structuredFieldRanges, structuredFields } from "../src/structured.js";
import { loadTextDocument, createTextArtifact } from "../src/textDocument.js";
import { applyRedactions, exportSanitizedDocument, getVerificationCertificate, listStructuredFields, redactField, registerCustomPattern, scanDocumentPII, verifyRedaction } from "../src/tools.js";
import { reconstructPageText, syntheticGroups, syntheticRange } from "../src/pdfDocument.js";

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

test("synthetic replacements avoid primary placeholder collisions", () => {
  const cases = [
    ["ssn", "219-48-7631", "219-48-7642", "123-45-6789", "219-48-7631"],
    ["credit_card", "4000 0000 0000 0002", "4000 0000 0000 0010", "4111 1111 1111 1111", "4000 0000 0000 0002"],
    ["email", "user_alpha@redacta.local", "user_beta@redacta.local", "test@example.com", "user_alpha@redacta.local"],
    ["phone", "(202) 555-0100", "(202) 555-0111", "(415) 555-0198", "(202) 555-0100"],
  ];
  for (const [type, placeholder, alternate, normalValue, primary] of cases) {
    assert.equal(syntheticReplacement(type, placeholder, new Set([placeholder])), alternate);
    assert.equal(syntheticReplacement(type, normalValue), primary);
  }
});

test("custom pattern validation rejects unsafe definitions and normalizes valid ones", () => {
  assert.equal(validateCustomPattern({ name: "1bad", pattern: "EMP-\\d+" }).ok, false);
  assert.equal(validateCustomPattern({ name: "SSN", pattern: "EMP-\\d+" }).ok, false);
  assert.equal(validateCustomPattern({ name: "employee_id", pattern: "[" }).ok, false);
  assert.equal(validateCustomPattern({ name: "employee_id", pattern: ".*" }).ok, false);
  assert.equal(validateCustomPattern({ name: "employee_id", pattern: "EMP", flags: "g" }).ok, false);
  assert.equal(validateCustomPattern({ name: "employee_id", pattern: "x".repeat(201) }).ok, false);
  assert.deepEqual(validateCustomPattern({ name: "employee_id", pattern: "EMP-\\d{6}", flags: "i" }), {
    ok: true,
    value: { name: "employee_id", source: "EMP-\\d{6}", flags: "i" },
  });
});

test("custom pattern registration requires approval", async () => {
  const approvedContext = {
    state: { revision: 0, customPatterns: [], artifact: null, verification: null },
    callSource: "agent",
    requestConfirmation: async (message) => {
      assert.equal(message, 'Agent requested: register custom pattern "employee_id" (EMP-\\d{6})');
      return true;
    },
    onStateChanged() {},
  };
  const approved = await registerCustomPattern(approvedContext, {
    name: "employee_id",
    pattern: "EMP-\\d{6}",
  });
  assert.deepEqual(approved, { status: "success", name: "employee_id", totalPatterns: 1 });
  assert.equal(approvedContext.state.customPatterns.length, 1);

  const deniedContext = {
    state: { revision: 0, customPatterns: [], artifact: null, verification: null },
    callSource: "agent",
    requestConfirmation: async () => false,
    onStateChanged() {},
  };
  const denied = await registerCustomPattern(deniedContext, {
    name: "employee_id",
    pattern: "EMP-\\d{6}",
  });
  assert.deepEqual(denied, { status: "denied", message: "User denied the custom pattern request." });
  assert.equal(deniedContext.state.customPatterns.length, 0);
});

test("custom pattern findings stay privacy-safe through redaction and verification", async () => {
  const registry = createFindingRegistry();
  const document = await loadTextDocument("Employee EMP-123456 and EMP-654321");
  const state = { artifact: null, verification: null, revision: 0, maskMode: "synthetic_replacement", customPatterns: [] };
  const context = { document, registry, state, callSource: "user", onFindingsChanged() {}, onVerificationChanged() {}, onStateChanged() {} };
  const registration = await registerCustomPattern(context, { name: "employee_id", pattern: "EMP-\\d{6}" });
  assert.equal(registration.status, "success");
  const scan = await scanDocumentPII(context);
  assert.equal(scan.totalDetected, 2);
  assert.equal(scan.findings.every((finding) => finding.type === "custom:employee_id" && !("value" in finding)), true);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id), maskMode: "synthetic_replacement" });
  const artifactText = await state.artifact.blob.text();
  assert.equal(artifactText.includes("EMP-123456"), false);
  assert.equal(artifactText.includes("EMP-654321"), false);
  const verification = await verifyRedaction(context);
  assert.equal(verification.passed, true);
  assert.equal(verification.originalValuesFound, 0);
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
  assert.deepEqual(Object.keys(result.findings[0]).sort(), ["confidence", "id", "origin", "page", "status", "type"]);
  for (const field of ["location", "charStart", "charEnd", "boundingBox"]) {
    assert.equal(field in result.findings[0], false);
  }
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

test("detector skips zero-length custom matches", () => {
  const findings = detectCandidates("A", ["custom:optional"], undefined, [{ name: "optional", source: "A?", flags: "" }]);
  assert.deepEqual(findings.map((finding) => finding.length), [1]);
});

test("verification exposes a count and projected unmasked list", async () => {
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
  assert.equal("remaining" in result, false);
  for (const finding of result.unmasked) {
    assert.deepEqual(Object.keys(finding).sort(), ["confidence", "id", "origin", "page", "status", "type"]);
  }
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

test("synthetic PDF ranges stay page-local when document offsets are global", () => {
  const original = "123-45-6789";
  const item = { str: `Employee SSN: ${original}` };
  const pageStart = 900;
  const entry = { start: 10, end: 10 + item.str.length, item };
  const localStart = entry.start + item.str.indexOf(original);
  const finding = { offset: pageStart + localStart, length: original.length };
  const range = syntheticRange(finding.offset - pageStart, finding.length, [entry]);
  const replacement = "219-48-7631";
  const rebuilt = `${item.str.slice(0, range.start)}${replacement}${item.str.slice(range.end)}`;
  assert.deepEqual(range, { start: localStart - entry.start, end: localStart - entry.start + original.length });
  assert.equal(rebuilt.includes(original), false);
  assert.equal(rebuilt.includes(replacement), true);
});

test("redacting without target ids leaves excluded findings untouched", () => {
  const registry = createFindingRegistry();
  registry.replace([
    { type: "ssn", value: "123-45-6789", offset: 0, length: 11, confidence: 1 },
    { type: "email", value: "a@example.com", offset: 20, length: 13, confidence: 1 },
  ]);
  const [first, second] = registry.all();
  registry.exclude([second.id]);
  registry.markRedacted();
  assert.equal(registry.get(first.id).status, "redacted");
  assert.equal(registry.get(second.id).status, "excluded");
});

test("synthetic grouping routes findings without text offsets to blackout fallback", () => {
  const item = { str: "Employee SSN: 123-45-6789" };
  const pageInfo = { start: 0, items: [{ start: 0, end: item.str.length, item }] };
  const located = { offset: 14, length: 11, status: "redacted", value: "123-45-6789" };
  const manual = { type: "manual_rectangle", status: "redacted", value: "", boundingBox: { x: 1, y: 2, width: 3, height: 4 } };
  const { groups, unplaced } = syntheticGroups(pageInfo, [located, manual]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].findings, [located]);
  assert.deepEqual(unplaced, [manual]);
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
  assert.equal(artifactText.includes("user_alpha@redacta.local"), true);
  assert.equal(artifactText.includes("4000 0000 0000 0002"), true);
  const result = await verifyRedaction(context);
  assert.equal(result.passed, true);
  assert.equal(result.remainingFindings, 0);
  assert.equal(result.syntheticPlaceholders, 3);
  assert.equal(result.originalValuesFound, 0);
  assert.equal((await exportSanitizedDocument(context)).status, "success");
});

test("synthetic placeholder collisions are not counted as original values", async () => {
  const card = "4000 0000 0000 0002";
  const email = "user_alpha@redacta.local";
  const registry = createFindingRegistry();
  const document = await loadTextDocument(`Email ${email} card ${card}`);
  const state = { artifact: null, verification: null, revision: 0, maskMode: "synthetic_replacement" };
  const context = { document, registry, state, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await applyRedactions(context, { targetIds: registry.all().map((finding) => finding.id), maskMode: "synthetic_replacement" });
  const result = await verifyRedaction(context);
  assert.equal(result.passed, true);
  assert.equal(result.originalValuesFound, 0);
  assert.equal(result.syntheticPlaceholders, 2);
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

test("structured fields aggregate JSON string leaves without exposing values", async () => {
  const sensitive = "123-45-6789";
  const owner = "owner@example.test";
  const json = `{"records":[{"ssn":"${sensitive}","record_count":1},{"ssn":"987-65-4321","record_count":2}],"meta":{"owner_email":"${owner}","active":true}}`;
  const document = await loadTextDocument({ name: "records.json", type: "application/json", text: async () => json });
  const fields = structuredFields(document);
  assert.deepEqual(fields, [
    { field: "records[].ssn", occurrences: 2 },
    { field: "meta.owner_email", occurrences: 1 },
  ]);
  assert.equal(JSON.stringify(fields).includes(sensitive), false);
  assert.equal(JSON.stringify(fields).includes(owner), false);
  assert.equal(JSON.stringify(fields).includes("record_count"), false);
});

test("structured field ranges slice back to exact original values", async () => {
  const json = '{"records":[{"email":"a@example.test"},{"email":"b@example.test"}]}';
  const document = await loadTextDocument({ name: "records.json", type: "application/json", text: async () => json });
  const ranges = structuredFieldRanges(document, "records[].email");
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges.map(({ start, end, value }) => json.slice(start, end) === value), [true, true]);
  assert.deepEqual(ranges.map(({ value }) => value), ["a@example.test", "b@example.test"]);
});

test("redacting a JSON field requires approval and preserves valid JSON", async () => {
  const json = '{"records":[{"ssn":"123-45-6789"},{"ssn":"987-65-4321"}],"meta":{"record_count":2}}';
  const document = await loadTextDocument({ name: "records.json", type: "application/json", text: async () => json });
  const deniedRegistry = createFindingRegistry();
  const deniedState = { artifact: null, verification: null, revision: 0, maskMode: "blackout", customPatterns: [] };
  const deniedContext = {
    document,
    registry: deniedRegistry,
    state: deniedState,
    callSource: "agent",
    requestConfirmation: async (message) => {
      assert.equal(message, 'Agent requested: redact field "records[].ssn" (2 values)');
      return false;
    },
    onFindingsChanged() {},
    onVerificationChanged() {},
    onStateChanged() {},
  };
  await scanDocumentPII(deniedContext);
  const before = deniedRegistry.all().map((finding) => ({ ...finding }));
  const denied = await redactField(deniedContext, { field: "records[].ssn" });
  assert.deepEqual(denied, { status: "denied", message: "User denied the field redaction request." });
  assert.deepEqual(deniedRegistry.all(), before);
  assert.equal(deniedState.artifact, null);

  const registry = createFindingRegistry();
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout", customPatterns: [] };
  const context = { document, registry, state, callSource: "user", onFindingsChanged() {}, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  const initialCount = registry.all().length;
  const result = await redactField(context, { field: "records[].ssn" });
  assert.equal(result.status, "success");
  assert.equal(result.valuesRedacted, 2);
  assert.equal(registry.all().length, initialCount);
  const artifactText = await state.artifact.blob.text();
  assert.equal(artifactText.includes("123-45-6789"), false);
  assert.equal(artifactText.includes("987-65-4321"), false);
  assert.equal(artifactText.includes('"records"'), true);
  assert.equal(artifactText.includes('"ssn"'), true);
  assert.doesNotThrow(() => JSON.parse(artifactText));
});

test("redacting a scanned JSON field creates no duplicate records", async () => {
  const json = '{"records":[{"email":"a@example.test"},{"email":"b@example.test"}]}';
  const document = await loadTextDocument({ name: "records.json", type: "application/json", text: async () => json });
  const registry = createFindingRegistry();
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout", customPatterns: [] };
  const context = { document, registry, state, callSource: "user", onFindingsChanged() {}, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  const count = registry.all().length;
  const result = await redactField(context, { field: "records[].email" });
  assert.equal(result.valuesRedacted, 2);
  assert.equal(registry.all().length, count);
  const artifactText = await state.artifact.blob.text();
  assert.equal(artifactText.includes("a@example.test"), false);
  assert.equal(artifactText.includes("b@example.test"), false);
});

test("redactField reports its batch and restores only that batch", async () => {
  const json = '{"records":[{"ssn":"123-45-6789","email":"a@example.test"},{"ssn":"987-65-4321","email":"b@example.test"}]}';
  const document = await loadTextDocument({ name: "records.json", type: "application/json", text: async () => json });
  const registry = createFindingRegistry();
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout", customPatterns: [] };
  const context = { document, registry, state, callSource: "user", onFindingsChanged() {}, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  const ssnIds = registry.all().filter((finding) => finding.type === "ssn").map((finding) => finding.id);
  registry.markRedacted(ssnIds);
  const result = await redactField(context, { field: "records[].email" });
  const emailIds = registry.all().filter((finding) => finding.type === "email").map((finding) => finding.id);
  assert.deepEqual(result.redactedIds, emailIds);
  assert.deepEqual(
    registry.all().filter((finding) => finding.status === "redacted").map((finding) => finding.id).sort(),
    [...ssnIds, ...emailIds].sort(),
  );
  registry.restore(result.redactedIds);
  assert.deepEqual(
    registry.all().filter((finding) => finding.status === "redacted").map((finding) => finding.id).sort(),
    ssnIds.sort(),
  );
  assert.deepEqual(
    registry.all().filter((finding) => finding.status === "pending").map((finding) => finding.id).sort(),
    emailIds.sort(),
  );
});

test("redacting a CSV column masks every data cell without changing other columns", async () => {
  const csv = "employee_id,ssn,note\nEMP-1,123-45-6789,alpha\nEMP-2,987-65-4321,beta\n";
  const document = await loadTextDocument({ name: "records.csv", type: "text/csv", text: async () => csv });
  const registry = createFindingRegistry();
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout", customPatterns: [] };
  const context = { document, registry, state, callSource: "user", onFindingsChanged() {}, onVerificationChanged() {}, onStateChanged() {} };
  const result = await redactField(context, { field: "ssn" });
  assert.equal(result.valuesRedacted, 2);
  const output = await state.artifact.blob.text();
  const inputRows = csv.trimEnd().split("\n");
  const outputRows = output.trimEnd().split("\n");
  assert.equal(outputRows[0], inputRows[0]);
  assert.deepEqual(outputRows.map((row) => row.split(",")[0]), inputRows.map((row) => row.split(",")[0]));
  assert.deepEqual(outputRows.map((row) => row.split(",")[2]), inputRows.map((row) => row.split(",")[2]));
  assert.equal(output.includes("123-45-6789"), false);
  assert.equal(output.includes("987-65-4321"), false);
});

test("structured fields are unavailable for TXT documents", async () => {
  const document = await loadTextDocument("plain text");
  const result = await listStructuredFields({ document, registry: createFindingRegistry(), state: {} });
  assert.equal(result.status, "error");
  assert.equal(result.message, "Structured fields are available for JSON and CSV documents only.");
});

test("JSON field redaction verifies and issues a certificate", async () => {
  const json = '{"records":[{"ssn":"123-45-6789","email":"a@example.test"},{"ssn":"987-65-4321","email":"b@example.test"}],"meta":{"record_count":2}}';
  const document = await loadTextDocument({ name: "records.json", type: "application/json", text: async () => json });
  const registry = createFindingRegistry();
  const state = { artifact: null, verification: null, revision: 0, maskMode: "blackout", customPatterns: [] };
  const context = { document, registry, state, callSource: "user", onFindingsChanged() {}, onVerificationChanged() {}, onStateChanged() {} };
  await scanDocumentPII(context);
  await redactField(context, { field: "records[].ssn" });
  const remainingIds = registry.all()
    .filter((finding) => finding.status === "pending")
    .map((finding) => finding.id);
  await applyRedactions(context, { targetIds: remainingIds });
  const verification = await verifyRedaction(context);
  assert.equal(verification.passed, true);
  assert.equal(verification.originalValuesFound, 0);
  assert.ok(verification.certificate);
});
