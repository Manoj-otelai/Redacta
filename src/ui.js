import { createFindingRegistry } from "./registry.js";
import { loadTextDocument } from "./textDocument.js";
import { createDemoPdf, loadPdfDocument } from "./pdfDocument.js";
import {
  applyRedactions,
  buildArtifact,
  exportSanitizedDocument,
  getFindingDetails,
  inspectDocument,
  scanDocumentPII,
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

const state = { document: null, artifact: null, verification: null, maskMode: "blackout" };
const registry = createFindingRegistry();
const $ = (id) => document.getElementById(id);
const context = {
  state,
  registry,
  get document() { return state.document; },
  onProgress(value) { $("processingBadge").textContent = `SCANNING ${value}%`; },
  onFindingsChanged: render,
  onVerificationChanged: renderVerification,
  downloadArtifact(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function addActivity(name, detail, muted = false) {
  const item = document.createElement("div");
  item.className = `activity-item${muted ? " muted" : ""}`;
  item.innerHTML = `<span class="activity-check">${muted ? "·" : "✓"}</span><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(detail)}</p></div>`;
  const log = $("activityLog");
  if (muted) log.replaceChildren(item); else log.append(item);
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2600);
}

function renderPreview() {
  const preview = $("documentPreview");
  if (!state.document) return;
  if (state.document.kind === "pdf") {
    preview.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-preview";
    preview.append(canvas);
    const page = state.document.pages[0];
    const viewport = page.page.getViewport({ scale: Math.min(1, 650 / page.width) });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    page.page.render({ canvasContext: canvas.getContext("2d"), viewport });
    return;
  }
  let html = escapeHtml(state.document.text).replace(/\n/g, "<br />");
  for (const finding of registry.all().sort((left, right) => right.charStart - left.charStart)) {
    const value = escapeHtml(state.document.text.slice(finding.charStart, finding.charEnd));
    const replacement = finding.status === "redacted"
      ? `<mark class="redacted">${"█".repeat(Math.max(4, value.length))}</mark>`
      : `<mark data-finding="${finding.type}">${value}</mark>`;
    html = `${html.slice(0, html.lastIndexOf(value))}${replacement}${html.slice(html.lastIndexOf(value) + value.length)}`;
  }
  preview.innerHTML = `<div class="document-topline"><span>CONFIDENTIAL</span><span>LOCAL DOCUMENT / PREVIEW</span></div><h3>${escapeHtml(state.document.name.replace(/\.[^.]+$/, ""))}</h3><p>${html}</p><div class="document-footer"><span>PRIVACYVAULT · PRIVATE</span><span>LOCAL PREVIEW</span></div>`;
}

function render() {
  const findings = registry.all();
  const verified = Boolean(state.verification?.passed);
  $("processingBadge").textContent = verified ? "VERIFIED" : "READY";
  $("processingBadge").classList.toggle("verified", verified);
  $("findingTotal").textContent = `${findings.length} found`;
  const list = $("findingList");
  list.replaceChildren();
  if (!findings.length) {
    list.innerHTML = '<div class="empty-state">Run a local scan to see<br />privacy-safe findings.</div>';
  } else {
    for (const [index, finding] of findings.entries()) {
      const row = document.createElement("label");
      row.className = `finding${finding.status === "redacted" ? " redacted" : ""}`;
      row.innerHTML = `<input type="checkbox" data-index="${index}" ${finding.status === "redacted" ? "disabled" : "checked"} /><span class="finding-dot"></span><span class="finding-info"><strong>${escapeHtml(finding.type.replaceAll("_", " "))}</strong><small>${finding.id} · ${escapeHtml(finding.location || "local")}</small></span><span class="confidence">${finding.confidence.toFixed(2)}</span>`;
      list.append(row);
    }
  }
  $("redactButton").disabled = !findings.some((finding) => finding.status !== "redacted" && finding.status !== "excluded");
  $("verifyButton").disabled = !findings.some((finding) => finding.status === "redacted");
  $("exportButton").disabled = !state.verification?.passed;
  renderPreview();
}

function renderVerification(result = state.verification) {
  const passed = Boolean(result?.passed);
  $("verifiedStat").textContent = passed ? "✓" : "—";
  $("processingBadge").textContent = passed ? "VERIFIED" : "READY";
  $("processingBadge").classList.toggle("verified", passed);
  render();
}

async function loadDocument(document) {
  state.document = document;
  state.artifact = null;
  state.verification = null;
  registry.replace([]);
  $("fileName").textContent = document.name;
  $("fileMeta").textContent = `${document.kind.toUpperCase()} · ${(document.size / 1024).toFixed(1)} KB · LOCAL`;
  addActivity("Document loaded", `${document.name} · local memory`);
  render();
  toast("Document loaded locally · no upload made");
}

async function handleFile(file) {
  if (!file) return;
  try {
    const filename = file.name.toLowerCase();
    const isPdf = filename.endsWith(".pdf") || file.type === "application/pdf";
    const isText = /\.(txt|json|csv)$/i.test(filename)
      || ["text/plain", "application/json", "text/csv"].includes(file.type);
    if (!isPdf && !isText) throw new Error("Unsupported document type.");
    await loadDocument(isPdf ? await loadPdfDocument(file) : await loadTextDocument(file));
  } catch {
    toast("Unsupported or unreadable document.");
  }
}

async function runScan() {
  if (!state.document) return toast("Load a document first.");
  addActivity("inspectDocument", "Metadata only · contents withheld");
  await inspectDocument(context);
  const result = await scanDocumentPII(context);
  addActivity("scanDocumentPII", `${result.totalDetected} privacy-safe findings`);
  toast(`${result.totalDetected} findings detected · values withheld`);
}

async function runRedaction() {
  try {
    const targetIds = [...document.querySelectorAll(".finding input:checked")].map((input) => registry.all()[Number(input.dataset.index)].id);
    const result = await applyRedactions(context, { targetIds, maskMode: state.maskMode });
    await buildArtifact(context, { maskMode: state.maskMode });
    addActivity("applyRedactions", `${result.totalRedacted} local redactions`);
    toast(`${result.totalRedacted} findings masked locally`);
  } catch (error) {
    window.__lastError = error.stack || String(error);
    toast("Could not generate the sanitized artifact.");
  }
}

async function runVerification() {
  try {
    const result = await verifyRedaction(context);
    addActivity("verifyRedaction", result.passed ? "0 findings remaining · passed" : `${result.remainingFindings.length} findings remain · blocked`);
    toast(result.passed ? "Verification passed · export unlocked" : "Verification failed · export remains blocked");
  } catch (error) {
    window.__lastError = error.stack || String(error);
    toast("Verification could not read the generated artifact.");
  }
}

function registerWebMCP() {
  const tools = { inspectDocument, scanDocumentPII, applyRedactions, verifyRedaction, getFindingDetails, exportSanitizedDocument };
  if (!document.modelContext?.registerTool) {
    $("nativeStatus").innerHTML = '<span class="status-dot" style="background:#e6a54f"></span> Demo mode';
    $("modeLabel").textContent = "DEMO MODE";
    Object.assign(window, Object.fromEntries(Object.entries(tools).map(([name, execute]) => [name, (input) => execute(context, input)])));
    return;
  }
  for (const [name, execute] of Object.entries(tools)) {
    document.modelContext.registerTool({
      name,
      description: `Privacy-safe local ${name} operation. Never returns document contents or sensitive values.`,
      inputSchema: { type: "object", additionalProperties: true },
      execute: (input) => execute(context, input),
    });
  }
  $("modeLabel").textContent = "NATIVE WEBMCP";
}

export function initUI() {
  $("browseButton").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (event) => handleFile(event.target.files[0]));
  $("dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropZone").classList.add("dragging"); });
  $("dropZone").addEventListener("dragleave", () => $("dropZone").classList.remove("dragging"));
  $("dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("dropZone").classList.remove("dragging"); handleFile(event.dataTransfer.files[0]); });
  $("scanButton").addEventListener("click", runScan);
  $("loadDemoButton").addEventListener("click", () => loadDocument({ kind: "text", name: "confidential-employment-contract.txt", type: "text/plain", size: new TextEncoder().encode(demoText).length, pageCount: 1, text: demoText }));
  $("loadDemoPdfButton").addEventListener("click", async () => loadDocument(await loadPdfDocument(await createDemoPdf())));
  $("redactButton").addEventListener("click", runRedaction);
  $("verifyButton").addEventListener("click", runVerification);
  $("exportButton").addEventListener("click", async () => {
    const result = await exportSanitizedDocument(context, { filename: `privacyvault-sanitized.${state.document.kind === "pdf" ? "pdf" : "txt"}` });
    if (result.status === "success") { addActivity("exportSanitizedDocument", `${result.filename} · local download`); toast("Verified copy downloaded locally"); }
  });
  registerWebMCP();
  render();
}
