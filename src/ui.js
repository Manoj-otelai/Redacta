import { createFindingRegistry } from "./registry.js";
import { loadTextDocument } from "./textDocument.js";
import { createDemoPdf, loadPdfDocument } from "./pdfDocument.js";
import { syntheticReplacement } from "./detectors.js";
import { installNetworkMonitor } from "./network.js";
import {
  applyRedactions,
  buildArtifact,
  exportSanitizedDocument,
  getVerificationCertificate,
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

const loadDemoText = async () => loadDocument(await loadTextDocument(new File([demoText], "confidential-employment-contract.txt", { type: "text/plain" })));
const loadDemoPdf = async () => loadDocument(await loadPdfDocument(await createDemoPdf()));
const toolMap = { inspectDocument, scanDocumentPII, applyRedactions, verifyRedaction, getFindingDetails, exportSanitizedDocument, getVerificationCertificate };
const state = { document: null, artifact: null, verification: null, maskMode: "blackout", revision: 0, lastRedactionBatch: [], manualMode: false, pdfPage: 1, zoom: 1 };
const registry = createFindingRegistry();
const audit = { calls: 0, leaks: 0 };
const AGENT_STEPS = [
  { key: "inspectDocument", label: "Inspect document" },
  { key: "scanDocumentPII", label: "Scan for sensitive data" },
  { key: "applyRedactions", label: "Apply redactions" },
  { key: "verifyRedaction", label: "Verify sanitized copy" },
  { key: "exportSanitizedDocument", label: "Export verified copy" },
];
const agentRun = { active: false, statuses: new Map(), notes: new Map() };
const $ = (id) => document.getElementById(id);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
const TYPE_LABELS = {
  ssn: "SSN",
  credit_card: "Credit card",
  email: "Email address",
  phone: "Phone number",
  api_key: "API key",
  private_key: "Private key",
  bearer_token: "Bearer token",
  db_connection_string: "Database URI",
  manual_rectangle: "Manual region",
  manual: "Manual selection",
};
let pdfPreviewCache = { key: null, pdf: null };
let pdfRenderGeneration = 0;
let thumbGeneration = 0;
let thumbKey = null;
let pdfCanvas = null;
let previewRefreshBusy = false;
const context = {
  state,
  registry,
  get document() { return state.document; },
  callSource: "user",
  onProgress(value) {
    $("processingBadge").textContent = `SCANNING ${value}%`;
    setScanProgress(value);
  },
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
  for (const key of ["status", "totalDetected", "totalRedacted", "verified", "passed", "remainingFindings", "filename", "maskMode", "message", "certificateId"]) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  if (result.categories) summary.categories = result.categories;
  return summary;
}

function renderAudit() {
  const card = $("payloadAudit");
  if (!card) return;
  card.className = "audit-card";
  const clean = audit.calls > 0 && !audit.leaks;
  const leaking = audit.leaks > 0;
  if (clean) card.classList.add("is-clean");
  if (leaking) card.classList.add("is-leak");
  $("auditMark").textContent = leaking ? "!" : "✓";
  $("auditHeadline").textContent = audit.calls === 0
    ? "No payloads sent yet"
    : leaking
      ? `${plural(audit.leaks, "payload")} contained a sensitive value`
      : `${plural(audit.calls, "payload")} returned · 0 sensitive values`;
  $("auditDetail").textContent = audit.calls === 0
    ? "Each result is scanned for the values it must never contain."
    : leaking
      ? "A tool result leaked a detected value — that is a bug, not a demo state."
      : "Every WebMCP result was rescanned locally against the detected values. None appear.";
}

function auditPayload(result) {
  const serialized = JSON.stringify(result ?? {}, null, 2);
  const leaked = registry.all()
    .map((finding) => finding.value)
    .filter((value) => typeof value === "string" && value.trim().length >= 4)
    .some((value) => serialized.includes(value));
  audit.calls += 1;
  if (leaked) audit.leaks += 1;
  renderAudit();
  return { serialized, leaked };
}

function summarizeResult(name, result) {
  const safe = safeResult(result);
  if (safe.status && !["success", "verified", "failed"].includes(safe.status)) {
    return safe.message ? `${safe.status} — ${safe.message}` : safe.status;
  }
  switch (name) {
    case "inspectDocument":
      return [result.fileType, plural(result.pageCount ?? 1, "page"), result.documentSize].filter(Boolean).join(" · ");
    case "scanDocumentPII":
      return `${plural(safe.totalDetected ?? 0, "finding")} detected`;
    case "applyRedactions":
      return `${plural(safe.totalRedacted ?? 0, "region")} masked · ${safe.maskMode}`;
    case "verifyRedaction":
      return safe.passed
        ? `passed · 0 remaining across ${Object.keys(safe.categories ?? {}).length} categories`
        : `failed · ${plural(safe.remainingFindings ?? 0, "finding")} remaining`;
    case "getFindingDetails":
      return [result.type, result.location].filter(Boolean).join(" · ") || "finding not found";
    case "exportSanitizedDocument":
      return `${safe.filename} · verified`;
    case "getVerificationCertificate":
      return result.certificate?.certificateId ? `certificate ${result.certificate.certificateId}` : safe.status;
    default:
      return safe.status ?? "success";
  }
}

function addActivity(name, args, result) {
  $("activityLog").querySelector(".activity-item.muted")?.remove();
  const item = document.createElement("div");
  item.className = "activity-item";
  const icon = document.createElement("span");
  icon.className = "activity-check";
  icon.textContent = "✓";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  const details = document.createElement("p");
  title.textContent = name;
  details.textContent = `${summarizeArgs(args)} → ${summarizeResult(name, result)}`;
  const { serialized, leaked } = auditPayload(result);
  const payload = document.createElement("details");
  payload.className = "activity-payload";
  if (leaked) payload.classList.add("is-leak");
  const payloadSummary = document.createElement("summary");
  payloadSummary.textContent = leaked ? "Payload · sensitive value detected" : "What the agent received";
  const payloadBody = document.createElement("pre");
  payloadBody.textContent = serialized.length > 1400 ? `${serialized.slice(0, 1400)}\n…` : serialized;
  payload.append(payloadSummary, payloadBody);
  body.append(title, details, payload);
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

async function refreshPreviewArtifact() {
  if (previewRefreshBusy) return;
  previewRefreshBusy = true;
  try {
    let revision = state.revision;
    while (true) {
      await buildArtifact(context, { maskMode: state.maskMode });
      if (state.revision === revision) break;
      revision = state.revision;
      if (!registry.all().some((finding) => finding.status === "redacted")) {
        state.artifact = null;
        break;
      }
    }
    render();
  } catch {
    state.artifact = null;
    toast("Could not refresh the redaction preview.");
  } finally {
    previewRefreshBusy = false;
  }
}

function invalidate() {
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  render();
  if (registry.all().some((finding) => finding.status === "redacted")) void refreshPreviewArtifact();
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
    const body = finding.status === "redacted"
      ? state.maskMode === "synthetic_replacement"
        ? escapeHtml(syntheticReplacement(finding.type, value))
        : "█".repeat(Math.max(4, value.length))
      : escapeHtml(value);
    parts.push(`<mark class="${finding.status === "redacted" ? (state.maskMode === "synthetic_replacement" ? "redacted synthetic" : "redacted") : ""}" data-finding="${escapeHtml(finding.type)}" data-start="${finding.charStart}" data-end="${finding.charEnd}">${body}</mark>`);
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

function setScanProgress(value) {
  const wrap = $("scanProgress");
  wrap.hidden = value === null;
  if (value === null) return;
  $("scanBar").style.width = `${value}%`;
  $("scanPercent").textContent = `${value}%`;
  $("scanTrack").setAttribute("aria-valuenow", String(value));
}

function clearLocator() {
  for (const box of $("documentPreview").querySelectorAll(".locate-box")) box.remove();
  for (const mark of $("documentPreview").querySelectorAll("mark.is-located")) mark.classList.remove("is-located");
}

function locateFinding(findingId) {
  clearLocator();
  const finding = registry.all().find((item) => item.id === findingId);
  if (!finding || !state.document) return;
  if (state.document.kind !== "pdf") {
    $("documentPreview").querySelector(`mark[data-start="${finding.charStart}"]`)?.classList.add("is-located");
    return;
  }
  const page = state.document.pages[state.pdfPage - 1];
  const overlay = $("documentPreview").querySelector(".pdf-overlay");
  if (!overlay || !page || !finding.boundingBox || finding.page !== state.pdfPage) return;
  const box = document.createElement("span");
  box.className = "locate-box";
  box.style.left = `${(finding.boundingBox.x / page.width) * 100}%`;
  box.style.top = `${(finding.boundingBox.y / page.height) * 100}%`;
  box.style.width = `${(finding.boundingBox.width / page.width) * 100}%`;
  box.style.height = `${(finding.boundingBox.height / page.height) * 100}%`;
  overlay.append(box);
}

function createPdfCanvas(preview) {
  const frame = document.createElement("div");
  frame.className = "pdf-frame";
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-preview";
  const overlay = document.createElement("div");
  overlay.className = "pdf-overlay";
  frame.append(canvas, overlay);
  preview.replaceChildren(frame);
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
    start = null;
    if (width < 1 || height < 1) return;
    registry.addManual({ type: "manual_rectangle", page: page.pageNumber, location: `page ${page.pageNumber}, manual rectangle`, boundingBox: { x: left, y: top, width, height } });
    setManualMode(false);
    invalidate();
  };
  return canvas;
}

function renderPreview() {
  const preview = $("documentPreview");
  if (!state.document) return;
  if (state.document.kind === "pdf") {
    if (!pdfCanvas || !preview.contains(pdfCanvas)) pdfCanvas = createPdfCanvas(preview);
    renderPdfPreview(pdfCanvas, state.pdfPage).catch(() => toast("Could not render the PDF preview."));
    return;
  }
  preview.innerHTML = `<div class="text-page"><div class="document-topline"><span>Confidential</span><span>Local document / preview</span></div><h3>${escapeHtml(state.document.name.replace(/\.[^.]+$/, ""))}</h3><p class="text-content">${renderTextPreview()}</p><div class="document-footer"><span>Redacta · private</span><span>Page 1 of 1</span></div></div>`;
  pdfCanvas = null;
  attachManualTextSelection(preview.firstElementChild);
}

function renderViewerChrome() {
  const pageCount = state.document?.kind === "pdf" ? state.document.pageCount : 1;
  $("pageCount").textContent = String(state.document ? pageCount : 1);
  $("pageInput").value = String(state.document ? state.pdfPage : 1);
  $("pageInput").disabled = pageCount <= 1;
  $("pagePrev").disabled = !state.document || state.pdfPage <= 1;
  $("pageNext").disabled = !state.document || state.pdfPage >= pageCount;
  $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
  $("zoomIn").disabled = state.zoom >= ZOOM_STEPS.at(-1);
  $("zoomOut").disabled = state.zoom <= ZOOM_STEPS[0];
  $("zoomFit").disabled = state.document?.kind !== "pdf";
  $("documentPreview").style.setProperty("--doc-zoom", state.zoom);
  $("documentPreview").classList.toggle("is-marking", state.manualMode);
  $("manualButton").classList.toggle("is-active", state.manualMode);
  $("manualButton").setAttribute("aria-pressed", String(state.manualMode));
  $("dropZone").hidden = Boolean(state.document);
}

function renderThumbnails() {
  const list = $("thumbList");
  if (!state.document) {
    list.replaceChildren(Object.assign(document.createElement("p"), { className: "thumb-empty", textContent: "No pages yet" }));
    $("thumbCount").textContent = "";
    thumbKey = null;
    return;
  }
  const pageCount = state.document.kind === "pdf" ? state.document.pageCount : 1;
  $("thumbCount").textContent = String(pageCount);
  const key = `${state.document.name}:${state.artifact?.digest ?? "source"}:${pageCount}`;
  if (thumbKey !== key) {
    thumbKey = key;
    const generation = ++thumbGeneration;
    list.replaceChildren();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "thumb";
      thumb.dataset.page = String(pageNumber);
      const label = document.createElement("span");
      label.textContent = String(pageNumber);
      if (state.document.kind === "pdf") {
        const canvas = document.createElement("canvas");
        thumb.append(canvas, label);
        renderThumbnail(canvas, pageNumber, generation).catch(() => {});
      } else {
        const face = document.createElement("span");
        face.className = "thumb-face";
        face.textContent = "¶";
        thumb.append(face, label);
      }
      list.append(thumb);
    }
  }
  for (const thumb of list.querySelectorAll(".thumb")) thumb.classList.toggle("is-active", Number(thumb.dataset.page) === state.pdfPage);
}

async function renderThumbnail(canvas, pageNumber, generation) {
  const pdf = await loadPreviewPdf();
  if (generation !== thumbGeneration) return;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 140 / (page.view[2] - page.view[0]) });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

async function loadPreviewPdf() {
  const key = state.artifact?.digest ? `artifact:${state.artifact.digest}` : `source:${state.document.name}:${state.revision}`;
  if (pdfPreviewCache.key === key) return pdfPreviewCache.pdf;
  if (state.artifact?.blob) {
    const { getDocument } = await import("../vendor/pdfjs/pdf.mjs");
    const bytes = new Uint8Array(await state.artifact.blob.arrayBuffer());
    pdfPreviewCache = { key, pdf: await getDocument({ data: bytes }).promise };
  } else {
    pdfPreviewCache = { key, pdf: state.document.pdf };
  }
  return pdfPreviewCache.pdf;
}

async function renderPdfPreview(canvas, pageNumber) {
  const generation = ++pdfRenderGeneration;
  const pdf = await loadPreviewPdf();
  const page = await pdf.getPage(pageNumber);
  const width = page.view[2] - page.view[0];
  const viewport = page.getViewport({ scale: Math.min(1, 720 / width) * state.zoom });
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
  $("processingBadge").textContent = verified ? "VERIFIED" : state.document ? "READY" : "NO DOCUMENT";
  $("processingBadge").classList.toggle("verified", verified);
  $("findingTotal").textContent = `${findings.length} found`;
  $("networkUploads").textContent = String(state.networkUploads || 0);
  $("bottomUploadCount").textContent = String(state.networkUploads || 0);
  $("statusFindings").textContent = String(findings.length);
  $("statusExport").textContent = verified ? "unlocked" : "blocked";
  $("verifiedStat").textContent = verified ? "VERIFIED" : "—";
  $("verificationMessage").textContent = state.verification && !verified
    ? state.verification.originalValuesFound > 0
      ? `⚠ Verification failed — ${plural(state.verification.originalValuesFound, "original value")} found in the generated artifact. Export blocked.`
      : `⚠ Verification failed — ${plural(state.verification.remainingFindings, "sensitive value")} still present (${state.verification.extractableFindings ?? 0} extractable as text, ${state.verification.unmaskedRegions ?? 0} unmasked). Export blocked.`
    : "";
  if (state.verification?.integrityFailure) $("verificationMessage").textContent = "⚠ Verification failed — generated artifact integrity check failed. Export blocked.";
  const list = $("findingList");
  list.replaceChildren();
  if (!findings.length) {
    list.innerHTML = '<div class="empty-state">Run a local scan to see<br />privacy-safe findings.</div>';
  } else {
    for (const finding of findings) {
      const row = document.createElement("div");
      row.className = `finding${finding.status === "redacted" ? " redacted" : ""}${finding.status === "excluded" ? " excluded" : ""}`;
      row.dataset.findingId = finding.id;
      row.dataset.page = finding.page || 1;
      row.innerHTML = `<input type="checkbox" data-id="${finding.id}" aria-label="Include ${finding.id} in the next redaction" ${finding.status === "redacted" ? "disabled" : ""} ${finding.status === "excluded" ? "" : "checked"} /><span class="finding-dot"></span><span class="finding-info"><strong>${escapeHtml(TYPE_LABELS[finding.type] ?? finding.type.replaceAll("_", " "))}</strong><small>${finding.id} · ${escapeHtml(finding.location || "local")}</small></span><span class="confidence">${finding.confidence.toFixed(2)}</span><span class="finding-actions">${finding.status === "pending" ? "" : `<span class="finding-tag">${finding.status}</span>`}${finding.status === "redacted" ? `<button class="finding-control" data-action="restore" data-id="${finding.id}">Restore</button>` : ""}</span>`;
      list.append(row);
    }
  }
  renderCategorySummary(findings);
  renderVerificationSummary();
  renderCertificateCard();
  const pending = findings.filter((finding) => finding.status === "pending");
  const selectable = findings.filter((finding) => finding.status !== "redacted");
  $("listToolbar").hidden = !findings.length;
  $("selectionCount").textContent = `${pending.length} selected of ${findings.length}`;
  $("selectAll").disabled = pending.length === selectable.length;
  $("selectNone").disabled = !pending.length;
  $("maskModeSelect").value = state.maskMode;
  $("redactButton").disabled = !pending.length;
  $("verifyButton").disabled = !findings.some((finding) => finding.status === "redacted") && !state.artifact;
  $("exportButton").disabled = !verified;
  $("undoButton").disabled = !state.lastRedactionBatch.length;
  renderViewerChrome();
  renderThumbnails();
  renderPreview();
}

function renderCategorySummary(findings) {
  const summary = $("categorySummary");
  summary.hidden = !findings.length;
  const counts = new Map();
  for (const finding of findings) counts.set(finding.type, (counts.get(finding.type) ?? 0) + 1);
  summary.replaceChildren(...[...counts].map(([type, count]) => {
    const chip = document.createElement("span");
    chip.className = "category-chip";
    chip.append(TYPE_LABELS[type] ?? type.replaceAll("_", " "), Object.assign(document.createElement("strong"), { textContent: String(count) }));
    return chip;
  }));
}

function renderVerificationSummary() {
  const summary = $("verificationSummary");
  const passed = Boolean(state.verification?.passed);
  summary.hidden = !passed;
  if (!passed) return;
  const categories = Object.keys(state.verification.categories ?? {}).length;
  const certificate = state.verification.certificate;
  const certified = document.createElement("p");
  certified.className = "certificate-summary";
  certified.textContent = certificate
    ? `Certified ${certificate.certificateId} · ${certificate.artifactDigest.slice(0, 12)}…`
    : "Verified artifact certificate unavailable.";
  summary.replaceChildren(
    Object.assign(document.createElement("strong"), { textContent: "Verification passed" }),
    Object.assign(document.createElement("p"), { textContent: `Rescanned the generated artifact across ${categories} categories — nothing sensitive is extractable as text, and every detected finding is masked.` }),
    certified,
  );
}

function renderCertificateCard() {
  const card = $("certificateCard");
  if (!card) return;
  const certificate = state.verification?.passed ? state.verification.certificate : null;
  card.hidden = !certificate;
  if (!certificate) return;
  $("certificateId").textContent = certificate.certificateId;
  $("certificateDigest").textContent = certificate.artifactDigest;
  $("certificateIssuedAt").textContent = new Date(certificate.issuedAt).toLocaleString();
  $("certificateMaskMode").textContent = certificate.maskMode;
  $("certificateArtifactCheck").textContent = `Artifact rescan · ${certificate.extractableFindings} extractable`;
  $("certificateCoverageCheck").textContent = `Mask coverage · ${certificate.unmaskedRegions} unmasked`;
  $("certificateOriginalsCheck").textContent = `Original values · ${certificate.originalValuesFound} found`;
}

async function copyCertificateDigest() {
  const digest = state.verification?.certificate?.artifactDigest;
  if (!digest) return;
  try {
    await navigator.clipboard.writeText(digest);
    toast("Certificate digest copied.");
  } catch {
    toast("Copying is blocked here · select the digest instead.");
  }
}

function downloadCertificate() {
  const certificate = state.verification?.certificate;
  if (!certificate) return;
  context.downloadArtifact(
    new Blob([JSON.stringify(certificate, null, 2)], { type: "application/json" }),
    `redacta-certificate-${certificate.certificateId}.json`,
  );
  toast("Certificate downloaded locally.");
}

function setManualMode(enabled) {
  state.manualMode = enabled;
  renderViewerChrome();
}

function goToPage(pageNumber) {
  const pageCount = state.document?.kind === "pdf" ? state.document.pageCount : 1;
  state.pdfPage = Math.max(1, Math.min(pageCount, pageNumber || 1));
  renderViewerChrome();
  renderThumbnails();
  renderPreview();
}

function fitToWidth() {
  const page = state.document?.kind === "pdf" ? state.document.pages[state.pdfPage - 1] : null;
  if (!page) return;
  const stage = document.querySelector(".viewer-stage");
  const available = stage.clientWidth - 52;
  const baseScale = Math.min(1, 720 / page.width);
  const zoom = available / (page.width * baseScale);
  state.zoom = Math.round(Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS.at(-1), zoom)) * 100) / 100;
  renderViewerChrome();
  renderPreview();
}

function stepZoom(direction) {
  const index = ZOOM_STEPS.findIndex((step) => step >= state.zoom - 0.001);
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? ZOOM_STEPS.length - 1 : index) + direction))];
  if (next === state.zoom) return;
  state.zoom = next;
  renderViewerChrome();
  renderPreview();
}

function activatePane(name) {
  for (const button of document.querySelectorAll(".rail-button")) {
    const active = button.dataset.pane === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const panel of document.querySelectorAll(".task-panel")) panel.classList.toggle("is-active", panel.id === `panel-${name}`);
}

function renderAgentSteps() {
  const list = $("agentSteps");
  if (!list) return;
  list.replaceChildren(...AGENT_STEPS.map((step) => {
    const status = agentRun.statuses.get(step.key) ?? "pending";
    const item = document.createElement("li");
    item.className = `agent-step is-${status}`;
    item.dataset.key = step.key;
    const mark = document.createElement("span");
    mark.className = "step-mark";
    mark.textContent = status === "done" ? "✓" : status === "failed" ? "!" : status === "running" ? "●" : "○";
    const label = document.createElement("span");
    label.className = "step-label";
    label.textContent = step.label;
    const note = document.createElement("span");
    note.className = "step-note";
    note.textContent = agentRun.notes.get(step.key) ?? "";
    item.append(mark, label, note);
    return item;
  }));
}

function updateAgentDemoButtons() {
  const running = agentRun.active;
  $("runAgentDemo").disabled = running;
  $("runAgentDemoPane").disabled = running;
  $("runAgentDemoText").textContent = running ? "Running…" : "Run agent demo";
  $("runAgentDemoPane").textContent = running ? "Running…" : "Run agent demo";
  $("runAgentDemo").classList.toggle("is-running", running);
}

async function runAgentDemo() {
  if (agentRun.active) return;
  agentRun.active = true;
  agentRun.statuses = new Map();
  agentRun.notes = new Map();
  activatePane("agent");
  renderAgentSteps();
  updateAgentDemoButtons();
  let currentStep = null;
  try {
    if (!state.document) await loadDemoPdf();
    for (let index = 0; index < AGENT_STEPS.length; index += 1) {
      const step = AGENT_STEPS[index];
      currentStep = step;
      agentRun.statuses.set(step.key, "running");
      renderAgentSteps();
      updateAgentDemoButtons();
      const args = step.key === "applyRedactions"
        ? {
            targetIds: registry.all()
              .filter((finding) => finding.status === "pending")
              .map((finding) => finding.id),
            maskMode: state.maskMode,
          }
        : step.key === "exportSanitizedDocument"
          ? { filename: `redacta-sanitized.${state.document.format}` }
          : {};
      let result;
      if (step.key === "scanDocumentPII") setScanProgress(0);
      try {
        result = await executeTool(step.key, args, "agent");
      } finally {
        if (step.key === "scanDocumentPII") setScanProgress(null);
      }
      const success = ["success", "verified"].includes(result.status);
      agentRun.statuses.set(step.key, success ? "done" : "failed");
      agentRun.notes.set(step.key, success ? summarizeResult(step.key, result) : result.status);
      renderAgentSteps();
      if (step.key === "applyRedactions" && success) {
        state.lastRedactionBatch = args.targetIds;
        render();
      }
      if (!success) {
        toast(result.status === "denied" ? "Agent request denied — the run stopped." : "The agent run stopped — nothing was exported.");
        break;
      }
      if (index < AGENT_STEPS.length - 1) await new Promise((resolve) => setTimeout(resolve, 320));
    }
    if (AGENT_STEPS.every((step) => agentRun.statuses.get(step.key) === "done")) {
      toast("Agent run complete · verified copy exported locally");
    }
  } catch {
    if (currentStep) {
      agentRun.statuses.set(currentStep.key, "failed");
      agentRun.notes.set(currentStep.key, "error");
      renderAgentSteps();
    }
    toast("The agent run stopped — nothing was exported.");
  } finally {
    agentRun.active = false;
    renderAgentSteps();
    updateAgentDemoButtons();
  }
}

async function loadDocument(document) {
  state.document = document;
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  state.lastRedactionBatch = [];
  state.pdfPage = 1;
  state.zoom = 1;
  pdfPreviewCache = { key: null, pdf: null };
  pdfCanvas = null;
  thumbKey = null;
  registry.replace([]);
  $("fileName").textContent = document.name;
  $("fileMeta").textContent = `${document.format.toUpperCase()} · ${document.sizeLabel} · ${document.pageCount} page${document.pageCount === 1 ? "" : "s"} · local`;
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
  setScanProgress(0);
  const result = await executeTool("scanDocumentPII", {}, "user");
  setScanProgress(null);
  if (result.status !== "success") toast("Scan failed. No redaction or export was performed.");
  else toast(`${result.totalDetected} findings detected · values withheld`);
}

async function runRedaction() {
  const targetIds = registry.all().filter((finding) => finding.status === "pending").map((finding) => finding.id);
  if (!targetIds.length) return toast("Select at least one finding to redact.");
  const result = await executeTool("applyRedactions", { targetIds, maskMode: state.maskMode }, "user");
  if (result.status !== "success") toast(result.status === "denied" ? "Redaction cancelled." : "Redaction failed. No export was performed.");
  else {
    state.lastRedactionBatch = targetIds;
    render();
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
    $("nativeStatusText").textContent = "Demo Mode";
    $("nativeStatus").classList.add("is-demo");
    $("nativeStatus").title = "Native WebMCP isn't available. Demo Mode is active — the same tools are callable from the tool console.";
    $("modeLabel").textContent = "DEMO MODE";
    $("statusMode").textContent = "demo mode";
    Object.assign(window, Object.fromEntries(Object.keys(toolMap).map((name) => [name, (input) => execute(name, input)])));
    return;
  }
  for (const [name] of Object.entries(toolMap)) document.modelContext.registerTool({ name, description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name], execute: (input) => execute(name, input) });
  $("modeLabel").textContent = "NATIVE WEBMCP";
  $("nativeStatusText").textContent = `${Object.keys(toolMap).length} WebMCP tools registered`;
  $("statusMode").textContent = "native";
}

export function initUI() {
  state.networkUploads = 0;
  installNetworkMonitor((count) => { state.networkUploads = count; render(); });
  const openFile = () => $("fileInput").click();
  $("browseButton").addEventListener("click", openFile);
  $("menuOpen").addEventListener("click", openFile);
  $("fileInput").addEventListener("change", (event) => handleFile(event.target.files[0]));
  const stage = document.querySelector(".viewer-stage");
  stage.addEventListener("dragover", (event) => { event.preventDefault(); $("dropZone").classList.add("dragging"); });
  stage.addEventListener("dragleave", () => $("dropZone").classList.remove("dragging"));
  stage.addEventListener("drop", (event) => { event.preventDefault(); $("dropZone").classList.remove("dragging"); handleFile(event.dataTransfer.files[0]); });
  $("scanButton").addEventListener("click", runScan);
  $("loadDemoButton").addEventListener("click", loadDemoText);
  $("loadDemoPdfButton").addEventListener("click", loadDemoPdf);
  $("menuDemoText").addEventListener("click", loadDemoText);
  $("menuDemoPdf").addEventListener("click", loadDemoPdf);
  $("pagePrev").addEventListener("click", () => goToPage(state.pdfPage - 1));
  $("pageNext").addEventListener("click", () => goToPage(state.pdfPage + 1));
  $("pageInput").addEventListener("change", (event) => goToPage(Number(event.target.value)));
  $("zoomIn").addEventListener("click", () => stepZoom(1));
  $("zoomOut").addEventListener("click", () => stepZoom(-1));
  $("zoomFit").addEventListener("click", fitToWidth);
  $("runAgentDemo").addEventListener("click", runAgentDemo);
  $("runAgentDemoPane").addEventListener("click", runAgentDemo);
  $("emptyAgentDemo").addEventListener("click", runAgentDemo);
  $("thumbList").addEventListener("click", (event) => {
    const thumb = event.target.closest(".thumb");
    if (thumb) goToPage(Number(thumb.dataset.page));
  });
  for (const button of document.querySelectorAll(".rail-button")) button.addEventListener("click", () => activatePane(button.dataset.pane));
  $("redactButton").addEventListener("click", runRedaction);
  $("verifyButton").addEventListener("click", runVerification);
  $("copyCertificateDigest").addEventListener("click", copyCertificateDigest);
  $("downloadCertificate").addEventListener("click", downloadCertificate);
  $("exportButton").addEventListener("click", async () => {
    const result = await executeTool("exportSanitizedDocument", { filename: `redacta-sanitized.${state.document.format}` }, "user");
    if (result.status === "success") toast("Verified copy downloaded locally");
    else toast("Export blocked until verification passes.");
  });
  $("manualButton").addEventListener("click", () => {
    setManualMode(!state.manualMode);
    toast(state.manualMode ? "Drag over the page, or select text, to mark a region." : "Manual marking cancelled.");
  });
  $("undoButton").addEventListener("click", () => { registry.restore(state.lastRedactionBatch); state.lastRedactionBatch = []; invalidate(); toast("Last redaction batch undone."); });
  $("findingList").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[type=checkbox]");
    if (!checkbox) return;
    if (checkbox.checked) registry.restore([checkbox.dataset.id]);
    else registry.exclude([checkbox.dataset.id]);
    invalidate();
  });
  $("findingList").addEventListener("click", (event) => {
    const control = event.target.closest("[data-action='restore']");
    if (control) {
      registry.restore([control.dataset.id]);
      state.lastRedactionBatch = state.lastRedactionBatch.filter((id) => id !== control.dataset.id);
      invalidate();
      return;
    }
    const row = event.target.closest(".finding");
    if (row && !event.target.matches("input")) goToPage(Number(row.dataset.page));
  });
  $("findingList").addEventListener("mouseover", (event) => {
    const row = event.target.closest(".finding");
    if (row) locateFinding(row.dataset.findingId);
  });
  $("findingList").addEventListener("focusin", (event) => {
    const row = event.target.closest(".finding");
    if (row) locateFinding(row.dataset.findingId);
  });
  $("findingList").addEventListener("mouseleave", clearLocator);
  $("copyPrompt").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("demoPrompt").textContent.trim());
      toast("Demo prompt copied to the clipboard.");
    } catch {
      toast("Copying is blocked here — select the prompt text instead.");
    }
  });
  $("selectAll").addEventListener("click", () => {
    registry.restore(registry.all().filter((finding) => finding.status === "excluded").map((finding) => finding.id));
    invalidate();
  });
  $("selectNone").addEventListener("click", () => {
    registry.exclude(registry.all().map((finding) => finding.id));
    invalidate();
  });
  $("maskModeSelect").addEventListener("change", (event) => {
    state.maskMode = event.target.value;
    invalidate();
    toast(state.maskMode === "blackout" ? "Masks will be solid blackout bars." : "Masks will use synthetic replacement values.");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("permissionModal").hidden) return $("permissionCancel").click();
      if (state.manualMode) setManualMode(false);
      return;
    }
    if (event.target.matches("input, textarea, select") || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowLeft" || event.key === "PageUp") goToPage(state.pdfPage - 1);
    else if (event.key === "ArrowRight" || event.key === "PageDown") goToPage(state.pdfPage + 1);
    else if (event.key === "+" || event.key === "=") stepZoom(1);
    else if (event.key === "-") stepZoom(-1);
  });
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
  renderAudit();
  renderAgentSteps();
  updateAgentDemoButtons();
  render();
  if (new URLSearchParams(location.search).get("demo") === "agent") runAgentDemo();
}
