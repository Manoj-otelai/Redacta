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
  Built for the <a href="https://webmcp.devpost.com/">WebMCP Challenge</a>.
</p>

<p align="center">
  <a href="https://redacta-theta.vercel.app/">Live app</a> ·
  <a href="https://redacta-theta.vercel.app/app.html">Workspace</a> ·
  <a href="https://redacta-theta.vercel.app/app.html?demo=agent">Agent demo</a> ·
  <a href="https://redacta-theta.vercel.app/ai.html">Machine-readable page</a> ·
  <a href="https://github.com/Manoj-otelai/Redacta">Source</a>
</p>

<p align="center">
  <img alt="License: ISC" src="https://img.shields.io/badge/license-ISC-111816" />
</p>

**Live:** [https://redacta-theta.vercel.app/](https://redacta-theta.vercel.app/)

Redacta lets an AI agent inspect, scan, redact, verify, and export a confidential PDF, TXT, JSON, or CSV **without ever receiving the document contents or the sensitive values**. Parsing, detection, masking, verification, and export all run inside the tab. There is no backend and no upload.

The product in one line: the agent can know there are seven SSNs. It never knows what those SSNs are.

## For judges

Open the live app in **ChatGPT’s in-app browser** (WebMCP on by default) or **Chrome 149+** with `chrome://flags/#enable-webmcp-testing` enabled, then restart Chrome.

| What | URL |
| --- | --- |
| Landing | [https://redacta-theta.vercel.app/](https://redacta-theta.vercel.app/) |
| Workspace | [https://redacta-theta.vercel.app/app.html](https://redacta-theta.vercel.app/app.html) |
| Agent demo (starts on load) | [https://redacta-theta.vercel.app/app.html?demo=agent](https://redacta-theta.vercel.app/app.html?demo=agent) |
| Machine-readable landing | [https://redacta-theta.vercel.app/ai.html](https://redacta-theta.vercel.app/ai.html) |
| WebMCP tools | [https://redacta-theta.vercel.app/tools.html](https://redacta-theta.vercel.app/tools.html) |
| Source | [https://github.com/Manoj-otelai/Redacta](https://github.com/Manoj-otelai/Redacta) |

1. Open the [workspace](https://redacta-theta.vercel.app/app.html), or the [agent demo](https://redacta-theta.vercel.app/app.html?demo=agent) to start the full run on load.
2. Open a local PDF, TXT, JSON, or CSV — or click **Run agent demo**, which loads the synthetic contract. Nothing is uploaded.
3. With native WebMCP, the status chip reads **NATIVE WEBMCP** and ten tools are registered on `document.modelContext` or `navigator.modelContext`.
4. Without the flag, **Demo Mode** exposes the same tools on `window` and in the **Console** pane — same schemas, same privacy projection.
5. Click **Run agent demo**, or paste the prompt from the **Agent** pane into ChatGPT. Mutating calls (`applyRedactions`, `exportSanitizedDocument`, `registerCustomPattern`, `redactField`) stop for an in-page confirmation.
6. On the **Agent** pane, expand **What the agent received**. Every payload is rescanned against detected values. A leak is treated as a bug, not a demo state.
7. After a passing verify, the **Redact** pane shows **Verification passed** and the metadata-only certificate id (`Certified RDCT-…` plus a short digest). No document text.
8. Export stays blocked until verification passes all three checks.

Suggested agent prompt (also copied from the workspace):

```
Inspect this document, scan it for SSNs, credit cards, emails and API keys, redact every finding, verify the sanitized copy, then export it. If the file is JSON or CSV, list its structured fields and redact the whole records[].card key.
```

## Why this is a WebMCP use case

These are the four questions the challenge asks submissions to answer.

**Why WebMCP is the right surface.** Redaction is a capability, not a reading task. An agent that scrapes the DOM, or that is handed the file, has already crossed the line the user is trying to protect. WebMCP lets the page publish *operations* — scan these categories, redact these finding IDs, verify the artifact, export only if it passed — while the values stay in a private in-memory registry. The tool API *is* the privacy boundary.

**What is better for the human.** The person keeps a normal document workspace: drop a file, see findings, mark regions, approve or deny the agent. They do not paste a contract into a chat, and they do not trust a black rectangle drawn over live PDF text. The agent drives the workflow; the human stays the authority on mutate and export.

**What people and agents can do together that was hard before.** Before WebMCP, the choice was “don’t use an agent on this file” or “give the agent the file.” Redacta is a third path: the agent can run a complete inspect → scan → redact → verify → export loop, including structured-field redaction on JSON/CSV and human-approved custom detectors, and the only thing that leaves the tab is metadata (IDs, categories, confidence, page numbers, pass/fail, a SHA-256 digest).

**How WebMCP is implemented.** `src/ui.js` registers all ten tools with `document.modelContext.registerTool` or `navigator.modelContext.registerTool`:

```js
modelContext.registerTool({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: TOOL_SCHEMAS[name],
  execute: (input) => execute(name, input),
});
```

Schemas and “never returns document contents or sensitive values” descriptions live in `src/tools.js`. Tool results are projected through a fixed whitelist in `src/registry.js` (`id`, `type`, `confidence`, `status`, `origin`, `page`). Agent-initiated mutations call `requestConfirmation` before they change anything.

## Privacy boundary

| The agent receives | The agent never receives |
| --- | --- |
| Finding IDs and counts | Document text |
| Categories (`ssn`, `credit_card`, …) | Matched values and secrets |
| Confidence and status | Locations, offsets, geometry |
| Coarse page numbers | Artifact bytes |
| Pass/fail and per-category remainder counts | Raw errors that could echo a value |
| Certificate digest and numeric checks | Anything not on the safe-field whitelist |

Raw detector values stay in the in-memory finding registry. Export is blocked until the current artifact passes byte-level verification.

## WebMCP tools

Registered on `document.modelContext` or `navigator.modelContext` when native WebMCP is available; Demo Mode otherwise. Every description states that contents and sensitive values are never returned.

| Tool | What it does | What it returns |
| --- | --- | --- |
| `inspectDocument({})` | Local metadata | `fileType`, `filename`, `documentSize`, `pageCount`, `processingStatus` — no text |
| `scanDocumentPII({categories?})` | Local detectors | Counts and projected findings — no values or locations |
| `getFindingDetails({findingId})` | One finding | Category, confidence, status, origin, page |
| `applyRedactions({targetIds?, maskMode?})` | Mask selected findings | `totalRedacted`, projected findings. **Human approval.** |
| `verifyRedaction({categories?})` | Rescan artifact bytes and coverage | `passed`, `extractableFindings`, `unmaskedRegions`, `originalValuesFound`, per-category counts |
| `exportSanitizedDocument({filename?})` | Download the artifact | Filename and `verified: true`. **Blocked until verify passes. Human approval.** |
| `getVerificationCertificate({})` | Metadata-only proof | Digest, issued time, check counts — no contents |
| `registerCustomPattern({name, pattern, flags?})` | Extra local detector (max 5) | Registered name and count. **Human approval.** Unsafe / empty / slow patterns are rejected first. |
| `listStructuredFields({})` | JSON keys or CSV columns | Field names, occurrence counts, detected-finding counts — no values |
| `redactField({field, maskMode?})` | Whole key or column | Counts and projected findings. **Human approval.** String JSON leaves and CSV cells only, so the artifact stays valid JSON. |

Activity log entries store summarized arguments and the same privacy-safe results the agent received.

Categories: `ssn`, `credit_card`, `email`, `phone`, `api_key`, `private_key`, `bearer_token`, `db_connection_string`, plus `custom:<name>` after a pattern is registered.

Mask modes: `blackout` or `synthetic_replacement`. Synthetic mode substitutes plausible local placeholders. Verification excludes those placeholders from “remaining findings,” counts them separately, and still fails if any original raw value survives.

## Verification (why export is locked)

App state is never treated as proof. Verification re-reads the generated Blob and reports three independent checks:

- **`extractableFindings`** — detectors still fire on the artifact bytes
- **`unmaskedRegions`** — findings still marked pending in the registry
- **`originalValuesFound`** — original raw strings still appear in the artifact

A rasterized PDF has no text layer, so a text rescan alone would pass while a skipped bar is still visible. Any of the three checks failing blocks export. Export also re-checks the SHA-256 digest so a file changed after verification cannot be downloaded as verified.

A passing run can issue a certificate (`RDCT-…`) with the digest, document metadata, and numeric results — never document text or finding values.

## Run locally

No build step. Serve the repository root:

```bash
npx serve .
# or
python -m http.server 4173
```

The production app is [https://redacta-theta.vercel.app/](https://redacta-theta.vercel.app/). Local paths match that host:

| Local | Live |
| --- | --- |
| `/` | [https://redacta-theta.vercel.app/](https://redacta-theta.vercel.app/) |
| `/app.html` | [https://redacta-theta.vercel.app/app.html](https://redacta-theta.vercel.app/app.html) |
| `/app.html?demo=agent` | [https://redacta-theta.vercel.app/app.html?demo=agent](https://redacta-theta.vercel.app/app.html?demo=agent) |
| `/ai.html` | [https://redacta-theta.vercel.app/ai.html](https://redacta-theta.vercel.app/ai.html) |
| `/tools.html` | [https://redacta-theta.vercel.app/tools.html](https://redacta-theta.vercel.app/tools.html) |

Fonts and landing artwork ship in `assets/`, so the pages make no external requests. Vercel (`vercel.json`) and Netlify (`netlify.toml`) publish the repository root as static files.

Open a local PDF, TXT, JSON, or CSV from the empty state, or click **Run agent demo** to load the synthetic contract. On JSON or CSV, the agent demo also lists structured fields and redacts one whole field before it continues.

## Test and vendor

```bash
npm ci
npm run vendor
npm test
```

`vendor/` holds the exact `pdfjs-dist@6.2.108` and `pdf-lib@1.17.1` browser artifacts. Runtime code makes no third-party requests.

## Architecture decisions

- **Plain ES modules, no framework or bundler.** Static hosting keeps the product inspectable and avoids a build-time dependency surface.
- **Vendored PDF engines.** Document bytes never need a CDN.
- **Worker scanning.** Detectors run in a Web Worker and report progress by category.
- **Layered detectors.** Regex candidates, then structural validation (Luhn, SSN ranges, key / token / connection shapes), then confidence scoring.
- **Rasterized PDF export.** Each page is rendered to a canvas, padded whole-item masks are baked into PNGs, and a new image-only PDF is built. That removes the text layer so a black rectangle over live glyphs is not mistaken for a redaction.
- **Manual marking.** Pointer drag on PDFs; text documents also support keyboard selection and Enter to commit.
- **Explicit privacy projection.** The registry stores raw values privately and exposes only the safe-field whitelist to tools, UI activity, and errors.

## License

[ISC](./LICENSE). Copyright © 2026 Manoj Kumar.
