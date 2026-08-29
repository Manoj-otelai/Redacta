import "./pdfCompat.js";
import { syntheticReplacement } from "./detectors.js";

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
  const size = bytes.byteLength;
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  let text = "";
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const reconstructed = reconstructPageText(content.items);
    const pageText = reconstructed.text;
    const items = reconstructed.items;
    const pageStart = text.length;
    text += pageText;
    pages.push({ page, pageNumber, width: viewport.width, height: viewport.height, text: pageText, items, start: pageStart });
  }
  return { kind: "pdf", format: "pdf", name: file.name, type: "application/pdf", size, sizeLabel: formatBytes(size), pageCount: pdf.numPages, bytes, text, pages, pdf };
}

export function locatePdfFinding(document, candidate) {
  const pageInfo = document.pages.find((page) => candidate.offset >= page.start && candidate.offset < page.start + page.text.length)
    ?? document.pages[document.pages.length - 1];
  const localStart = Math.max(0, candidate.offset - pageInfo.start);
  const overlaps = pageInfo.items.filter((entry) => entry.start < localStart + candidate.length && entry.end > localStart);
  const itemInfo = overlaps[0] ?? pageInfo.items[0];
  if (!itemInfo) return { page: pageInfo.pageNumber, location: `page ${pageInfo.pageNumber}`, boundingBox: null };
  const boxes = (overlaps.length ? overlaps : [itemInfo]).map(({ item }) => itemBox(item, pageInfo.height));
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    page: pageInfo.pageNumber,
    location: `page ${pageInfo.pageNumber}, x ${Math.round(x)}, y ${Math.round(y)}`,
    boundingBox: { x, y, width: right - x, height: bottom - y },
  };
}

export function reconstructPageText(items) {
  const positioned = items.map((item, index) => ({
    item,
    index,
    x: item.transform?.[4] || 0,
    y: item.transform?.[5] || 0,
    height: Math.abs(item.transform?.[3] || item.height || 12),
  }));
  const lines = [];
  for (const entry of positioned) {
    let line = lines.find((candidate) => Math.abs(candidate.y - entry.y) <= Math.max(3, entry.height * 0.45));
    if (!line) {
      line = { y: entry.y, items: [] };
      lines.push(line);
    }
    line.items.push(entry);
  }
  lines.sort((left, right) => right.y - left.y);
  const result = [];
  const mapped = [];
  let offset = 0;
  for (const [lineIndex, line] of lines.entries()) {
    line.items.sort((left, right) => left.x - right.x || left.index - right.index);
    if (lineIndex) {
      result.push("\n");
      offset += 1;
    }
    for (const [itemIndex, entry] of line.items.entries()) {
      const previous = line.items[itemIndex - 1];
      const gap = previous ? entry.x - (previous.x + (previous.item.width || 0)) : 0;
      if (previous && gap > Math.max(2, entry.height * 0.2)) {
        result.push(" ");
        offset += 1;
      }
      const start = offset;
      result.push(entry.item.str);
      offset += entry.item.str.length;
      mapped.push({ start, end: offset, item: entry.item });
    }
  }
  return { text: `${result.join("")}\n`, items: mapped };
}

function itemBox(item, pageHeight) {
  const fontSize = Math.abs(item.transform?.[3] || item.height || 12);
  const x = (item.transform?.[4] || 0) - 2;
  const y = pageHeight - (item.transform?.[5] || fontSize) - fontSize - 2;
  return { x, y, width: (item.width || fontSize * Math.max(1, item.str.length) * 0.5) + 4, height: fontSize * 1.2 + 4 };
}

function formatBytes(size) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function syntheticGroups(pageInfo, findings) {
  const indexes = new Map(pageInfo.items.map((entry, index) => [entry, index]));
  const groups = new Map();
  for (const finding of findings) {
    const localStart = finding.offset - pageInfo.start;
    const overlaps = pageInfo.items.filter((entry) => entry.start < localStart + finding.length && entry.end > localStart);
    if (!overlaps.length) continue;
    const key = overlaps.map((entry) => indexes.get(entry)).join(",");
    const group = groups.get(key) || { entries: overlaps, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  return groups.values();
}

export function syntheticRange(localStart, length, entries) {
  let cursor = 0;
  let start = null;
  let end = null;
  const findingEnd = localStart + length;
  for (const entry of entries) {
    const overlapStart = Math.max(localStart, entry.start);
    const overlapEnd = Math.min(findingEnd, entry.end);
    if (overlapEnd > overlapStart) {
      start ??= cursor + overlapStart - entry.start;
      end = cursor + overlapEnd - entry.start;
    }
    cursor += entry.end - entry.start;
  }
  return start === null || end === null ? null : { start, end };
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
    const active = registry.active().filter((item) => item.page === pageInfo.pageNumber);
    if (maskMode === "blackout") {
      for (const finding of active) {
        const box = finding.boundingBox;
        if (!box) continue;
        context.fillStyle = "#111816";
        context.fillRect(box.x * 1.5, box.y * 1.5, box.width * 1.5, box.height * 1.5);
      }
    } else {
      for (const group of syntheticGroups(pageInfo, active)) {
        const entries = [...group.entries].sort((left, right) => left.start - right.start);
        const redacted = group.findings.filter((finding) => finding.status === "redacted");
        if (!redacted.length) continue;
        let text = entries.map((entry) => entry.item.str).join("");
        let safe = true;
        for (const finding of redacted.sort((left, right) => right.offset - left.offset)) {
          const range = syntheticRange(finding.offset - pageInfo.start, finding.length, entries);
          if (!range) {
            safe = false;
            continue;
          }
          text = `${text.slice(0, range.start)}${syntheticReplacement(finding.type, finding.value)}${text.slice(range.end)}`;
        }
        const boxes = entries.map(({ item }) => itemBox(item, pageInfo.height));
        const x = Math.min(...boxes.map((box) => box.x)) * 1.5;
        const y = Math.min(...boxes.map((box) => box.y)) * 1.5;
        const right = Math.max(...boxes.map((box) => box.x + box.width)) * 1.5;
        const bottom = Math.max(...boxes.map((box) => box.y + box.height)) * 1.5;
        const width = right - x;
        const height = bottom - y;
        const leaked = redacted.some((finding) => (
          typeof finding.value === "string"
          && finding.value.length > 0
          && finding.value !== syntheticReplacement(finding.type, finding.value)
          && text.includes(finding.value)
        ));
        if (!safe || leaked) {
          context.fillStyle = "#111816";
          context.fillRect(x, y, width, height);
          continue;
        }
        context.fillStyle = "#ffffff";
        context.fillRect(x, y, width, height);
        let fontSize = Math.max(10, height * 0.65);
        const availableWidth = Math.max(0, width - 4);
        context.font = `${fontSize}px sans-serif`;
        while (fontSize > 7 && context.measureText(text).width > availableWidth) {
          fontSize -= 1;
          context.font = `${fontSize}px sans-serif`;
        }
        if (context.measureText(text).width <= availableWidth) {
          context.fillStyle = "#111816";
          context.fillText(text, x + 2, y + height * 0.75);
        } else {
          context.fillStyle = "#111816";
          context.fillRect(x, y, width, height);
        }
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
  const font = await output.embedFont("Helvetica");
  const pages = [
    [
      "CONFIDENTIAL - REDACTA DEMO / PAGE 1",
      "Employment Agreement - Northstar Labs",
      "Employee SSN: 123-45-6789",
      "Benefits contact: jordan.one@northstar.example",
      "Payroll card: 4111 1111 1111 1111",
      "Integration key: sk_live_NORTHSTAR_01ab23cd",
    ],
    [
      "CONFIDENTIAL - REDACTA DEMO / PAGE 2",
      "Employee SSN: 234-56-7890",
      "Benefits contact: jordan.two@northstar.example",
      "Payroll card: 5500 0000 0000 0004",
      "Integration key: sk_test_NORTHSTAR_02ef45gh",
    ],
    [
      "CONFIDENTIAL - REDACTA DEMO / PAGE 3",
      "Employee SSN: 345-67-8901",
      "Employee SSN: 456-78-9012",
      "Benefits contact: jordan.three@northstar.example",
      "Payroll card: 5555 5555 5555 4444",
      "HR contact: payroll@northstar.example",
    ],
    [
      "CONFIDENTIAL - REDACTA DEMO / PAGE 4",
      "Employee SSN: 567-89-0123",
      "Employee SSN: 678-90-1234",
      "Employee SSN: 789-01-2345",
      "HR contact: security@northstar.example",
    ],
  ];
  for (const lines of pages) {
    const page = output.addPage([612, 792]);
    lines.forEach((line, index) => page.drawText(line, { x: 54, y: 720 - index * 42, size: 16, font }));
  }
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
