const state = { findings: [], documentText: "", file: null, verified: false };
const patterns = [
  { type: "ssn", label: "SSN", regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, color: "#e86b56", confidence: .99 },
  { type: "credit_card", label: "Credit card", regex: /\b(?:\d[ -]?){13,19}\b/g, color: "#cf8a32", confidence: .98 },
  { type: "email", label: "Email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, color: "#6c74c9", confidence: .97 },
  { type: "phone", label: "Phone", regex: /(?:\(\d{3}\)|\d{3})[- .]\d{3}[- .]\d{4}\b/g, color: "#9a68a8", confidence: .95 },
  { type: "api_key", label: "API key", regex: /\b(?:sk_live|sk_test)_[A-Za-z0-9_]+\b/g, color: "#bd536e", confidence: .96 },
  { type: "private_key", label: "Private key", regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g, color: "#bd536e", confidence: .99 }
];
const demoText = `CONFIDENTIAL\nEmployment Agreement\n\nThis Agreement is entered into by and between Jordan Lee (“Employee”) and Northstar Labs.\nEmployee identification: 123-45-6789\nContact: jordan.lee@northstar.example · (415) 555-0198\nPayroll will be deposited to card ending 4111 1111 1111 1111.\nInternal integration token: sk_live_51NORTHSTAR_8df7a.\nThe parties agree to the terms and conditions set forth below.`;
const $ = (id) => document.getElementById(id);

function addActivity(name, detail, muted = false) {
  const item = document.createElement("div");
  item.className = `activity-item${muted ? " muted" : ""}`;
  item.innerHTML = `<span class="activity-check">${muted ? "○" : "✓"}</span><div><strong>${name}</strong><p>${detail}</p></div>`;
  const log = $("activityLog");
  if (muted) log.replaceChildren(item); else log.append(item);
}
function toast(message) { const el = $("toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2600); }
function classify(text) {
  state.findings = [];
  patterns.forEach((pattern) => {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text))) {
      const value = match[0];
      if (pattern.type === "credit_card" && value.replace(/\D/g, "").length < 13) continue;
      state.findings.push({ id: `finding_${String(state.findings.length + 1).padStart(3, "0")}`, ...pattern, value, offset: match.index, redacted: false });
    }
  });
  state.findings.sort((a, b) => a.offset - b.offset);
}
function renderFindings() {
  const list = $("findingList");
  $("findingTotal").textContent = `${state.findings.length} found`;
  if (!state.findings.length) { list.innerHTML = `<div class="empty-state">No sensitive findings detected.</div>`; return; }
  list.innerHTML = state.findings.map((f, i) => `<label class="finding${f.redacted ? " redacted" : ""}"><input type="checkbox" data-index="${i}" ${f.redacted ? "disabled" : "checked"} /><span class="finding-dot" style="background:${f.color}"></span><span class="finding-info"><strong>${f.label}</strong><small>${f.id} · page 1 · region ${String.fromCharCode(65 + i)}</small></span><span class="confidence">${f.confidence.toFixed(2)}</span></label>`).join("");
  $("redactButton").disabled = state.findings.every((f) => f.redacted);
  $("verifyButton").disabled = !state.findings.some((f) => f.redacted);
  $("exportButton").disabled = !state.verified;
}
function renderPreview() {
  const preview = $("documentPreview");
  if (!state.documentText || state.file?.type === "application/pdf") return;
  let html = escapeHtml(state.documentText).replace(/\n/g, "<br />");
  [...state.findings].sort((a, b) => b.offset - a.offset).forEach((f) => {
    const escaped = escapeHtml(f.value);
    const replacement = f.redacted ? `<mark class="redacted">████████</mark>` : `<mark data-finding="${f.type}">${escaped}</mark>`;
    html = html.replace(escapeHtml(f.value), replacement);
  });
  preview.innerHTML = `<div class="document-topline"><span>CONFIDENTIAL</span><span>LOCAL DOCUMENT / PREVIEW</span></div><h3>${escapeHtml($("fileName").textContent.replace(/\.[^.]+$/, ""))}</h3><p>${html}</p><div class="document-footer"><span>PRIVACYVAULT · PRIVATE</span><span>LOCAL PREVIEW</span></div>`;
}
function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[char])); }
function inspectDocument() { return { status: "success", fileType: state.file?.name.split(".").pop() || "txt", pageCount: 1, documentSize: `${Math.max(1, Math.round((state.documentText.length || 6400) / 1024))}KB`, processingStatus: "ready" }; }
function scanDocumentPII({ categories } = {}) { classify(state.documentText || demoText); if (categories?.length) state.findings = state.findings.filter((f) => categories.includes(f.type)); renderFindings(); renderPreview(); return { status: "success", totalDetected: state.findings.length, findings: state.findings.map(({ id, type, page = 1, confidence }) => ({ id, type, page, location: "page 1, local region", confidence })) }; }
function applyRedactions({ targetIds, maskMode = "blackout" } = {}) { state.findings.filter((f) => !targetIds || targetIds.includes(f.id)).forEach((f) => { f.redacted = true; }); state.verified = false; renderFindings(); renderPreview(); return { status: "success", totalRedacted: state.findings.filter((f) => f.redacted).length, maskMode }; }
function sanitizedText() { return state.findings.reduce((result, f) => f.redacted ? result.split(f.value).join("████████") : result, state.documentText); }
function verifyRedaction({ categories } = {}) { const selectedCategories = categories?.length ? categories : patterns.map((p) => p.type); const remaining = []; const artifact = sanitizedText(); selectedCategories.forEach((type) => { const pattern = patterns.find((item) => item.type === type); if (!pattern) return; pattern.regex.lastIndex = 0; let match; while ((match = pattern.regex.exec(artifact))) remaining.push({ type }); }); state.verified = remaining.length === 0; $("verifiedStat").textContent = state.verified ? "✓" : "—"; $("processingBadge").textContent = state.verified ? "VERIFIED" : "READY"; $("processingBadge").classList.toggle("verified", state.verified); $("exportButton").disabled = !state.verified; renderFindings(); return { status: "verified", passed: state.verified, remainingFindings: remaining.length, categories: Object.fromEntries(selectedCategories.map((type) => [type, remaining.filter((f) => f.type === type).length])) }; }
function getFindingDetails({ findingId }) { const f = state.findings.find((item) => item.id === findingId); return f ? { id: f.id, type: f.type, page: 1, boundingBox: { x: 120, y: 180, width: 120, height: 20 }, confidence: f.confidence } : { status: "error", message: "Finding not found" }; }
function exportSanitizedDocument({ filename = "sanitized-document.txt" } = {}) { if (!state.verified) return { status: "blocked", verified: false, message: "Verification must pass before export." }; const content = state.findings.reduce((result, f) => result.split(f.value).join("████████"), state.documentText); const blob = new Blob([content], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href); return { status: "success", filename, verified: true }; }
function registerWebMCP() {
  const tools = { inspectDocument, scanDocumentPII, applyRedactions, verifyRedaction, getFindingDetails, exportSanitizedDocument };
  if (!document.modelContext?.registerTool) { $("nativeStatus").innerHTML = `<span class="status-dot" style="background:#e6a54f"></span> Demo mode`; $("modeLabel").textContent = "DEMO MODE"; Object.assign(window, tools); return false; }
  Object.entries(tools).forEach(([name, execute]) => document.modelContext.registerTool({ name, description: `Privacy-safe local ${name} operation. Never returns document contents or sensitive values.`, inputSchema: { type: "object", additionalProperties: true }, execute }));
  $("modeLabel").textContent = "NATIVE WEBMCP"; return true;
}
function loadText(file, text) { state.file = file; state.documentText = text; state.verified = false; $("fileName").textContent = file.name; $("fileMeta").textContent = `${file.type ? file.type.split("/").pop().toUpperCase() : "TEXT"} · ${(file.size / 1024).toFixed(1)} KB · LOCAL`; $("processingBadge").textContent = "READY"; $("processingBadge").classList.remove("verified"); state.findings = []; renderFindings(); renderPreview(); addActivity("Document loaded", `${file.name} · local memory`); toast("Document loaded locally — no upload made"); }
async function handleFile(file) { if (!file) return; if (file.name.toLowerCase().endsWith(".pdf")) { loadText(file, "PDF preview loaded locally. Use the browser's PDF text layer or demo mode to scan this artifact."); return; } loadText(file, await file.text()); }
function scanFromUI() { addActivity("inspectDocument", "Metadata only · contents withheld"); const result = scanDocumentPII(); addActivity("scanDocumentPII", `${result.totalDetected} privacy-safe findings`); toast(`${result.totalDetected} findings detected — values withheld from agent`); }
$("browseButton").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (event) => handleFile(event.target.files[0]));
$("dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropZone").classList.add("dragging"); });
$("dropZone").addEventListener("dragleave", () => $("dropZone").classList.remove("dragging"));
$("dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("dropZone").classList.remove("dragging"); handleFile(event.dataTransfer.files[0]); });
$("scanButton").addEventListener("click", scanFromUI);
$("loadDemoButton").addEventListener("click", () => { loadText(new File([demoText], "confidential-employment-contract.txt", { type: "text/plain" }), demoText); scanFromUI(); });
$("redactButton").addEventListener("click", () => { const ids = [...document.querySelectorAll(".finding input:checked")].map((input) => state.findings[Number(input.dataset.index)].id); const result = applyRedactions({ targetIds: ids, maskMode: "blackout" }); addActivity("applyRedactions", `${result.totalRedacted} local redactions`); toast(`${result.totalRedacted} findings masked locally`); });
$("verifyButton").addEventListener("click", () => { const result = verifyRedaction({}); addActivity("verifyRedaction", result.passed ? "0 findings remaining · passed" : `${result.remainingFindings} findings remain · blocked`); toast(result.passed ? "Verification passed — export unlocked" : "Verification failed — export remains blocked"); });
 $("exportButton").addEventListener("click", () => { const result = exportSanitizedDocument({ filename: "privacyvault-sanitized-document.txt" }); if (result.status === "success") { addActivity("exportSanitizedDocument", `${result.filename} · local download`); toast("Verified copy downloaded locally"); } });
registerWebMCP();
