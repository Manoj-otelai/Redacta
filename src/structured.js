function parseJsonLeaves(text) {
  let index = 0;
  const leaves = [];

  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };

  const parseString = () => {
    if (text[index] !== '"') throw new Error("Expected string");
    const start = index + 1;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        const end = index;
        const token = text.slice(start - 1, end + 1);
        let value;
        try {
          value = JSON.parse(token);
        } catch {
          throw new Error("Invalid string");
        }
        index += 1;
        return { start, end, value: text.slice(start, end), decoded: value };
      }
      if (text.charCodeAt(index) < 0x20) throw new Error("Invalid string");
      index += 1;
    }
    throw new Error("Unterminated string");
  };

  const parsePrimitive = () => {
    const start = index;
    while (index < text.length && !/[\s,[\]{}]/.test(text[index])) index += 1;
    const token = text.slice(start, index);
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) {
      throw new Error("Invalid primitive");
    }
  };

  const parseValue = (path) => {
    skipWhitespace();
    const token = text[index];
    if (token === "{") {
      index += 1;
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString().decoded;
        skipWhitespace();
        if (text[index] !== ":") throw new Error("Expected colon");
        index += 1;
        const childPath = path ? `${path}.${key}` : key;
        parseValue(childPath);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error("Expected comma");
        index += 1;
      }
      throw new Error("Unterminated object");
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      const arrayPath = path ? `${path}[]` : "[]";
      while (index < text.length) {
        parseValue(arrayPath);
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error("Expected comma");
        index += 1;
      }
      throw new Error("Unterminated array");
    }
    if (token === '"') {
      const string = parseString();
      leaves.push({ path, valueStart: string.start, valueEnd: string.end, value: string.value });
      return;
    }
    parsePrimitive();
  };

  try {
    parseValue("");
    skipWhitespace();
    if (index !== text.length) return [];
    return leaves;
  } catch {
    return [];
  }
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let index = 0;
  let cellStart = 0;

  const finishRow = () => {
    rows.push(row);
    row = [];
  };

  while (index <= text.length) {
    if (index === text.length) {
      if (cellStart < index || row.length) {
        row.push({ start: cellStart, end: index, value: text.slice(cellStart, index) });
        finishRow();
      }
      break;
    }

    if (text[index] === '"') {
      const valueStart = index + 1;
      index += 1;
      let valueEnd = -1;
      while (index < text.length) {
        if (text[index] !== '"') {
          index += 1;
          continue;
        }
        if (text[index + 1] === '"') {
          index += 2;
          continue;
        }
        valueEnd = index;
        index += 1;
        break;
      }
      if (valueEnd < 0) return [];
      if (index < text.length && ![",", "\r", "\n"].includes(text[index])) return [];
      const value = text.slice(valueStart, valueEnd);
      row.push({ start: valueStart, end: valueEnd, value, decoded: value.replaceAll('""', '"') });
    } else {
      while (index < text.length && text[index] !== "," && text[index] !== "\r" && text[index] !== "\n") index += 1;
      const value = text.slice(cellStart, index);
      row.push({ start: cellStart, end: index, value, decoded: value });
    }

    if (index === text.length) {
      finishRow();
      break;
    }
    if (text[index] === ",") {
      index += 1;
      cellStart = index;
      continue;
    }
    if (text[index] === "\r" && text[index + 1] === "\n") index += 2;
    else index += 1;
    finishRow();
    cellStart = index;
  }
  return rows;
}

function parseCsvLeaves(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows[0].map((cell, index) => cell.decoded.trim() || `column_${index + 1}`);
  const leaves = [];
  for (const row of rows.slice(1)) {
    for (let index = 0; index < headers.length; index += 1) {
      const cell = row[index] ?? { start: row.at(-1)?.end ?? text.length, end: row.at(-1)?.end ?? text.length, value: "" };
      leaves.push({
        path: headers[index],
        valueStart: cell.start,
        valueEnd: cell.end,
        value: cell.value,
      });
    }
  }
  return leaves;
}

function structuredLeaves(document) {
  if (!document || document.kind === "pdf" || document.format === "txt") return [];
  if (document.format === "json") return parseJsonLeaves(document.text);
  if (document.format === "csv") return parseCsvLeaves(document.text);
  return [];
}

export function structuredFields(document) {
  const fields = new Map();
  for (const leaf of structuredLeaves(document)) {
    fields.set(leaf.path, (fields.get(leaf.path) ?? 0) + 1);
  }
  return [...fields].map(([field, occurrences]) => ({ field, occurrences }));
}

export function structuredFieldRanges(document, field) {
  return structuredLeaves(document)
    .filter((leaf) => leaf.path === field)
    .map(({ valueStart: start, valueEnd: end, value }) => ({ start, end, value }));
}
