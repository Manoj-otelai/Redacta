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
const state = { document: null, artifact: null, verification: null, maskMode: "blackout", revision: 0, lastRedactionBatch: [], manualMode: false, pdfPage: 1 };
const registry = createFindingRegistry();
const $ = (id) => document.getElementById(id);
let pdfPreviewCache = { key: null, pdf: null };
let pdfRenderGeneration = 0;
let pdfPreviewElements = null;
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

function summarizeArgs(args = {}) {
  const summary = [];
  if (Array.isArray(args.categories)) summary.push(`${args.categories.length} categories`);
  if (Array.isArray(args.targetIds)) summary.push(`${args.targetIds.length} target findings`);
  if (args.maskMode) summary.push(`mask ${args.maskMode}`);
  if (args.findingId) summary.push(`finding ${args.findingId}`);
  if (args.filename) summary.push(`filename ${args.filename}`);
  return summary.join(" · ") || "no arguments";
}

function safeResult(result) {
  if (!result || typeof result !== "object") return { status: "success" };
  const summary = {};
  for (const key of ["status", "totalDetected", "totalRedacted", "verified", "passed", "remainingFindings", "filename", "maskMode", "message"]) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  if (result.categories) summary.categories = result.categories;
  return summary;
}

function addActivity(name, args, result) {
  const item = document.createElement("div");
  item.className = "activity-item";
  const icon = document.createElement("span");
  icon.className = "activity-check";
  icon.textContent = "✓";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  const details = document.createElement("p");
  title.textContent = name;
  details.textContent = `${summarizeArgs(args)} → ${JSON.stringify(safeResult(result))}`;
  body.append(title, details);
  item.append(icon, body);
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
    const timeout = setTimeout(() => finish(false), 60000);
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
    parts.push(`<span data-start="${cursor}" data-end="${finding.charStart}">${escapeHtml(text.slice(cursor, finding.charStart))}</span>`);
    const value = text.slice(finding.charStart, finding.charEnd);
    const body = finding.status === "redacted" ? "█".repeat(Math.max(4, value.length)) : escapeHtml(value);
    parts.push(`<mark class="${finding.status === "redacted" ? "redacted" : ""}" data-finding="${escapeHtml(finding.type)}" data-start="${finding.charStart}" data-end="${finding.charEnd}">${body}</mark>`);
    cursor = finding.charEnd;
  }
  parts.push(`<span data-start="${cursor}" data-end="${text.length}">${escapeHtml(text.slice(cursor))}</span>`);
  return parts.join("");
}

function attachManualTextSelection(preview) {
  preview.onmouseup = () => {
    if (!state.manualMode) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !preview.contains(selection.anchorNode) || !preview.contains(selection.focusNode)) return;
    const start = selectionPointToOffset(preview, selection.anchorNode, selection.anchorOffset);
    const end = selectionPointToOffset(preview, selection.focusNode, selection.focusOffset);
    const first = Math.min(start, end);
    const last = Math.max(start, end);
    if (last <= first) return;
    registry.addManual({ page: 1, location: "manual text selection", charStart: first, charEnd: last, value: state.document.text.slice(first, last) });
    selection.removeAllRanges();
    state.manualMode = false;
    invalidate();
  };
}

function selectionPointToOffset(root, node, offset) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const owner = element?.closest("[data-start]");
  if (owner && root.contains(owner)) {
    const start = Number(owner.dataset.start);
    if (node.nodeType === Node.TEXT_NODE) return Math.min(Number(owner.dataset.end), start + offset);
    const range = document.createRange();
    range.selectNodeContents(owner);
    range.setEnd(node, offset);
    return Math.min(Number(owner.dataset.end), start + range.toString().length);
  }
  return 0;
}

function renderPreview() {
  const preview = $("documentPreview");
  if (!state.document) return;
  if (state.document.kind === "pdf") {
    if (!pdfPreviewElements) {
      const controls = document.createElement("div");
      controls.className = "pdf-controls";
      const previous = document.createElement("button");
      previous.className = "button button-ghost";
      previous.textContent = "Previous";
      previous.type = "button";
      const label = document.createElement("span");
      const next = document.createElement("button");
      next.className = "button button-ghost";
      next.textContent = "Next";
      next.type = "button";
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-preview";
      preview.replaceChildren(controls, canvas);
      controls.append(previous, label, next);
      pdfPreviewElements = { canvas, previous, label, next };
      previous.onclick = () => { state.pdfPage = Math.max(1, state.pdfPage - 1); render(); };
      next.onclick = () => { state.pdfPage = Math.min(state.document.pageCount, state.pdfPage + 1); render(); };
      let start = null;
      canvas.onpointerdown = (event) => { if (state.manualMode) start = [event.offsetX, event.offsetY]; };
      canvas.onpointerup = (event) => {
        if (!state.manualMode || !start) return;
        const page = state.document.pages[state.pdfPage - 1];
        if (!page || !canvas.clientWidth) return;
        const scale = page.width / canvas.clientWidth;
        const left = Math.min(start[0], event.offsetX) * scale;
        const top = Math.min(start[1], event.offsetY) * scale;
        const width = Math.abs(event.offsetX - start[0]) * scale;
        const height = Math.abs(event.offsetY - start[1]) * scale;
        if (width < 1 || height < 1) return;
        registry.addManual({ type: "manual_rectangle", page: page.pageNumber, location: `page ${page.pageNumber}, manual rectangle`, boundingBox: { x: left, y: top, width, height } });
        state.manualMode = false;
        invalidate();
      };
    }
    state.pdfPage = Math.max(1, Math.min(state.document.pageCount, state.pdfPage));
    pdfPreviewElements.label.textContent = `Page ${state.pdfPage} of ${state.document.pageCount}`;
    pdfPreviewElements.previous.disabled = state.pdfPage <= 1;
    pdfPreviewElements.next.disabled = state.pdfPage >= state.document.pageCount;
    renderPdfPreview(pdfPreviewElements.canvas, state.pdfPage).catch(() => toast("Could not render the PDF preview."));
    return;
  }
  preview.innerHTML = `<div class="document-topline"><span>CONFIDENTIAL</span><span>LOCAL DOCUMENT / PREVIEW</span></div><h3>${escapeHtml(state.document.name.replace(/\.[^.]+$/, ""))}</h3><p>${renderTextPreview()}</p><div class="document-footer"><span>PRIVACYVAULT · PRIVATE</span><span>LOCAL PREVIEW</span></div>`;
  preview.querySelector("p")?.classList.add("text-content");
  attachManualTextSelection(preview);
}

async function renderPdfPreview(canvas, pageNumber) {
  const generation = ++pdfRenderGeneration;
  const key = state.artifact?.digest ? `artifact:${state.artifact.digest}` : `source:${state.document}`;
  if (pdfPreviewCache.key !== key) {
    if (state.artifact?.blob) {
      const { getDocument } = await import("../vendor/pdfjs/pdf.mjs");
      const bytes = new Uint8Array(await state.artifact.blob.arrayBuffer());
      pdfPreviewCache = { key, pdf: await getDocument({ data: bytes }).promise };
    } else {
      pdfPreviewCache = { key, pdf: state.document.pdf };
    }
  }
  const page = await pdfPreviewCache.pdf.getPage(pageNumber);
  const width = page.view[2] - page.view[0];
  const viewport = page.getViewport({ scale: Math.min(1, 650 / width) });
  const buffer = document.createElement("canvas");
  buffer.width = viewport.width;
  buffer.height = viewport.height;
  await page.render({ canvasContext: buffer.getContext("2d"), viewport }).promise;
  if (generation !== pdfRenderGeneration) return;
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.getContext("2d").drawImage(buffer, 0, 0);
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
  if (state.verification?.integrityFailure) $("verificationMessage").textContent = "⚠ Verification failed — generated artifact integrity check failed. Export blocked.";
  const list = $("findingList");
  list.replaceChildren();
  if (!findings.length) {
    list.innerHTML = '<div class="empty-state">Run a local scan to see<br />privacy-safe findings.</div>';
  } else {
    for (const [index, finding] of findings.entries()) {
      const row = document.createElement("div");
      row.className = `finding${finding.status === "redacted" ? " redacted" : ""}${finding.status === "excluded" ? " excluded" : ""}`;
      row.dataset.findingId = finding.id;
      row.dataset.page = finding.page || 1;
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
  state.pdfPage = 1;
  pdfPreviewCache = { key: null, pdf: null };
  pdfPreviewElements = null;
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
  const result = await executeTool("applyRedactions", { targetIds, maskMode: state.maskMode }, "user");
  if (result.status !== "success") toast(result.status === "denied" ? "Redaction cancelled." : "Redaction failed. No export was performed.");
  else {
    state.lastRedactionBatch = targetIds;
    toast(`${result.totalRedacted} findings masked locally`);
  }
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
  $("loadDemoButton").addEventListener("click", async () => loadDocument(await loadTextDocument(new File([demoText], "confidential-employment-contract.txt", { type: "text/plain" }))));
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
    if (!control) {
      const row = event.target.closest(".finding");
      if (row) {
        state.pdfPage = Number(row.dataset.page) || 1;
        renderPreview();
      }
      return;
    }
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
