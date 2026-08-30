export function remapFindingOffsets(findings, nextText) {
  const used = [];
  const dropped = [];
  for (const finding of findings) {
    if (finding.type === "manual_rectangle" && finding.boundingBox) continue;
    const value = finding.value;
    if (typeof value !== "string" || value.length === 0) {
      dropped.push(finding.id);
      continue;
    }
    let index = -1;
    let from = 0;
    while (from <= nextText.length) {
      index = nextText.indexOf(value, from);
      if (index === -1) break;
      const end = index + value.length;
      const overlap = used.some(([start, stop]) => start < end && stop > index);
      if (!overlap) break;
      from = index + 1;
      index = -1;
    }
    if (index === -1) {
      dropped.push(finding.id);
      continue;
    }
    used.push([index, index + value.length]);
    finding.charStart = index;
    finding.charEnd = index + value.length;
    finding.offset = index;
    finding.length = value.length;
  }
  return dropped;
}

export function readEditableDocumentText(root) {
  const clone = root.cloneNode(true);
  for (const mark of clone.querySelectorAll("mark[data-original]")) {
    mark.replaceWith(root.ownerDocument.createTextNode(mark.dataset.original));
  }
  return clone.innerText.replace(/\u00a0/g, " ");
}
