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

export const detectorTypes = DETECTOR_DEFINITIONS.map(({ type }) => type);
export const MAX_CUSTOM_PATTERNS = 5;

const customPatternColor = "#b28a62";
const alternateSyntheticReplacements = {
  ssn: "219-48-7642",
  credit_card: "4000 0000 0000 0010",
  email: "user_beta@redacta.local",
  phone: "(202) 555-0111",
};
const customPatternProbe = ("Alpha 123 !@# \tBeta 456\nGamma 789, Delta.\r\n").repeat(45);
const globalFlags = (flags) => flags.includes("g") ? flags : `${flags}g`;

function primarySyntheticReplacement(type, value) {
  switch (type) {
    case "ssn": return "219-48-7631";
    case "credit_card": return "4000 0000 0000 0002";
    case "email": return "user_alpha@redacta.local";
    case "phone": return "(202) 555-0100";
    case "api_key": return value.startsWith("gh") ? "ghp_REDACTED_LOCAL_ONLY" : "sk_test_REDACTED_LOCAL_ONLY";
    case "bearer_token": return "Bearer REDACTED_LOCAL_ONLY_TOKEN";
    case "db_connection_string": return `${String(value).split("://", 1)[0]}://user:redacted@localhost/database`;
    case "private_key": return "-----BEGIN PRIVATE KEY-----\nREDACTED LOCAL KEY\n-----END PRIVATE KEY-----";
    default: return "[REDACTED]";
  }
}

export function compileCustomPatterns(patterns = []) {
  return patterns.map(({ name, source, flags = "" }) => ({
    type: `custom:${name}`,
    label: name,
    color: customPatternColor,
    regex: new RegExp(source, globalFlags(flags)),
  }));
}

export function detectCandidates(text, categories = detectorTypes, onProgress, customPatterns = []) {
  const allowed = new Set(categories);
  const candidates = [];
  const customDefinitions = compileCustomPatterns(customPatterns);
  const definitions = [...DETECTOR_DEFINITIONS, ...customDefinitions]
    .filter((definition) => allowed.has(definition.type));
  const priority = new Map([
    ...DETECTOR_DEFINITIONS.map((definition, index) => [definition.type, index]),
    ...customDefinitions.map((definition, index) => [definition.type, DETECTOR_DEFINITIONS.length + index]),
  ]);
  for (const [definitionIndex, definition] of definitions.entries()) {
    definition.regex.lastIndex = 0;
    let match;
    while ((match = definition.regex.exec(text))) {
      const value = match[0];
      if (value.length === 0) {
        definition.regex.lastIndex += 1;
        continue;
      }
      const custom = definition.type.startsWith("custom:");
      const validated = custom ? false : validateCandidate(definition.type, value);
      if (definition.type === "credit_card" && !validated) continue;
      candidates.push({
        type: definition.type,
        label: definition.label,
        color: definition.color,
        value,
        offset: match.index,
        length: value.length,
        confidence: custom ? 0.6 : confidenceScore({ candidate: true, validated, type: definition.type }),
        validated,
      });
    }
    onProgress?.(Math.round(((definitionIndex + 1) / Math.max(1, definitions.length)) * 100));
  }
  candidates.sort((left, right) => left.offset - right.offset || priority.get(left.type) - priority.get(right.type));
  return candidates.filter((candidate, index, all) => !all.some((other, otherIndex) => {
    if (index === otherIndex || other.offset > candidate.offset || other.offset + other.length <= candidate.offset) return false;
    return priority.get(other.type) <= priority.get(candidate.type);
  }));
}

export function syntheticPlaceholderCandidates(type, value) {
  return [...new Set([
    primarySyntheticReplacement(type, value),
    alternateSyntheticReplacements[type],
    "[REDACTED]",
  ].filter((candidate) => candidate !== undefined))];
}

export function syntheticReplacement(type, value, avoid = new Set()) {
  const original = String(value);
  const replacement = syntheticPlaceholderCandidates(type, value)
    .find((candidate) => candidate !== original && !avoid.has(candidate));
  return replacement ?? "[REDACTED]";
}

export function validateCustomPattern({ name, pattern, flags = "" } = {}, existingNames = []) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{1,31}$/i.test(name)) {
    return { ok: false, message: "Pattern name must be 2-32 letters, numbers, or underscores and start with a letter." };
  }
  if (detectorTypes.some((type) => type.toLowerCase() === name.toLowerCase())
    || existingNames.some((existingName) => String(existingName).toLowerCase() === name.toLowerCase())) {
    return { ok: false, message: "Pattern name is already in use." };
  }
  if (typeof pattern !== "string" || pattern.length < 1 || pattern.length > 200) {
    return { ok: false, message: "Pattern must be between 1 and 200 characters." };
  }
  if (typeof flags !== "string" || /[^imsu]/.test(flags)) {
    return { ok: false, message: "Pattern flags may only use i, m, s, and u." };
  }
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return { ok: false, message: "Pattern could not be compiled." };
  }
  if (regex.test("")) return { ok: false, message: "Pattern must not match empty text." };
  const probe = new RegExp(pattern, globalFlags(flags));
  const started = performance.now();
  probe.lastIndex = 0;
  let match;
  while ((match = probe.exec(customPatternProbe))) {
    if (performance.now() - started > 250) return { ok: false, message: "Pattern is too slow to run locally." };
    if (match[0].length === 0) return { ok: false, message: "Pattern must not match empty text." };
  }
  if (performance.now() - started > 250) return { ok: false, message: "Pattern is too slow to run locally." };
  return { ok: true, value: { name, source: pattern, flags } };
}
