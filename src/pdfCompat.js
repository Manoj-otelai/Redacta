if (typeof globalThis.Iterator !== "function") {
  globalThis.Iterator = function Iterator() {};
  globalThis.Iterator.prototype = {};
}

if (typeof Uint8Array.prototype.toHex !== "function") {
  Uint8Array.prototype.toHex = function toHex() {
    return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
}

if (typeof Uint8Array.prototype.toBase64 !== "function") {
  Uint8Array.prototype.toBase64 = function toBase64() {
    let binary = "";
    for (const byte of this) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
}

if (typeof Map.prototype.getOrInsertComputed !== "function") {
  Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, callback) {
    if (!this.has(key)) this.set(key, callback(key));
    return this.get(key);
  };
}

if (typeof Map.prototype.getOrInsert !== "function") {
  Map.prototype.getOrInsert = function getOrInsert(key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  };
}
