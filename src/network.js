let uploadCount = 0;
let installed = false;

export function installNetworkMonitor(onChange = () => {}) {
  if (installed || typeof window === "undefined") return () => uploadCount;
  installed = true;
  const count = () => {
    uploadCount += 1;
    onChange(uploadCount);
  };
  const fetchImpl = window.fetch;
  if (fetchImpl) window.fetch = (...args) => { count(); return fetchImpl(...args); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function monitoredOpen(...args) {
    this.addEventListener("loadstart", count, { once: true });
    return open.apply(this, args);
  };
  const beacon = navigator.sendBeacon;
  if (beacon) navigator.sendBeacon = (...args) => { count(); return beacon.apply(navigator, args); };
  return () => uploadCount;
}

export function getNetworkUploadCount() {
  return uploadCount;
}
