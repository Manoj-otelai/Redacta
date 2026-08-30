import { createFindingRegistry } from "./registry.js";
import { loadTextDocument, writeTextDocument } from "./textDocument.js";
import { createDemoPdf, loadPdfDocument, rebuildPdfDocumentText } from "./pdfDocument.js";
import { readEditableDocumentText, remapFindingOffsets } from "./editor.js";
import { MAX_CUSTOM_PATTERNS, syntheticReplacement } from "./detectors.js";
import { installNetworkMonitor } from "./network.js";
import { asBytes, createBrowserSession } from "./session.js";
import { structuredFields } from "./structured.js";
import {
  applyRedactions,
  buildArtifact,
  exportSanitizedDocument,
  getVerificationCertificate,
  getFindingDetails,
  inspectDocument,
  listStructuredFields,
  redactField,
  registerCustomPattern,
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
const demoJson = JSON.stringify({
  records: [
    {
      employee_id: "EMP-100001",
      ssn: "123-45-6789",
      email: "ava.chen@northstar.example",
      phone: "(415) 555-0101",
      card: "4111 1111 1111 1111",
      integration_token: "sk_live_51NORTHSTAR_8df7a",
    },
    {
      employee_id: "EMP-100002",
      ssn: "234-56-7890",
      email: "liam.ortiz@northstar.example",
      phone: "(415) 555-0102",
      card: "4000 0566 5566 5556",
      integration_token: "sk_live_51NORTHSTAR_9jk2b",
    },
    {
      employee_id: "EMP-100003",
      ssn: "345-67-8901",
      email: "mira.patel@northstar.example",
      phone: "(415) 555-0103",
      card: "5555 5555 5555 4444",
      integration_token: "sk_live_51NORTHSTAR_4pq6c",
    },
  ],
  meta: {
    owner_email: "ops@northstar.example",
    record_count: 3,
  },
}, null, 2);
const demoCsv = `employee_id,ssn,email,phone,card,integration_token,notes
EMP-200001,456-78-9012,zoe.martin@northstar.example,(415) 555-0111,4111 1111 1111 1111,sk_live_51NORTHSTAR_5rs8d,"Contractor, part-time"
EMP-200002,567-89-0123,noah.kim@northstar.example,(415) 555-0112,4242 4242 4242 4242,sk_live_51NORTHSTAR_6tu9e,"Full-time, remote"
EMP-200003,678-90-1234,sofia.reyes@northstar.example,(415) 555-0113,5555 5555 5555 4444,sk_live_51NORTHSTAR_7vw1f,"Finance, manager"
EMP-200004,789-01-2345,eli.brooks@northstar.example,(415) 555-0114,6011 1111 1111 1117,sk_live_51NORTHSTAR_8xy2g,"Engineering, on-call"`;

const loadDemoText = async () => loadDocument(await loadTextDocument(new File([demoText], "confidential-employment-contract.txt", { type: "text/plain" })));
const loadDemoJson = async () => loadDocument(await loadTextDocument(new File([demoJson], "redacta-demo-records.json", { type: "application/json" })));
const loadDemoCsv = async () => loadDocument(await loadTextDocument(new File([demoCsv], "redacta-demo-records.csv", { type: "text/csv" })));
const loadDemoPdf = async () => loadDocument(await loadPdfDocument(await createDemoPdf()));
const toolMap = { inspectDocument, scanDocumentPII, applyRedactions, verifyRedaction, getFindingDetails, exportSanitizedDocument, getVerificationCertificate, registerCustomPattern, listStructuredFields, redactField };
const state = { document: null, artifact: null, verification: null, structuredFields: [], customPatterns: [], maskMode: "blackout", revision: 0, lastRedactionBatch: [], manualMode: false, pdfPage: 1, zoom: 1 };
const registry = createFindingRegistry();
const session = createBrowserSession();
const audit = { calls: 0, leaks: 0 };
const AGENT_STEPS = [
  { key: "inspectDocument", label: "Inspect document" },
  { key: "scanDocumentPII", label: "Scan for sensitive data" },
  { key: "applyRedactions", label: "Apply redactions" },
  { key: "verifyRedaction", label: "Verify sanitized copy" },
  { key: "exportSanitizedDocument", label: "Export verified copy" },
];
const agentRun = { active: false, steps: AGENT_STEPS, statuses: new Map(), notes: new Map() };
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
  structured_field: "Structured field",
  manual_rectangle: "Manual region",
  manual: "Manual selection",
};
const findingTypeLabel = (type) => type.startsWith("custom:")
  ? `Custom · ${type.slice(7)}`
  : (TYPE_LABELS[type] ?? type.replaceAll("_", " "));
let pdfPreviewCache = { key: null, pdf: null };
let pdfRenderGeneration = 0;
let thumbGeneration = 0;
let thumbKey = null;
let pdfCanvas = null;
let previewRefreshBusy = false;
let noteSequence = 0;
let thumbEditTimer = 0;
let persistTimer = 0;
let persistBusy = false;
let persistQueued = false;
let restoring = false;
let restoreGeneration = 0;
const context = {
  state,
  registry,
  get document() { return state.document; },
  callSource: "user",
  onProgress(value) {
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
  if (name === "getFindingDetails") {
    return result.id
      ? [result.type, result.id].filter(Boolean).join(" · ")
      : safe.message || "finding not found";
  }
  if (safe.status && !["success", "verified", "failed"].includes(safe.status)) {
    return safe.message ? `${safe.status} — ${safe.message}` : safe.status;
  }
  switch (name) {
    case "inspectDocument":
      return [result.fileType, plural(result.pageCount ?? 1, "page"), result.documentSize].filter(Boolean).join(" · ");
    case "scanDocumentPII":
      return `${plural(safe.totalDetected ?? 0, "finding")} detected`;
    case "listStructuredFields":
      return `${plural(result.fields?.length ?? 0, "field")} listed`;
    case "redactField":
      return [result.field, plural(result.valuesRedacted ?? 0, "value")].filter(Boolean).join(" · ");
    case "applyRedactions":
      return `${plural(safe.totalRedacted ?? 0, "region")} masked · ${safe.maskMode}`;
    case "verifyRedaction":
      return safe.passed
        ? `passed · 0 remaining across ${Object.keys(safe.categories ?? {}).length} categories`
        : `failed · ${plural(safe.remainingFindings ?? 0, "finding")} remaining`;
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
    schedulePersist();
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
    const returnFocus = document.activeElement;
    $("permissionMessage").textContent = message;
    modal.hidden = false;
    $("permissionCancel").focus();
    let settled = false;
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      modal.hidden = true;
      modal.removeEventListener("keydown", trapFocus);
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
      clearTimeout(timeout);
      resolve(allowed);
    };
    const trapFocus = (event) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const target = document.activeElement === $("permissionAllow") ? $("permissionCancel") : $("permissionAllow");
      target.focus();
    };
    modal.addEventListener("keydown", trapFocus);
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
    schedulePersist();
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
  schedulePersist();
  if (registry.all().some((finding) => finding.status === "redacted")) void refreshPreviewArtifact();
}

function renderTextPreview() {
  const text = state.document.text;
  const findings = registry.all()
    .filter((finding) => Number.isInteger(finding.charStart) && Number.isInteger(finding.charEnd))
    .sort((left, right) => left.charStart - right.charStart);
  const originalValues = new Set(registry.all()
    .map((finding) => finding.value)
    .filter((value) => typeof value === "string" && value.length > 0));
  const parts = [];
  let cursor = 0;
  for (const finding of findings) {
    if (finding.charStart < cursor) continue;
    parts.push(`<span data-start="${cursor}" data-end="${finding.charStart}">${escapeHtml(text.slice(cursor, finding.charStart))}</span>`);
    const value = text.slice(finding.charStart, finding.charEnd);
    const body = finding.status === "redacted"
      ? state.maskMode === "synthetic_replacement"
        ? escapeHtml(syntheticReplacement(finding.type, value, originalValues))
        : "█".repeat(Math.max(4, value.length))
      : escapeHtml(value);
      parts.push(`<mark contenteditable="false" class="${finding.status === "redacted" ? (state.maskMode === "synthetic_replacement" ? "redacted synthetic" : "redacted") : ""}" data-finding="${escapeHtml(finding.type)}" data-original="${escapeHtml(value)}" data-start="${finding.charStart}" data-end="${finding.charEnd}">${body}</mark>`);
    cursor = finding.charEnd;
  }
  parts.push(`<span data-start="${cursor}" data-end="${text.length}">${escapeHtml(text.slice(cursor))}</span>`);
  return parts.join("");
}

function updateManualTextPreviewFocusable(preview) {
  if (state.manualMode && state.document?.kind !== "pdf") preview.setAttribute("tabindex", "0");
  else preview.removeAttribute("tabindex");
}

function commitManualTextSelection(preview) {
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
}

function placeManualTextCaret(preview) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount && preview.contains(selection.anchorNode)) return;
  const point = manualTextPointAtOffset(preview, 0);
  if (!point) return;
  const range = document.createRange();
  range.setStart(...point);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function manualTextPointAtOffset(preview, offset) {
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
  let node;
  let lastPoint = null;
  while ((node = walker.nextNode())) {
    const owner = node.parentElement?.closest("[data-start]");
    if (!owner || !preview.contains(owner)) continue;
    const start = Number(owner.dataset.start);
    const end = Number(owner.dataset.end);
    const localEnd = Math.min(node.length, end - start);
    lastPoint = [node, localEnd];
    if (offset <= start) return [node, 0];
    if (offset <= end) return [node, Math.max(0, Math.min(localEnd, offset - start))];
  }
  return lastPoint;
}

function extendManualTextSelection(preview, direction) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !preview.contains(selection.anchorNode) || !preview.contains(selection.focusNode)) return;
  const anchor = selectionPointToOffset(preview, selection.anchorNode, selection.anchorOffset);
  const focus = selectionPointToOffset(preview, selection.focusNode, selection.focusOffset);
  const nextFocus = Math.max(0, Math.min(state.document.text.length, focus + direction));
  const anchorPoint = manualTextPointAtOffset(preview, anchor);
  const focusPoint = manualTextPointAtOffset(preview, nextFocus);
  if (!anchorPoint || !focusPoint) return;
  selection.setBaseAndExtent(anchorPoint[0], anchorPoint[1], focusPoint[0], focusPoint[1]);
}

function attachTextEditor(content) {
  if (!content) return;
  content.addEventListener("input", () => commitLiveTextEdit(content));
  content.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
  });
}

function commitLiveTextEdit(content) {
  if (!state.document || state.document.kind === "pdf") return;
  const next = readEditableDocumentText(content);
  if (next === state.document.text) return;
  writeTextDocument(state.document, next);
  const dropped = remapFindingOffsets(registry.all(), next);
  if (dropped.length) registry.remove(dropped);
  state.structuredFields = structuredFields(state.document);
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  render({ keepPreview: true });
  schedulePersist();
}

function scheduleThumbRefresh() {
  clearTimeout(thumbEditTimer);
  thumbEditTimer = setTimeout(() => {
    thumbKey = null;
    renderThumbnails();
  }, 400);
}

function addPdfNote(pageNumber, x, y, text) {
  if (!state.document || state.document.kind !== "pdf") return;
  state.document.notes ??= [];
  noteSequence += 1;
  const note = { id: `note_${noteSequence}`, page: pageNumber, x, y, text, fontSize: 14 };
  state.document.notes.push(note);
  rebuildPdfDocumentText(state.document);
  const frame = pdfCanvas?.parentElement;
  const page = state.document.pages[state.pdfPage - 1];
  if (frame && page) renderPdfNotesLayer(frame.querySelector(".pdf-notes-layer"), page, pdfCanvas);
  const field = frame?.querySelector(`[data-note-id="${note.id}"]`);
  field?.focus();
  commitPdfNoteEdit();
}

function commitPdfNoteEdit() {
  if (!state.document || state.document.kind !== "pdf") return;
  rebuildPdfDocumentText(state.document);
  const dropped = remapFindingOffsets(registry.all(), state.document.text);
  if (dropped.length) registry.remove(dropped);
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  render({ keepPreview: true });
  schedulePersist();
}

function renderPdfTextLayer(layer, pageInfo, canvas) {
  if (!layer || !pageInfo) return;
  layer.replaceChildren();
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (!width || !height) return;
  const scaleX = width / pageInfo.width;
  const scaleY = height / pageInfo.height;
  for (const entry of pageInfo.items) {
    const item = entry.item;
    const fontSize = Math.abs(item.transform?.[3] || item.height || 12);
    const x = item.transform?.[4] || 0;
    const baseline = item.transform?.[5] || 0;
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${x * scaleX}px`;
    span.style.top = `${(pageInfo.height - baseline - fontSize) * scaleY}px`;
    span.style.fontSize = `${Math.max(6, fontSize * scaleY)}px`;
    if (item.width) span.style.width = `${item.width * scaleX}px`;
    layer.append(span);
  }
}

function renderPdfNotesLayer(layer, pageInfo, canvas) {
  if (!layer || !pageInfo) return;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (!width || !height) return;
  const scaleX = width / pageInfo.width;
  const scaleY = height / pageInfo.height;
  const notes = (state.document.notes ?? []).filter((note) => note.page === pageInfo.pageNumber);
  const existing = new Map([...layer.querySelectorAll("[data-note-id]")].map((node) => [node.dataset.noteId, node]));
  for (const [id, node] of existing) {
    if (!notes.some((note) => note.id === id)) node.remove();
  }
  for (const note of notes) {
    let field = existing.get(note.id);
    if (!field) {
      field = document.createElement("textarea");
      field.className = "pdf-note";
      field.dataset.noteId = note.id;
      field.setAttribute("aria-label", "Typed note on this page");
      field.addEventListener("input", () => {
        note.text = field.value;
        field.style.height = "auto";
        field.style.height = `${Math.max(22, field.scrollHeight)}px`;
        commitPdfNoteEdit();
      });
      field.addEventListener("keydown", (event) => {
        if (event.key === "Escape") field.blur();
      });
      layer.append(field);
    }
    if (document.activeElement !== field) field.value = note.text;
    field.style.left = `${note.x * scaleX}px`;
    field.style.top = `${note.y * scaleY}px`;
    field.style.fontSize = `${(note.fontSize || 14) * scaleY}px`;
    field.style.height = "auto";
    field.style.height = `${Math.max(22, field.scrollHeight)}px`;
  }
}

function attachManualTextSelection(preview) {
  updateManualTextPreviewFocusable(preview);
  preview.onfocus = () => {
    if (state.manualMode) placeManualTextCaret(preview);
  };
  preview.onmouseup = () => commitManualTextSelection(preview);
  preview.onkeydown = (event) => {
    if (!state.manualMode) return;
    if (event.shiftKey && event.key === "ArrowRight") {
      event.preventDefault();
      extendManualTextSelection(preview, 1);
      return;
    }
    if (event.shiftKey && event.key === "ArrowLeft") {
      event.preventDefault();
      extendManualTextSelection(preview, -1);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitManualTextSelection(preview);
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
  canvas.setAttribute("aria-hidden", "true");
  const textLayer = document.createElement("div");
  textLayer.className = "pdf-text-layer";
  const notesLayer = document.createElement("div");
  notesLayer.className = "pdf-notes-layer";
  const overlay = document.createElement("div");
  overlay.className = "pdf-overlay";
  frame.append(canvas, textLayer, notesLayer, overlay);
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
  textLayer.addEventListener("click", (event) => {
    if (state.manualMode || event.target !== textLayer || !state.document) return;
    const page = state.document.pages[state.pdfPage - 1];
    if (!page) return;
    const rect = textLayer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * page.width;
    const y = ((event.clientY - rect.top) / rect.height) * page.height;
    addPdfNote(page.pageNumber, x, y, "");
  });
  return canvas;
}

function renderPreview() {
  const preview = $("documentPreview");
  if (!state.document) return;
  preview.classList.toggle("is-csv", state.document.format === "csv");
  if (state.document.kind === "pdf") {
    if (!pdfCanvas || !preview.contains(pdfCanvas)) pdfCanvas = createPdfCanvas(preview);
    renderPdfPreview(pdfCanvas, state.pdfPage).catch(() => toast("Could not render the PDF preview."));
    return;
  }
  preview.innerHTML = `<div class="text-page"><div class="document-topline"><span>Confidential</span><span>Local document / edit</span></div><h3>${escapeHtml(state.document.name.replace(/\.[^.]+$/, ""))}</h3><p class="text-content" id="documentEditor" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true">${renderTextPreview()}</p><div class="document-footer"><span>Redacta · private</span><span>Page 1 of 1</span></div></div>`;
  pdfCanvas = null;
  attachManualTextSelection(preview.firstElementChild);
  attachTextEditor($("documentEditor"));
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
  $("documentPreview").setAttribute(
    "aria-label",
    state.document?.kind === "pdf"
      ? `Document preview, page ${state.pdfPage} of ${pageCount}, rendered as an image`
      : "Document preview",
  );
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
  const redacted = registry.all().filter((finding) => finding.status === "redacted").length;
  const key = state.document.kind === "pdf"
    ? `${state.document.name}:${state.artifact?.digest ?? "source"}:${pageCount}`
    : `${state.document.name}:${pageCount}:${registry.all().length}:${redacted}:${state.maskMode}`;
  if (thumbKey !== key) {
    thumbKey = key;
    const generation = ++thumbGeneration;
    list.replaceChildren();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "thumb";
      thumb.dataset.page = String(pageNumber);
      thumb.setAttribute("aria-label", `Go to page ${pageNumber}`);
      const label = document.createElement("span");
      label.textContent = String(pageNumber);
      if (state.document.kind === "pdf") {
        const canvas = document.createElement("canvas");
        thumb.append(canvas, label);
        renderThumbnail(canvas, pageNumber, generation).catch(() => {});
      } else {
        const face = document.createElement("div");
        face.className = "thumb-face is-text";
        face.innerHTML = `<div class="thumb-mini text-page"><div class="document-topline"><span>Confidential</span><span>Local document / preview</span></div><h3>${escapeHtml(state.document.name.replace(/\.[^.]+$/, ""))}</h3><p class="text-content">${renderTextPreview()}</p></div>`;
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
  const frame = canvas.parentElement;
  if (frame) {
    renderPdfTextLayer(frame.querySelector(".pdf-text-layer"), page, canvas);
    renderPdfNotesLayer(frame.querySelector(".pdf-notes-layer"), page, canvas);
  }
}

function captureTaskFocus() {
  const active = document.activeElement;
  const taskPane = document.querySelector(".task-pane");
  if (!(active instanceof HTMLElement) || active === document.body || !taskPane?.contains(active)) return null;
  const finding = active.closest(".finding");
  if (finding?.dataset.findingId) {
    if (active.matches("input[type='checkbox']")) return { kind: "finding-checkbox", id: finding.dataset.findingId };
    if (active.matches("[data-action='restore']")) return { kind: "finding-restore", id: finding.dataset.findingId };
  }
  const fieldButton = active.closest("[data-field-name]");
  if (fieldButton?.dataset.fieldName) return { kind: "structured-field", field: fieldButton.dataset.fieldName };
  if (active.id) return { kind: "id", id: active.id };
  return null;
}

function restoreTaskFocus(snapshot) {
  if (!snapshot) return;
  const findingControl = (id, selector) => [...document.querySelectorAll(selector)]
    .find((element) => element.dataset.id === id);
  let target;
  if (snapshot.kind === "finding-checkbox") target = findingControl(snapshot.id, "#findingList input[type='checkbox']");
  if (snapshot.kind === "finding-restore") {
    target = findingControl(snapshot.id, "#findingList [data-action='restore']")
      ?? findingControl(snapshot.id, "#findingList input[type='checkbox']");
  }
  if (snapshot.kind === "structured-field") {
    target = [...document.querySelectorAll("#structuredFieldList [data-field-name]")]
      .find((element) => element.dataset.fieldName === snapshot.field);
  }
  if (snapshot.kind === "id") target = $(snapshot.id);
  if (target?.id === "redactButton" && target.disabled) target = $("verifyButton");
  if (!target || target.disabled || target.hidden || target.closest("[hidden]")) return;
  target.focus();
}

function render(options = {}) {
  const focus = captureTaskFocus();
  const findings = registry.all();
  const verified = Boolean(state.verification?.passed);
  $("findingTotal").textContent = `${findings.length} found`;
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
      row.setAttribute("role", "listitem");
      row.dataset.findingId = finding.id;
      row.dataset.page = finding.page || 1;
      row.innerHTML = `<input type="checkbox" data-id="${finding.id}" aria-label="Include ${finding.id} in the next redaction" ${finding.status === "redacted" ? "disabled" : ""} ${finding.status === "excluded" ? "" : "checked"} /><span class="finding-dot"></span><span class="finding-info"><strong>${escapeHtml(findingTypeLabel(finding.type))}</strong><small>${finding.id} · ${escapeHtml(finding.location || "local")}</small></span><span class="confidence">${finding.confidence.toFixed(2)}</span><span class="finding-actions">${finding.status === "pending" ? "" : `<span class="finding-tag">${finding.status}</span>`}${finding.status === "redacted" ? `<button class="finding-control" data-action="restore" data-id="${finding.id}">Restore</button>` : ""}</span>`;
      row.querySelector("input[type='checkbox']").setAttribute(
        "aria-label",
        `Include ${findingTypeLabel(finding.type)}, ${finding.location || "local"}, in the next redaction`,
      );
      list.append(row);
    }
  }
  renderCategorySummary(findings);
  renderStructuredFields();
  renderCustomPatterns();
  renderVerificationSummary();
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
  if (options.keepPreview) scheduleThumbRefresh();
  else {
    renderThumbnails();
    renderPreview();
  }
  restoreTaskFocus(focus);
}

function renderCategorySummary(findings) {
  const summary = $("categorySummary");
  summary.hidden = !findings.length;
  const counts = new Map();
  for (const finding of findings) counts.set(finding.type, (counts.get(finding.type) ?? 0) + 1);
  summary.replaceChildren(...[...counts].map(([type, count]) => {
    const chip = document.createElement("span");
    chip.className = "category-chip";
    chip.append(findingTypeLabel(type), Object.assign(document.createElement("strong"), { textContent: String(count) }));
    return chip;
  }));
}

function renderCustomPatterns() {
  const patterns = state.customPatterns;
  $("customPatternCount").textContent = `${patterns.length} / ${MAX_CUSTOM_PATTERNS}`;
  const list = $("customPatternList");
  list.replaceChildren();
  if (!patterns.length) return;
  for (const pattern of patterns) {
    const row = document.createElement("div");
    row.className = "custom-pattern-row";
    const details = document.createElement("div");
    details.className = "custom-pattern-details";
    const name = document.createElement("strong");
    name.textContent = pattern.name;
    const source = document.createElement("code");
    source.textContent = pattern.source;
    details.append(name, source);
    const remove = document.createElement("button");
    remove.className = "custom-pattern-remove";
    remove.type = "button";
    remove.dataset.patternName = pattern.name;
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove pattern ${pattern.name}`);
    row.append(details, remove);
    list.append(row);
  }
}

function renderStructuredFields() {
  const section = $("structuredFieldsSection");
  const visible = Boolean(state.document && ["json", "csv"].includes(state.document.format));
  section.hidden = !visible;
  if (!visible) return;
  const fields = state.structuredFields;
  $("structuredFieldCount").textContent = `${fields.length} field${fields.length === 1 ? "" : "s"}`;
  const list = $("structuredFieldList");
  list.replaceChildren();
  if (!fields.length) {
    const empty = document.createElement("div");
    empty.className = "custom-pattern-empty";
    empty.textContent = "No structured fields detected.";
    list.append(empty);
    return;
  }
  for (const { field, occurrences } of fields) {
    const row = document.createElement("div");
    row.className = "custom-pattern-row";
    const details = document.createElement("div");
    details.className = "custom-pattern-details";
    const name = document.createElement("code");
    name.textContent = field;
    const count = document.createElement("span");
    count.className = "custom-pattern-count";
    count.textContent = `${occurrences} value${occurrences === 1 ? "" : "s"}`;
    details.append(name, count);
    const redact = document.createElement("button");
    redact.className = "custom-pattern-remove";
    redact.type = "button";
    redact.dataset.fieldName = field;
    redact.textContent = "Redact";
    redact.setAttribute("aria-label", `Redact field ${field}`);
    row.append(details, redact);
    list.append(row);
  }
}

function renderVerificationSummary() {
  const summary = $("verificationSummary");
  const passed = Boolean(state.verification?.passed);
  summary.hidden = !passed;
  if (!passed) return;
  const certificate = state.verification.certificate;
  const certified = document.createElement("p");
  certified.className = "certificate-summary";
  certified.textContent = certificate
    ? `Certified ${certificate.certificateId} · ${certificate.artifactDigest.slice(0, 12)}…`
    : "Verified artifact certificate unavailable.";
  summary.replaceChildren(
    Object.assign(document.createElement("strong"), { textContent: "Verification passed" }),
    certified,
  );
}

function setManualMode(enabled) {
  state.manualMode = enabled;
  renderViewerChrome();
  const preview = $("documentPreview").firstElementChild;
  if (preview?.classList.contains("text-page")) updateManualTextPreviewFocusable(preview);
}

function goToPage(pageNumber) {
  const pageCount = state.document?.kind === "pdf" ? state.document.pageCount : 1;
  state.pdfPage = Math.max(1, Math.min(pageCount, pageNumber || 1));
  renderViewerChrome();
  renderThumbnails();
  renderPreview();
  schedulePersist();
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
  schedulePersist();
}

function stepZoom(direction) {
  const index = ZOOM_STEPS.findIndex((step) => step >= state.zoom - 0.001);
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index < 0 ? ZOOM_STEPS.length - 1 : index) + direction))];
  if (next === state.zoom) return;
  state.zoom = next;
  renderViewerChrome();
  renderPreview();
  schedulePersist();
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
  list.replaceChildren(...(agentRun.steps ?? AGENT_STEPS).map((step) => {
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
    note.title = note.textContent;
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
  agentRun.steps = AGENT_STEPS;
  agentRun.statuses = new Map();
  agentRun.notes = new Map();
  activatePane("agent");
  renderAgentSteps();
  updateAgentDemoButtons();
  let currentStep = null;
  try {
    if (!state.document) await loadDemoPdf();
    agentRun.steps = [...AGENT_STEPS];
    if (["json", "csv"].includes(state.document.format) && state.structuredFields.length > 0) {
      const scanIndex = agentRun.steps.findIndex(({ key }) => key === "scanDocumentPII");
      agentRun.steps.splice(scanIndex + 1, 0,
        { key: "listStructuredFields", label: "List structured fields" },
        { key: "redactField", label: "Redact a whole field" },
      );
    }
    renderAgentSteps();
    let structuredFieldResult = null;
    for (let index = 0; index < agentRun.steps.length; index += 1) {
      const step = agentRun.steps[index];
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
        : step.key === "redactField"
          ? (() => {
              const fields = structuredFieldResult?.fields ?? [];
              if (!structuredFieldResult || structuredFieldResult.status !== "success" || !fields.length) return null;
              const selected = fields.reduce((best, field) => (
                !best || field.detectedFindings > best.detectedFindings ? field : best
              ), null);
              return { field: selected.field, maskMode: state.maskMode };
            })()
        : step.key === "exportSanitizedDocument"
          ? { filename: `redacta-sanitized.${state.document.format}` }
          : {};
      let result;
      if (step.key === "scanDocumentPII") setScanProgress(0);
      try {
        if (step.key === "redactField" && !args) {
          result = structuredFieldResult
            ? { status: "failed", message: structuredFieldResult.status }
            : { status: "failed", message: "No structured field result." };
        } else {
          result = await executeTool(step.key, args, "agent");
        }
      } finally {
        if (step.key === "scanDocumentPII") setScanProgress(null);
      }
      if (step.key === "listStructuredFields") structuredFieldResult = result;
      const success = ["success", "verified"].includes(result.status);
      agentRun.statuses.set(step.key, success ? "done" : "failed");
      const failureStatus = step.key === "redactField" && !args
        ? structuredFieldResult?.status ?? result.status
        : result.status;
      agentRun.notes.set(step.key, success ? summarizeResult(step.key, result) : failureStatus);
      renderAgentSteps();
      if (step.key === "applyRedactions" && success) {
        state.lastRedactionBatch = args.targetIds;
        render();
      }
      if (step.key === "redactField" && success) {
        state.lastRedactionBatch = result.redactedIds;
        render();
      }
      if (!success) {
        toast(result.status === "denied" ? "Agent request denied — the run stopped." : "The agent run stopped — nothing was exported.");
        break;
      }
      if (index < agentRun.steps.length - 1) await new Promise((resolve) => setTimeout(resolve, 320));
    }
    if (agentRun.steps.every((step) => agentRun.statuses.get(step.key) === "done")) {
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

function noteSequenceFrom(notes) {
  return (notes ?? []).reduce((max, note) => {
    const value = Number(String(note.id ?? "").replace(/^note_/, ""));
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
}

function adoptDocument(document, { resetWorkspace = true } = {}) {
  state.document = document;
  state.structuredFields = structuredFields(document);
  document.notes ??= [];
  noteSequence = noteSequenceFrom(document.notes);
  $("fileName").textContent = document.name;
  pdfPreviewCache = { key: null, pdf: null };
  pdfCanvas = null;
  thumbKey = null;
  if (!resetWorkspace) return;
  state.revision += 1;
  state.artifact = null;
  state.verification = null;
  state.lastRedactionBatch = [];
  state.pdfPage = 1;
  state.zoom = 1;
  registry.replace([]);
}

function clearWorkspaceView() {
  state.document = null;
  state.artifact = null;
  state.verification = null;
  state.structuredFields = [];
  state.lastRedactionBatch = [];
  state.pdfPage = 1;
  state.zoom = 1;
  pdfPreviewCache = { key: null, pdf: null };
  pdfCanvas = null;
  thumbKey = null;
  registry.replace([]);
  $("fileName").textContent = "No document open";
}

async function snapshotArtifact(artifact) {
  if (!artifact?.blob) return null;
  return {
    kind: artifact.kind,
    maskMode: artifact.maskMode,
    revision: artifact.revision,
    digest: artifact.digest,
    type: artifact.blob.type,
    bytes: asBytes(await artifact.blob.arrayBuffer()),
  };
}

async function buildWorkspaceSnapshot() {
  const document = state.document;
  if (!document?.bytes) return null;
  return {
    document: {
      kind: document.kind,
      format: document.format,
      name: document.name,
      type: document.type,
      size: document.size,
      sizeLabel: document.sizeLabel,
      pageCount: document.pageCount,
      bytes: asBytes(document.bytes).slice(),
      notes: (document.notes ?? []).map((note) => ({
        id: note.id,
        page: note.page,
        x: note.x,
        y: note.y,
        text: note.text,
        fontSize: note.fontSize,
      })),
    },
    findings: registry.all().map((finding) => ({
      ...finding,
      boundingBox: finding.boundingBox ? { ...finding.boundingBox } : finding.boundingBox,
    })),
    customPatterns: state.customPatterns.map((pattern) => ({ ...pattern })),
    maskMode: state.maskMode,
    revision: state.revision,
    lastRedactionBatch: [...state.lastRedactionBatch],
    pdfPage: state.pdfPage,
    zoom: state.zoom,
    artifact: await snapshotArtifact(state.artifact),
    verification: state.verification ? JSON.parse(JSON.stringify(state.verification)) : null,
  };
}

async function materializeDocument(saved) {
  const bytes = asBytes(saved.bytes);
  const file = new File([bytes], saved.name, { type: saved.type || (saved.kind === "pdf" ? "application/pdf" : "text/plain") });
  if (saved.kind === "pdf") {
    const document = await loadPdfDocument(file);
    document.notes = Array.isArray(saved.notes) ? saved.notes.map((note) => ({ ...note })) : [];
    rebuildPdfDocumentText(document);
    return document;
  }
  return loadTextDocument(file);
}

function restoreArtifact(saved) {
  if (!saved?.bytes) return null;
  return {
    kind: saved.kind,
    maskMode: saved.maskMode,
    revision: saved.revision,
    digest: saved.digest,
    blob: new Blob([asBytes(saved.bytes)], { type: saved.type || "" }),
  };
}

function schedulePersist() {
  if (restoring) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { void persistWorkspace(); }, 280);
}

function flushPersist() {
  if (restoring) return;
  clearTimeout(persistTimer);
  void persistWorkspace();
}

async function persistWorkspace() {
  if (restoring) return;
  if (persistBusy) {
    persistQueued = true;
    return;
  }
  persistBusy = true;
  try {
    if (!state.document) {
      await session.discard();
      return;
    }
    const workspace = await buildWorkspaceSnapshot();
    if (workspace) await session.save(workspace);
  } catch {
    // Session restore is best-effort; keep the live workspace usable.
  } finally {
    persistBusy = false;
    if (persistQueued) {
      persistQueued = false;
      void persistWorkspace();
    }
  }
}

async function restoreWorkspace() {
  const generation = ++restoreGeneration;
  restoring = true;
  try {
    const snapshot = await session.restore();
    if (generation !== restoreGeneration || !snapshot?.document) return false;
    const document = await materializeDocument(snapshot.document);
    if (generation !== restoreGeneration) return false;
    adoptDocument(document, { resetWorkspace: false });
    registry.hydrate(snapshot.findings ?? []);
    state.customPatterns = Array.isArray(snapshot.customPatterns) ? snapshot.customPatterns : [];
    state.maskMode = snapshot.maskMode === "synthetic_replacement" ? "synthetic_replacement" : "blackout";
    state.revision = Number.isInteger(snapshot.revision) ? snapshot.revision : 0;
    state.lastRedactionBatch = Array.isArray(snapshot.lastRedactionBatch) ? snapshot.lastRedactionBatch : [];
    state.pdfPage = Number.isInteger(snapshot.pdfPage) && snapshot.pdfPage > 0 ? snapshot.pdfPage : 1;
    state.zoom = typeof snapshot.zoom === "number" && snapshot.zoom > 0 ? snapshot.zoom : 1;
    state.artifact = restoreArtifact(snapshot.artifact);
    state.verification = snapshot.verification ?? null;
    render();
    toast("Restored this tab’s workspace");
    return true;
  } catch {
    if (generation !== restoreGeneration) return false;
    clearWorkspaceView();
    try { await session.discard(); } catch { /* ignore */ }
    toast("Could not restore this tab’s workspace.");
    render();
    return false;
  } finally {
    if (generation === restoreGeneration) restoring = false;
  }
}

async function bootSession() {
  const restored = await restoreWorkspace();
  if (!restored) render();
  if (new URLSearchParams(location.search).get("demo") === "agent") await runAgentDemo();
}

async function loadDocument(document) {
  restoreGeneration += 1;
  restoring = false;
  adoptDocument(document, { resetWorkspace: true });
  render();
  toast("Document loaded locally · no upload made");
  await persistWorkspace();
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
  state.lastRedactionBatch = targetIds;
  const result = await executeTool("applyRedactions", { targetIds, maskMode: state.maskMode }, "user");
  if (result.status !== "success") {
    state.lastRedactionBatch = [];
    schedulePersist();
    toast(result.status === "denied" ? "Redaction cancelled." : "Redaction failed. No export was performed.");
  } else {
    render();
    toast(`${result.totalRedacted} findings masked locally`);
  }
}

async function runVerification() {
  const result = await executeTool("verifyRedaction", {}, "user");
  toast(result.passed ? "Verification passed · export unlocked" : "Verification failed · export remains blocked");
}

async function registerPatternFromForm(event) {
  event.preventDefault();
  const error = $("customPatternError");
  error.textContent = "";
  const result = await executeTool("registerCustomPattern", {
    name: $("customPatternName").value,
    pattern: $("customPatternSource").value,
    flags: $("customPatternFlags").value,
  }, "user");
  if (result.status !== "success") {
    error.textContent = result.message;
    return;
  }
  $("customPatternForm").reset();
  if (state.document) await executeTool("scanDocumentPII", {}, "user");
  toast("Pattern registered \u2014 rescanned locally.");
}

async function removeCustomPattern(name) {
  state.customPatterns = state.customPatterns.filter((pattern) => pattern.name !== name);
  invalidate();
  if (state.document) await executeTool("scanDocumentPII", {}, "user");
  toast("Pattern removed \u2014 rescanned locally.");
}

async function redactStructuredField(field) {
  const result = await executeTool("redactField", { field, maskMode: state.maskMode }, "user");
  if (result.status !== "success") {
    toast(result.message || "Field redaction failed.");
    return;
  }
  state.lastRedactionBatch = result.redactedIds;
  schedulePersist();
  render();
  toast("Field redacted locally.");
}

function registerTools() {
  const execute = (name, input) => executeTool(name, input, "agent");
  const modelContext = document.modelContext?.registerTool
    ? document.modelContext
    : navigator.modelContext?.registerTool
      ? navigator.modelContext
      : null;
  if (!modelContext) {
    $("modeLabel").textContent = "DEMO MODE";
    Object.assign(window, Object.fromEntries(Object.keys(toolMap).map((name) => [name, (input) => execute(name, input)])));
    return;
  }
  for (const [name] of Object.entries(toolMap)) modelContext.registerTool({ name, description: TOOL_DESCRIPTIONS[name], inputSchema: TOOL_SCHEMAS[name], execute: (input) => execute(name, input) });
  $("modeLabel").textContent = "NATIVE WEBMCP";
}

export function initUI() {
  state.networkUploads = 0;
  installNetworkMonitor((count) => { state.networkUploads = count; });
  const fileInput = $("fileInput");
  const dropHasFiles = (event) => Boolean(event.dataTransfer?.types && [...event.dataTransfer.types].includes("Files"));
  const allowFileDrop = (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    $("dropZone").classList.add("dragging");
  };
  fileInput.addEventListener("change", (event) => {
    handleFile(event.target.files[0]);
    event.target.value = "";
  });
  const stage = document.querySelector(".viewer-stage");
  stage.addEventListener("dragenter", allowFileDrop, true);
  stage.addEventListener("dragover", allowFileDrop, true);
  stage.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && stage.contains(event.relatedTarget)) return;
    $("dropZone").classList.remove("dragging");
  });
  stage.addEventListener("drop", (event) => {
    if (!dropHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    $("dropZone").classList.remove("dragging");
    handleFile(event.dataTransfer.files[0]);
  }, true);
  $("scanButton").addEventListener("click", runScan);
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
  $("exportButton").addEventListener("click", async () => {
    const result = await executeTool("exportSanitizedDocument", { filename: `redacta-sanitized.${state.document.format}` }, "user");
    if (result.status === "success") toast("Verified copy downloaded locally");
    else toast("Export blocked until verification passes.");
  });
  $("manualButton").addEventListener("click", () => {
    setManualMode(!state.manualMode);
    toast(state.manualMode
      ? state.document?.kind === "pdf"
        ? "Drag over the page to mark a region."
        : "Drag over the page, or select text and press Enter, to mark a region."
      : "Manual marking cancelled.");
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
  $("customPatternForm").addEventListener("submit", registerPatternFromForm);
  $("customPatternList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pattern-name]");
    if (button) void removeCustomPattern(button.dataset.patternName);
  });
  $("structuredFieldList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-field-name]");
    if (button) void redactStructuredField(button.dataset.fieldName);
  });
  document.addEventListener("paste", (event) => {
    if (state.manualMode || !state.document || state.document.kind !== "pdf") return;
    if (event.target.closest("input, textarea, select, [contenteditable='true'], .pdf-note")) return;
    if (!document.querySelector(".viewer-stage:hover") && !event.target.closest(".pdf-frame")) return;
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const page = state.document.pages[state.pdfPage - 1];
    if (page) addPdfNote(page.pageNumber, 54, 72, text);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("permissionModal").hidden) return $("permissionCancel").click();
      if (state.manualMode) setManualMode(false);
      return;
    }
    if (event.target.closest("input, textarea, select, [contenteditable='true'], .pdf-note, .pdf-text-layer") || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
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
  window.addEventListener("beforeunload", (event) => {
    if (!state.document) return;
    flushPersist();
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", flushPersist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
  registerTools();
  renderAudit();
  renderAgentSteps();
  updateAgentDemoButtons();
  void bootSession();
}
