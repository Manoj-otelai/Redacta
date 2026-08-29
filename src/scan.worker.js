import { detectCandidates } from "./detectors.js";

self.onmessage = ({ data }) => {
  const { text, categories } = data;
  self.postMessage({ kind: "progress", value: 20 });
  const findings = detectCandidates(text, categories);
  self.postMessage({ kind: "progress", value: 100 });
  self.postMessage({ kind: "result", findings });
};
