<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)" />
    <source srcset="assets/logo.svg" media="(prefers-color-scheme: light)" />
    <img src="assets/logo.svg" alt="" width="72" height="72" />
  </picture>
</p>

<h1 align="center">redacta</h1>

<p align="center">
  The WebMCP-native privacy boundary for AI agents.<br />
  <a href="https://github.com/Manoj-otelai/Redacta">Source</a> ·
  <a href="app.html">Workspace</a> ·
  <a href="ai.html">Machine-readable page</a>
</p>

Redacta is a browser-local, zero-backend document privacy workspace. An AI agent can inspect, scan, redact, verify, and export without receiving document contents or sensitive values.

## Privacy boundary

The agent can see finding IDs, categories, confidence, status, coarse page numbers, counts, and operation results. It cannot see document contents, matched values, secrets, locations, offsets, geometry, raw errors, or generated artifact bytes. Raw detector values remain inside the private in-memory finding registry. Export is blocked until the current artifact passes byte-level verification.

## Run locally

Serve the repository root with either:

```powershell
npx serve .
python -m http.server 4173
```

Open the displayed local URL. `index.html` is the landing page; the workspace is `app.html`, and `app.html?demo=agent` starts the full agent run on load. No build step is required. Netlify publishes the repository root via `netlify.toml`. Fonts (`assets/fonts/`) and landing artwork (`assets/img/`) are served from the repository, so the pages make no external requests.
`ai.html` is the machine-readable rendering of the landing page, toggled from the bottom pill on either page.
The app menu includes `Demo TXT`, `Demo PDF`, and `Demo JSON`; the JSON option loads a synthetic employee record set locally. When the loaded document is JSON or CSV, the agent demo additionally lists its structured fields and redacts a whole field before continuing the run.

## Test and vendor

```powershell
npm ci
npm run vendor
npm test
```

`vendor/` contains the exact `pdfjs-dist@6.2.108` and `pdf-lib@1.17.1` browser artifacts. Runtime code makes no third-party requests.

## WebMCP tools

All ten tools are registered on `document.modelContext` or `navigator.modelContext` when native WebMCP is available, and are exposed in Demo Mode otherwise. Every description promises that contents and sensitive values are never returned.

- `inspectDocument({})` — local metadata; returns `fileType`, `filename`, human-readable `documentSize`, `pageCount`, and `processingStatus`.
- `scanDocumentPII({categories?: ["ssn", "credit_card", "email", "phone", "api_key", "private_key", "bearer_token", "db_connection_string"]})` — privacy-safe findings.
- `applyRedactions({targetIds?: string[], maskMode?: "blackout"|"synthetic_replacement"})` — applies selected findings and creates the artifact.
- `verifyRedaction({categories?: [...]})` — rescans artifact bytes and checks mask coverage; returns `passed`, `remainingFindings` as a count, `extractableFindings`, `unmaskedRegions`, projected `remaining`/`unmasked` findings, and per-category counts.
- `getFindingDetails({findingId: string})` — returns one projected finding.
- `exportSanitizedDocument({filename?: string})` — downloads only after verification passes.

- `getVerificationCertificate({})` - returns metadata-only proof for a verified artifact, including its digest and check counts.
- `registerCustomPattern({name, pattern, flags?})` - registers a local custom detector after human approval; returns only the registered name and count.
- `listStructuredFields({})` - lists JSON keys or CSV columns with occurrence counts and detected-finding counts, never values.
- `redactField({field, maskMode?})` - redacts every string value of one JSON key or every cell in one CSV column locally after human approval.

Mutating agent calls require an in-page human confirmation. Activity entries contain only summarized arguments and the privacy-safe results returned to the agent.

Custom patterns are limited to five registered definitions and run locally; their results expose counts and metadata only and never document contents or sensitive values. Every agent-initiated registration requires human approval, and validation rejects unsafe, empty, uncompilable, or slow patterns before the approval prompt.

Structured-field tools execute locally and never return document contents or sensitive values. Only string JSON leaves and CSV cells are redactable; non-string JSON leaves remain untouched so the sanitized artifact stays valid JSON. Agent-initiated field redactions require human approval.

## Synthetic replacement and certificates

Synthetic replacement keeps the document readable with plausible local placeholders. Verification recognizes those placeholders and reports their count separately, while also checking that none of the original raw values remain anywhere in the artifact; either an original value or an uncovered region fails verification. A passing run can issue a metadata-only certificate with the artifact digest, document metadata, and numeric check results, never document text or finding values.

## Architecture decisions

- **Plain ES modules, no framework or bundler:** static hosting keeps the product inspectable and avoids a build-time dependency surface.
- **Vendored PDF engines:** exact pdf.js and pdf-lib versions are copied into `vendor/`, so document data never needs a CDN or third-party runtime request.
- **Worker scanning:** detector work runs in a module worker and reports progress by detector category.
- **Layered detectors:** regex candidates are followed by structural validation (Luhn, SSN ranges, key/token/connection shapes) and confidence scoring.
- **Rasterized PDF export:** every source page is rendered to a canvas, padded whole-item masks are baked into PNGs, and a new image-only PDF is built. This removes the text layer and avoids under-redaction from interpolated character geometry.
- **Manual marking accessibility:** manual region marking on PDFs currently requires a pointer, while text documents support keyboard selection and Enter to commit.
- **Artifact-byte verification:** verification re-reads the generated Blob, extracts text from PDFs, decodes text artifacts, and rescans the resulting bytes. App state is never treated as proof.
- **Mask-coverage verification:** a rasterized PDF has no text layer, so a text rescan alone would pass while a skipped finding is still legible in the page image. Verification therefore reports three checks separately (`extractableFindings`, `unmaskedRegions`, `originalValuesFound`), and any of them failing blocks export.
- **Explicit privacy projection:** the finding registry stores raw values privately and exposes only a fixed safe-field whitelist to tools, UI activity, and errors.
- **Synthetic replacement and certificates:** synthetic mode substitutes plausible local placeholders while verification excludes those known placeholders from remaining findings and separately counts them. A passing run can issue a metadata-only certificate containing the artifact digest, document metadata, and check counts; it contains no document text or values.
