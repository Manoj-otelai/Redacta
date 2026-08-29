import "./pdfCompat.js";

let pdfjsLib;
let PDFDocument;
async function loadEngines() {
  pdfjsLib ??= await import("../vendor/pdfjs/pdf.mjs");
  PDFDocument ??= (await import("../vendor/pdf-lib/pdf-lib.esm.js")).PDFDocument;
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).toString();
}

export async function loadPdfDocument(file) {
  await loadEngines();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  let text = "";
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let pageText = "";
    const items = content.items.map((item) => {
      const start = pageText.length;
      pageText += `${item.str}\n`;
      return { start, end: pageText.length - 1, item };
    });
    const pageStart = text.length;
    text += pageText;
    pages.push({ page, pageNumber, width: viewport.width, height: viewport.height, text: pageText, items, start: pageStart });
  }
  return { kind: "pdf", name: file.name, type: "application/pdf", size: bytes.byteLength, pageCount: pdf.numPages, bytes, text, pages, pdf };
}

export function locatePdfFinding(document, candidate) {
  const pageInfo = document.pages.find((page) => candidate.offset >= page.start && candidate.offset < page.start + page.text.length)
    ?? document.pages[document.pages.length - 1];
  const localStart = Math.max(0, candidate.offset - pageInfo.start);
  const itemInfo = pageInfo.items.find((entry) => localStart >= entry.start && localStart <= entry.end) ?? pageInfo.items[0];
  if (!itemInfo) return { page: pageInfo.pageNumber, location: `page ${pageInfo.pageNumber}`, boundingBox: null };
  const { item } = itemInfo;
  const charsBefore = Math.max(0, localStart - itemInfo.start);
  const ratio = item.str.length ? charsBefore / item.str.length : 0;
  const fontSize = Math.abs(item.transform?.[3] || 12);
  const x = (item.transform?.[4] || 0) + (item.width || fontSize * item.str.length * 0.5) * ratio;
  const y = pageInfo.height - (item.transform?.[5] || fontSize) - fontSize;
  return {
    page: pageInfo.pageNumber,
    location: `page ${pageInfo.pageNumber}, x ${Math.round(x)}, y ${Math.round(y)}`,
    boundingBox: { x, y, width: Math.max(fontSize * 2, (item.width || fontSize * candidate.length * 0.5) * candidate.length / Math.max(1, item.str.length)), height: fontSize * 1.2 },
  };
}

export async function rasterizePdf(pdfDocument, registry, maskMode = "blackout") {
  await loadEngines();
  if (typeof globalThis.document?.createElement !== "function") throw new Error("PDF rasterization requires a browser canvas.");
  const output = await PDFDocument.create();
  for (const pageInfo of pdfDocument.pages) {
    const viewport = pageInfo.page.getViewport({ scale: 1.5 });
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await pageInfo.page.render({ canvasContext: context, viewport }).promise;
    for (const finding of registry.active().filter((item) => item.page === pageInfo.pageNumber)) {
      const box = finding.boundingBox;
      if (!box) continue;
      const x = box.x * 1.5;
      const y = box.y * 1.5;
      const width = box.width * 1.5;
      const height = box.height * 1.5;
      context.fillStyle = maskMode === "blackout" ? "#111816" : "#ffffff";
      context.fillRect(x, y, width, height);
      if (maskMode === "synthetic_replacement") {
        context.fillStyle = "#111816";
        context.font = `${Math.max(10, height * 0.65)}px sans-serif`;
        context.fillText("[REDACTED]", x + 2, y + height * 0.75);
      }
    }
    const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not rasterize PDF page.")), "image/png"));
    const image = await output.embedPng(new Uint8Array(await png.arrayBuffer()));
    const outputPage = output.addPage([pageInfo.width, pageInfo.height]);
    outputPage.drawImage(image, { x: 0, y: 0, width: pageInfo.width, height: pageInfo.height });
  }
  return new Blob([await output.save()], { type: "application/pdf" });
}

export async function createDemoPdf() {
  await loadEngines();
  const output = await PDFDocument.create();
  const page = output.addPage([612, 792]);
  const font = await output.embedFont("Helvetica");
  const lines = [
    "CONFIDENTIAL - PRIVACYVAULT DEMO",
    "Employment Agreement",
    "Employee identification: 123-45-6789",
    "Contact: jordan.lee@northstar.example  (415) 555-0198",
    "Payroll card: 4111 1111 1111 1111",
    "Integration key: sk_live_51NORTHSTAR_8df7a",
  ];
  lines.forEach((line, index) => page.drawText(line, { x: 54, y: 720 - index * 42, size: 16, font }));
  return new File([await output.save()], "confidential-employment-contract.pdf", { type: "application/pdf" });
}

export async function extractPdfText(bytes) {
  await loadEngines();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  let text = "";
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    text += `${content.items.map((item) => item.str).join("\n")}\n`;
  }
  return text;
}
