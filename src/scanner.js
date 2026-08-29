import { detectCandidates } from "./detectors.js";

export function scanText(text, categories, onProgress) {
  if (typeof Worker === "undefined") {
    return Promise.resolve(detectCandidates(text, categories, onProgress));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.kind === "progress") onProgress?.(data.value);
      if (data.kind === "result") {
        worker.terminate();
        resolve(data.findings);
      }
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };
    worker.postMessage({ text, categories });
  });
}
