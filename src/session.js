export const SESSION_TOKEN_KEY = "redacta.session.token";
export const SESSION_CHANNEL_NAME = "redacta-session";
export const WORKSPACE_VERSION = 1;

export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array();
}

export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

export function createMemoryStore() {
  const records = new Map();
  return {
    async get(key) {
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    async put(key, value) {
      records.set(key, structuredClone(value));
    },
    async delete(key) {
      records.delete(key);
    },
    async keys() {
      return [...records.keys()];
    },
  };
}

export function createIndexedDbStore(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return createMemoryStore();
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("redacta-session", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("workspaces")) request.result.createObjectStore("workspaces");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const withStore = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("workspaces", mode);
        const request = fn(tx.objectStore("workspaces"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    async get(key) {
      return await withStore("readonly", (store) => store.get(key)) ?? null;
    },
    put(key, value) {
      return withStore("readwrite", (store) => store.put(value, key));
    },
    delete(key) {
      return withStore("readwrite", (store) => store.delete(key));
    },
    async keys() {
      return await withStore("readonly", (store) => store.getAllKeys()) ?? [];
    },
  };
}

function wait(ms) {
  return ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function resolveSessionStorage(sessionStorage) {
  if (sessionStorage) return sessionStorage;
  try {
    const storage = globalThis.sessionStorage;
    storage.getItem(SESSION_TOKEN_KEY);
    return storage;
  } catch {
    return createMemoryStorage();
  }
}

export function createSession({
  sessionStorage,
  store,
  createChannel = () => (typeof BroadcastChannel === "function" ? new BroadcastChannel(SESSION_CHANNEL_NAME) : null),
  randomId = () => globalThis.crypto?.randomUUID?.() ?? `sess_${Date.now()}_${Math.random().toString(16).slice(2)}`,
  now = () => Date.now(),
  pingWaitMs = 60,
} = {}) {
  const storage = resolveSessionStorage(sessionStorage);
  const records = store ?? createIndexedDbStore();
  let token = storage.getItem(SESSION_TOKEN_KEY);
  const channel = createChannel?.() ?? null;
  if (channel) {
    channel.onmessage = (event) => {
      if (event.data?.type === "ping" && token) channel.postMessage({ type: "alive", token });
    };
  }

  function ensureToken() {
    if (!token) {
      token = randomId();
      storage.setItem(SESSION_TOKEN_KEY, token);
    }
    return token;
  }

  async function liveTokens() {
    const live = new Set(token ? [token] : []);
    const probe = createChannel?.() ?? null;
    if (!probe) return live;
    probe.onmessage = (event) => {
      if (event.data?.type === "alive" && event.data.token) live.add(event.data.token);
    };
    probe.postMessage({ type: "ping" });
    await wait(pingWaitMs);
    probe.close?.();
    return live;
  }

  async function prune(live) {
    for (const key of await records.keys()) {
      if (!live.has(key)) await records.delete(key);
    }
  }

  return {
    async restore() {
      token = storage.getItem(SESSION_TOKEN_KEY);
      const live = await liveTokens();
      await prune(live);
      if (!token) return null;
      const record = await records.get(token);
      if (!record?.workspace?.document || record.workspace.version !== WORKSPACE_VERSION) {
        if (record) await records.delete(token);
        return null;
      }
      return record.workspace;
    },
    async save(workspace) {
      const id = ensureToken();
      await records.put(id, {
        token: id,
        savedAt: now(),
        workspace: { ...workspace, version: WORKSPACE_VERSION },
      });
    },
    async discard() {
      if (token) await records.delete(token);
      storage.removeItem(SESSION_TOKEN_KEY);
      token = null;
    },
    close() {
      channel?.close?.();
    },
  };
}

export function createBrowserSession() {
  return createSession();
}
