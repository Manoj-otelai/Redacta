import { createFindingRegistry } from "./registry.js";
import { loadTextDocument } from "./textDocument.js";
import { createDemoPdf, loadPdfDocument } from "./pdfDocument.js";
import { installNetworkMonitor } from "./network.js";
import {
  applyRedactions,
  exportSanitizedDocument,
  getFindingDetails,
  inspectDocument,
  scanDocumentPII,
  TOOL_DESCRIPTIONS,
  TOOL_SCHEMAS,
  verifyRedaction,
} from "./tools.js";

const demoText = `CONFIDENTIAL
Employment Agreement

This Agreement is entered into by and between Jordan Lee ("Employee") and Northstar Labs.
Employee identification: 123-45-6789
Contact: jordan.lee@northstar.example - (415) 555-0198
Payroll will be deposited to card ending 4111 1111 1111 1111.
Internal integration token: sk_live_51NORTHSTAR_8df7a.
The parties agree to the terms and conditions set forth below.`;

const toolMap = { inspectDocument, scanDocumentPII, applyRedactions, verifyRedaction, getFindingDetails, exportSanitizedDocument };
const state = { document: null, artifact: null, verification: null, maskMode: "blackout", revision: 0, lastRedactionBatch: [], manualMode: false };
const registry = createFindingRegistry();
const $ = (id) => document.getElementById(id);
const context = {
  state,
  registry,
  get document() { return state.document; },
  callSource: "user",
  onProgress(value) { $("processingBadge").textContent = `SCANNING ${value}%`; },
  onFindingsChanged: render,
  onVerificationChanged: render,
  onStateChanged: render,
  requestConfirmation,
  downloadArtifact(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2600);
}

function safeArgs(args = {}) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => ["categories", "targetIds", "maskMode", "findingId", "filename"].includes(key)));
}

function safeResult(result) {
  if (!result || typeof result !== "object") return { status: "success" };
  const summary = {};
  for (const key of ["status", "totalDetected", "totalRedacted", "verified", "passed", "remainingFindings", "filename", "maskMode"]) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  if (result.categories) summary.categories = result.categories;
  return summary;
}

function addActivity(name, args, result) {
  const item = document.createElement("div");
  item.className = "activity-item";
  item.innerHTML = `<span class="activity-check">✓</span><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(JSON.stringify({ args: safeArgs(args), result: safeResult(result) }))}</p></div>`;
  $("activityLog").append(item);
}

async function executeTool(name, args = {}, source = "user") {
  const previousSource = context.callSource;
  context.callSource = source;
  try {
    const result = await toolMap[name](context, args);
    addActivity(name, args, result);
    return result;
  } catch {
    const result = { status: "error", message: "The local operation failed." };
    addActivity(name, args, result);
    return result;
  } finally {
    context.callSource = previousSource;
  }
}

function requestConfirmation(message) {
  return new Promise((resolve) => {
    const modal = $("permissionModal");
    $("permissionMessage").textContent = message;
    modal.hidden = false;
    let settled = false;
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      modal.hidden = true;
      clearTimeout(timeout);
      resolve(allowed);
    };
    const timeout = setTimeout(() => finish(false), 15000);
    $("permissionAllow").onclick = () => finish(true);
    $("permissionCancel").onclick = () => finish(false);
  });
}

function invalidate() {
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  render();
}

function renderTextPreview() {
  const text = state.document.text;
  const findings = registry.all()
    .filter((finding) => Number.isInteger(finding.charStart) && Number.isInteger(finding.charEnd))
    .sort((left, right) => left.charStart - right.charStart);
  const parts = [];
  let cursor = 0;
  for (const finding of findings) {
    if (finding.charStart < cursor) continue;
    parts.push(escapeHtml(text.slice(cursor, finding.charStart)).replace(/\n/g, "<br />"));
    const value = text.slice(finding.charStart, finding.charEnd);
    const body = finding.status === "redacted" ? "█".repeat(Math.max(4, value.length)) : escapeHtml(value);
    parts.push(`<mark class="${finding.status === "redacted" ? "redacted" : ""}" data-finding="${escapeHtml(finding.type)}">${body}</mark>`);
    cursor = finding.charEnd;
  }
  parts.push(escapeHtml(text.slice(cursor)).replace(/\n/g, "<br />"));
  return parts.join("");
}

function attachManualTextSelection(preview) {
  let start = null;
  preview.onpointerdown = (event) => {
    if (!state.manualMode) return;
    start = event.clientX;
    preview.setPointerCapture?.(event.pointerId);
  };
  preview.onpointerup = (event) => {
    if (!state.manualMode || start === null) return;
    const end = event.clientX;
    const rect = preview.getBoundingClientRect();
    const first = Math.max(0, Math.min(state.document.text.length - 1, Math.round(((Math.min(start, end) - rect.left) / rect.width) * state.document.text.length)));
    const last = Math.max(first + 1, Math.min(state.document.text.length, Math.round(((Math.max(start, end) - rect.left) / rect.width) * state.document.text.length)));
    registry.addManual({ page: 1, location: "manual text selection", charStart: first, charEnd: last, value: state.document.text.slice(first, last) });
    state.manualMode = false;
    invalidate();
  };
}

function renderPreview() {
  const preview = $("documentPreview");
  if (!state.document) return;
  if (state.document.kind === "pdf") {
    preview.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-preview";
    preview.append(canvas);
    renderPdfPreview(canvas).catch(() => toast("Could not render the PDF preview."));
    let start = null;
    canvas.onpointerdown = (event) => { if (state.manualMode) start = [event.offsetX, event.offsetY]; };
    canvas.onpointerup = (event) => {
      if (!state.manualMode || !start) return;
      const scale = page.width / canvas.width;
      registry.addManual({ page: page.pageNumber, location: "manual PDF rectangle", boundingBox: { x: Math.min(start[0], event.offsetX) * scale, y: Math.min(start[1], event.offsetY) * scale, width: Math.abs(event.offsetX - start[0]) * scale, height: Math.abs(event.offsetY - start[1]) * scale } });
      state.manualMode = false;
      invalidate();
    };
    return;
  }
  preview.innerHTML = `<div class="document-topline"><span>CONFIDENTIAL</span><span>LOCAL DOCUMENT / PREVIEW</span></div><h3>${escapeHtml(state.document.name.replace(/\.[^.]+$/, ""))}</h3><p>${renderTextPreview()}</p><div class="document-footer"><span>PRIVACYVAULT · PRIVATE</span><span>LOCAL PREVIEW</span></div>`;
  attachManualTextSelection(preview);
}

async function renderPdfPreview(canvas) {
  let page;
  let width;
  if (state.artifact?.blob) {
    const { getDocument } = await import("../vendor/pdfjs/pdf.mjs");
    const bytes = new Uint8Array(await state.artifact.blob.arrayBuffer());
    const pdf = await getDocument({ data: bytes }).promise;
    page = await pdf.getPage(1);
    width = page.view[2] - page.view[0];
  } else {
    page = state.document.pages[0].page;
    width = state.document.pages[0].width;
  }
  const viewport = page.getViewport({ scale: Math.min(1, 650 / width) });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

function render() {
  const findings = registry.all();
  const verified = Boolean(state.verification?.passed);
  $("processingBadge").textContent = verified ? "VERIFIED" : "READY";
  $("processingBadge").classList.toggle("verified", verified);
  $("findingTotal").textContent = `${findings.length} found`;
  $("networkUploads").textContent = String(state.networkUploads || 0);
  $("bottomUploadCount").textContent = String(state.networkUploads || 0);
  $("verificationMessage").textContent = state.verification && !verified
    ? `⚠ Verification failed — ${state.verification.remainingFindings} findings remain. Export blocked.`
    : "";
  const list = $("findingList");
  list.replaceChildren();
  if (!findings.length) {
    list.innerHTML = '<div class="empty-state">Run a local scan to see<br />privacy-safe findings.</div>';
  } else {
    for (const [index, finding] of findings.entries()) {
      const row = document.createElement("div");
      row.className = `finding${finding.status === "redacted" ? " redacted" : ""}${finding.status === "excluded" ? " excluded" : ""}`;
      row.innerHTML = `<input type="checkbox" data-index="${index}" ${finding.status === "redacted" ? "disabled" : ""} ${finding.status === "excluded" ? "" : "checked"} /><span class="finding-dot"></span><span class="finding-info"><strong>${escapeHtml(finding.type.replaceAll("_", " "))}</strong><small>${finding.id} · ${escapeHtml(finding.location || "local")}</small></span><span class="confidence">${finding.confidence.toFixed(2)}</span><button class="finding-control" data-action="${finding.status === "excluded" ? "include" : "exclude"}" data-id="${finding.id}">${finding.status === "excluded" ? "Include" : "Exclude"}</button>${finding.status === "redacted" ? `<button class="finding-control" data-action="restore" data-id="${finding.id}">Restore</button>` : ""}`;
      list.append(row);
    }
  }
  $("redactButton").disabled = !findings.some((finding) => finding.status !== "redacted" && finding.status !== "excluded");
  $("verifyButton").disabled = !findings.some((finding) => finding.status === "redacted") && !state.artifact;
  $("exportButton").disabled = !verified;
  $("undoButton").disabled = !state.lastRedactionBatch.length;
  renderPreview();
}

async function loadDocument(document) {
  state.document = document;
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  state.lastRedactionBatch = [];
  registry.replace([]);
  $("fileName").textContent = document.name;
  $("fileMeta").textContent = `${document.format.toUpperCase()} · ${document.sizeLabel} · LOCAL`;
  render();
  toast("Document loaded locally · no upload made");
}

async function handleFile(file) {
  if (!file) return;
  const filename = file.name.toLowerCase();
  const isPdf = filename.endsWith(".pdf") || file.type === "application/pdf";
  const isText = /\.(txt|json|csv)$/i.test(filename) || ["text/plain", "application/json", "text/csv"].includes(file.type);
  if (!isPdf && !isText) return toast("Unsupported file type. Use PDF, TXT, JSON, or CSV.");
  try {
    await loadDocument(isPdf ? await loadPdfDocument(file) : await loadTextDocument(file));
  } catch {
    toast("Unreadable or corrupt document. No scan, redaction, or export was performed.");
  }
}

async function runScan() {
  if (!state.document) return toast("Load a document first.");
  const inspected = await executeTool("inspectDocument", {}, "user");
  if (inspected.status !== "success") return toast("Could not inspect this document.");
  const result = await executeTool("scanDocumentPII", {}, "user");
  if (result.status !== "success") toast("Scan failed. No redaction or export was performed.");
  else toast(`${result.totalDetected} findings detected · values withheld`);
}

async function runRedaction() {
  const targetIds = [...document.querySelectorAll(".finding input:checked")].map((input) => registry.all()[Number(input.dataset.index)].id);
  state.lastRedactionBatch = targetIds;
  const result = await executeTool("applyRedactions", { targetIds, maskMode: state.maskMode }, "user");
  if (result.status !== "success") toast(result.status === "denied" ? "Redaction cancelled." : "Redaction failed. No export was performed.");
  else toast(`${result.totalRedacted} findings masked locally`);
}

async function runVerification() {
  const result = await executeTool("verifyRedaction", {}, "user");
  toast(result.passed ? "Verification passed · export unlocked" : "Verification failed · export remains blocked");
}

function registerTools() {
  const execute = (name, input) => executeTool(name, input, "agent");
  if (!document.modelContext?.registerTool) {
    $("nativeStatus").textContent = "Native WebMCP isn't available. Demo Mode is active.";
    $("modeLabel").textContent = "DEMO MODE";
    Object.assign(window, Object.fromEntries(Object.keys(toolMap).map((name) => [name, (input) => execute(name, input)])));
    return;
  }
  for (const [name] of Object.entries(toolMap)) document.modelContext.registerTool({ name, description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name], execute: (input) => execute(name, input) });
  $("modeLabel").textContent = "NATIVE WEBMCP";
}

export function initUI() {
  state.networkUploads = 0;
  installNetworkMonitor((count) => { state.networkUploads = count; render(); });
  $("browseButton").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (event) => handleFile(event.target.files[0]));
  $("dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropZone").classList.add("dragging"); });
  $("dropZone").addEventListener("dragleave", () => $("dropZone").classList.remove("dragging"));
  $("dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("dropZone").classList.remove("dragging"); handleFile(event.dataTransfer.files[0]); });
  $("scanButton").addEventListener("click", runScan);
  $("loadDemoButton").addEventListener("click", () => loadDocument({ kind: "text", format: "txt", name: "confidential-employment-contract.txt", type: "text/plain", size: new TextEncoder().encode(demoText).length, sizeLabel: "0.4KB", pageCount: 1, text: demoText }));
  $("loadDemoPdfButton").addEventListener("click", async () => loadDocument(await loadPdfDocument(await createDemoPdf())));
  $("redactButton").addEventListener("click", runRedaction);
  $("verifyButton").addEventListener("click", runVerification);
  $("exportButton").addEventListener("click", async () => {
    const result = await executeTool("exportSanitizedDocument", { filename: `privacyvault-sanitized.${state.document.format}` }, "user");
    if (result.status === "success") toast("Verified copy downloaded locally");
    else toast("Export blocked until verification passes.");
  });
  $("manualButton").addEventListener("click", () => { state.manualMode = !state.manualMode; toast(state.manualMode ? "Drag over the document to create a manual redaction." : "Manual redaction cancelled."); });
  $("undoButton").addEventListener("click", () => { registry.restore(state.lastRedactionBatch); state.lastRedactionBatch = []; invalidate(); toast("Last redaction batch undone."); });
  $("findingList").addEventListener("click", (event) => {
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const id = control.dataset.id;
    if (control.dataset.action === "exclude" || control.dataset.action === "include" || control.dataset.action === "restore") registry[control.dataset.action === "exclude" ? "exclude" : "restore"]([id]);
    invalidate();
  });
  $("developerToggle").addEventListener("click", () => { $("developerPanel").hidden = !$("developerPanel").hidden; });
  for (const name of Object.keys(toolMap)) $("developerTool").append(new Option(name, name));
  $("developerRun").addEventListener("click", async () => {
    try {
      const args = JSON.parse($("developerArgs").value || "{}");
      const result = await executeTool($("developerTool").value, args, "agent");
      $("developerResult").textContent = JSON.stringify(result, null, 2);
    } catch {
      $("developerResult").textContent = JSON.stringify({ status: "error", message: "Arguments must be valid JSON." }, null, 2);
    }
  });
  registerTools();
  render();
}
