# PrivacyVault — Build Plan

Target: working MVP that satisfies every item in the PRD "Definition of Done", demoable in under 3 minutes.

## Architecture decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Framework | **No framework / no bundler.** Plain ES modules + vanilla DOM, served as static files. | Deviates from the PRD's "recommended" React+Vite+Tailwind. The whole app is one workspace screen driven by a state object; a bundler adds a build gate and dependency surface for no product benefit, and `document.modelContext` registration is framework-irrelevant. Static hosting stays a straight file copy. |
| PDF engine | `pdfjs-dist@6.2.108` for parse/extract/render, `pdf-lib@1.17.1` for artifact generation, **vendored into `vendor/`** and committed. | App must run from static hosting with no CDN dependency, so nothing about a document can leak through a third-party asset request. |
| Scanning | Web Worker (`scan.worker.js`), progress-reported. | Keeps the UI responsive on large documents per PRD §27. |
| PDF redaction | Export **rasterizes** each page (mask rectangles baked into the canvas) and rebuilds a PDF from those images. | PRD §17: a black rectangle over live text is not redaction. Rasterizing removes the text layer entirely, so extraction on the export finds nothing. |
| Verification | Rescans the **generated artifact bytes**, not app state. | PRD §11/§29: verification must test the output. PDF artifacts are re-parsed with pdf.js text extraction; text artifacts are decoded from the Blob. |
| Export gating | `exportSanitizedDocument` refuses to download unless the last verification of the current artifact passed. | PRD §13/§28. |
| Demo document | Generated at runtime with pdf-lib (7 SSNs, 3 cards, 5 emails, 2 API keys). | Real PDF code path in the demo, no binary asset in the repo. |

## Privacy boundary (enforced, not just claimed)

- Tool results are built from a whitelist projection of the finding registry: `{id, type, page, location, boundingBox, confidence, status}`. Raw values live only in the private registry and never enter a tool return, the activity log, or a thrown error message.
- A network monitor wraps `fetch`/`XMLHttpRequest`/`sendBeacon` at startup and counts outbound requests, which is what the dashboard's "network uploads" number reads from — the counter is measured, not hardcoded to 0.

## Phases

1. **Foundation** — `package.json`, vendored deps, split the current single-file prototype into ES modules, detector + validator layer (regex → validation → confidence), unit tests via `node:test`.
2. **Documents** — PDF text extraction with per-item geometry, page rendering to canvas, TXT/JSON/CSV loading, worker-based scan with progress UI, unsupported-type errors.
3. **Redaction** — bbox masking for PDF, offset masking for text, `blackout` and `synthetic_replacement` modes, artifact generation (rasterized PDF / masked text).
4. **Verification** — rescan artifact bytes, per-category counts, export gate, explicit failure state that blocks export.
5. **WebMCP** — the six tools on `document.modelContext.registerTool`, human-confirmation prompts for mutating tools, live agent activity log, developer panel + demo-mode fallback.
6. **Human-in-the-loop UI** — finding include/exclude, restore, undo, manual rectangle redaction, privacy dashboard, error states.
7. **Polish** — demo document generator, static deploy config, README, lint/test/build checks.

## Definition of done mapping

Every PRD §40 checkbox is covered by phases 2–6; the two that need explicit proof during review are "sensitive values are never returned to the agent" (whitelist projection + a unit test asserting no tool payload contains a known planted value) and "verification rescans the sanitized artifact" (verification reads the export Blob).
