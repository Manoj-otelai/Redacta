import { detectCandidates } from "./detectors.js";

self.onmessage = ({ data }) => {
  const { text, categories, customPatterns } = data;
  const findings = detectCandidates(text, categories, (value) => self.postMessage({ kind: "progress", value }), customPatterns);
  self.postMessage({ kind: "result", findings });
};
