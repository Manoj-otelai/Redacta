# PrivacyVault

PrivacyVault is a static, browser-local document privacy workspace for the WebMCP Challenge. It demonstrates how an AI agent can inspect, scan, redact, verify, and export a document through privacy-safe tools without receiving the document contents.

## Run locally

Open `index.html` in Chrome, or serve the directory with any static file server:

```powershell
python -m http.server 4173
```

The app starts with a synthetic demo document. It supports local TXT, JSON, and CSV scanning plus a PDF metadata/demo path. When native `document.modelContext.registerTool()` is unavailable, the same tool functions are exposed in demo mode and the UI controls reproduce the agent workflow.

## Privacy boundary

The scanner keeps raw values in browser memory only. WebMCP responses contain finding IDs, categories, locations, confidence, and verification metadata; they never include detected values or document contents. Export is blocked until verification passes.