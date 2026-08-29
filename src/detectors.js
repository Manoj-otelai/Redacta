import { validateCandidate } from "./validators.js";
import { confidenceScore } from "./scoring.js";

export const DETECTOR_DEFINITIONS = [
  { type: "private_key", label: "Private key", color: "#bd536e", regex: /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]+ PRIVATE KEY-----/g },
  { type: "db_connection_string", label: "DB connection", color: "#a35c83", regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi },
  { type: "bearer_token", label: "Bearer token", color: "#c87538", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi },
  { type: "credit_card", label: "Credit card", color: "#cf8a32", regex: /\b(?:\d[ -]?){13,19}\b/g },
  { type: "ssn", label: "SSN", color: "#e86b56", regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  { type: "email", label: "Email", color: "#6c74c9", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: "phone", label: "Phone", color: "#9a68a8", regex: /(?:\(\d{3}\)|\d{3})[- .]\d{3}[- .]\d{4}\b/g },
  { type: "api_key", label: "API key", color: "#bd536e", regex: /\b(?:sk_(?:live|test)|pk_(?:live|test)|gh[pousr]_|AKIA)[A-Za-z0-9_-]{8,}\b/g },
];

const priority = new Map(DETECTOR_DEFINITIONS.map((item, index) => [item.type, index]));
export const detectorTypes = DETECTOR_DEFINITIONS.map(({ type }) => type);

export function detectCandidates(text, categories = detectorTypes) {
  const allowed = new Set(categories);
  const candidates = [];
  for (const definition of DETECTOR_DEFINITIONS) {
    if (!allowed.has(definition.type)) continue;
    definition.regex.lastIndex = 0;
    let match;
    while ((match = definition.regex.exec(text))) {
      const value = match[0];
      const validated = validateCandidate(definition.type, value);
      if (definition.type === "credit_card" && !validated) continue;
      candidates.push({
        type: definition.type,
        label: definition.label,
        color: definition.color,
        value,
        offset: match.index,
        length: value.length,
        confidence: confidenceScore({ candidate: true, validated, type: definition.type }),
        validated,
      });
    }
  }
  candidates.sort((left, right) => left.offset - right.offset || priority.get(left.type) - priority.get(right.type));
  return candidates.filter((candidate, index, all) => !all.some((other, otherIndex) => {
    if (index === otherIndex || other.offset > candidate.offset || other.offset + other.length <= candidate.offset) return false;
    return priority.get(other.type) <= priority.get(candidate.type);
  }));
}

export function syntheticReplacement(type, value) {
  switch (type) {
    case "ssn": return "219-48-7631";
    case "credit_card": return "4242 4242 4242 4242";
    case "email": return "redacted@example.invalid";
    case "phone": return "(202) 555-0100";
    case "api_key": return value.startsWith("gh") ? "ghp_REDACTED_LOCAL_ONLY" : "sk_test_REDACTED_LOCAL_ONLY";
    case "bearer_token": return "Bearer REDACTED_LOCAL_ONLY_TOKEN";
    case "db_connection_string": return `${String(value).split("://", 1)[0]}://user:redacted@localhost/database`;
    case "private_key": return "-----BEGIN PRIVATE KEY-----\nREDACTED LOCAL KEY\n-----END PRIVATE KEY-----";
    default: return "[REDACTED]";
  }
}
