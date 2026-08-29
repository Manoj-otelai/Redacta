# PrivacyVault

PrivacyVault is a browser-local, zero-backend document privacy workspace. An AI agent can inspect, scan, redact, verify, and export without receiving document contents or sensitive values.

## Privacy boundary

The agent can see metadata, finding IDs, categories, safe locations, confidence, counts, verification status, and operation results. It cannot see document contents, matched values, secrets, raw errors, or generated artifact bytes. Raw detector values remain inside the private in-memory finding registry. Export is blocked until the current artifact passes byte-level verification.

## Run locally

Serve the repository root with either:

```powershell
npx serve .
python -m http.server 4173
```

Open the displayed local URL. No build step is required. Netlify publishes the repository root via `netlify.toml`.

## Test and vendor

```powershell
npm ci
npm run vendor
npm test
```

`vendor/` contains the exact `pdfjs-dist@6.2.108` and `pdf-lib@1.17.1` browser artifacts. Runtime code makes no third-party requests.

## WebMCP tools

All six tools are registered on `document.modelContext` when native WebMCP is available, and are exposed in Demo Mode otherwise. Every description promises that contents and sensitive values are never returned.

- `inspectDocument({})` — local metadata; returns `fileType`, human-readable `documentSize`, page count, and status.
- `scanDocumentPII({categories?: ["ssn", "credit_card", "email", "phone", "api_key", "private_key", "bearer_token", "db_connection_string"]})` — privacy-safe findings.
- `applyRedactions({targetIds?: string[], maskMode?: "blackout"|"synthetic_replacement"})` — applies selected findings and creates the artifact.
- `verifyRedaction({categories?: [...]})` — rescans artifact bytes and checks mask coverage; returns `passed`, `remainingFindings` as a count, `extractableFindings`, `unmaskedRegions`, projected `remaining`/`unmasked` findings, and per-category counts.
- `getFindingDetails({findingId: string})` — returns one projected finding.
- `exportSanitizedDocument({filename?: string})` — downloads only after verification passes.

Mutating agent calls require an in-page human confirmation. Activity entries contain only whitelisted argument and result summaries.

## Architecture decisions

- **Plain ES modules, no framework or bundler:** static hosting keeps the product inspectable and avoids a build-time dependency surface.
- **Vendored PDF engines:** exact pdf.js and pdf-lib versions are copied into `vendor/`, so document data never needs a CDN or third-party runtime request.
- **Worker scanning:** detector work runs in a module worker and reports progress by detector category.
- **Layered detectors:** regex candidates are followed by structural validation (Luhn, SSN ranges, key/token/connection shapes) and confidence scoring.
- **Rasterized PDF export:** every source page is rendered to a canvas, padded whole-item masks are baked into PNGs, and a new image-only PDF is built. This removes the text layer and avoids under-redaction from interpolated character geometry.
- **Artifact-byte verification:** verification re-reads the generated Blob, extracts text from PDFs, decodes text artifacts, and rescans the resulting bytes. App state is never treated as proof.
- **Mask-coverage verification:** a rasterized PDF has no text layer, so a text rescan alone would pass while a skipped finding is still legible in the page image. Verification therefore also fails when any detected finding is left unmasked, and reports the two checks separately (`extractableFindings`, `unmaskedRegions`).
- **Explicit privacy projection:** the finding registry stores raw values privately and exposes only a fixed safe-field whitelist to tools, UI activity, and errors.
