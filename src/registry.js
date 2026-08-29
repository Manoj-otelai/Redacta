const SAFE_FIELDS = ["id", "type", "page", "location", "boundingBox", "charStart", "charEnd", "confidence", "status", "origin"];

export function createFindingRegistry() {
  const records = new Map();
  let sequence = 0;
  const project = (record) => Object.fromEntries(SAFE_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));
  return {
    replace(candidates, locate = () => ({})) {
      records.clear();
      sequence = 0;
      for (const candidate of candidates) {
        sequence += 1;
        records.set(`finding_${String(sequence).padStart(3, "0")}`, {
          ...candidate,
          id: `finding_${String(sequence).padStart(3, "0")}`,
          ...locate(candidate),
          status: "pending",
          origin: "scan",
        });
      }
    },
    all() { return [...records.values()]; },
    get(id) { return records.get(id); },
    markRedacted(ids) {
      const selected = ids ? new Set(ids) : null;
      for (const record of records.values()) {
        if (selected ? selected.has(record.id) : record.status !== "excluded") record.status = "redacted";
      }
    },
    exclude(ids) {
      for (const record of records.values()) if (ids.includes(record.id) && record.status !== "redacted") record.status = "excluded";
    },
    restore(ids) {
      const selected = ids ? new Set(ids) : null;
      for (const record of records.values()) if (!selected || selected.has(record.id)) record.status = "pending";
    },
    addManual(finding) {
      sequence += 1;
      const id = `finding_${String(sequence).padStart(3, "0")}`;
      const start = Number.isInteger(finding.charStart) ? finding.charStart : undefined;
      const end = Number.isInteger(finding.charEnd) ? finding.charEnd : undefined;
      const length = Number.isInteger(finding.length) && finding.length > 0
        ? finding.length
        : start !== undefined && end !== undefined && end > start ? end - start : undefined;
      const record = {
        ...finding,
        id,
        type: finding.type || "manual",
        confidence: 1,
        status: "pending",
        origin: "manual",
        ...(start === undefined ? {} : { charStart: start }),
        ...(end === undefined ? {} : { charEnd: end }),
        ...(start === undefined ? {} : { offset: finding.offset ?? start }),
        ...(length === undefined ? {} : { length }),
        value: finding.value ?? "",
      };
      records.set(id, record);
      return record;
    },
    project(record) { return record ? project(record) : null; },
    projectAll() { return [...records.values()].map(project); },
    rawValue(id) { return records.get(id)?.value; },
    active() { return [...records.values()].filter((record) => record.status === "redacted"); },
    selected() { return [...records.values()].filter((record) => record.status !== "excluded"); },
  };
}
