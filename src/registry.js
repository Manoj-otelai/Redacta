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
      for (const record of records.values()) if (!selected || selected.has(record.id)) record.status = "redacted";
    },
    exclude(ids) {
      for (const record of records.values()) if (ids.includes(record.id)) record.status = "excluded";
    },
    project(record) { return record ? project(record) : null; },
    projectAll() { return [...records.values()].map(project); },
    rawValue(id) { return records.get(id)?.value; },
    active() { return [...records.values()].filter((record) => record.status === "redacted"); },
  };
}
