import test from "node:test";
import assert from "node:assert/strict";
import { isLuhnValid, isStructurallyValidSsn } from "../src/validators.js";
import { confidenceScore } from "../src/scoring.js";
import { detectCandidates } from "../src/detectors.js";
import { createFindingRegistry } from "../src/registry.js";
import { loadTextDocument } from "../src/textDocument.js";
import { scanDocumentPII } from "../src/tools.js";

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
});

test("detector validates API and connection shapes", () => {
  const findings = detectCandidates("key sk_live_abc123456 and postgres://u:p@host/db");
  assert.deepEqual(findings.map((finding) => finding.type), ["api_key", "db_connection_string"]);
});
