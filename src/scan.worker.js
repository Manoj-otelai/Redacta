import { detectCandidates } from "./detectors.js";

self.onmessage = ({ data }) => {
  const { text, categories } = data;
  const findings = detectCandidates(text, categories, (value) => self.postMessage({ kind: "progress", value }));
  self.postMessage({ kind: "result", findings });
};
