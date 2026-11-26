// The slice of Workers KV the OAuth library uses (get / getWithMetadata / put /
// delete / list with prefixes, metadata and expiry), in memory.
interface Entry {
  value: string;
  metadata?: unknown;
  expiration?: number;
}

export function memoryKV(now: () => number = Date.now) {
  const data = new Map<string, Entry>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e?.expiration !== undefined && e.expiration * 1000 <= now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const read = (e: Entry | undefined, type?: unknown) => {
    if (!e) return null;
    const t = typeof type === "string" ? type : (type as { type?: string } | undefined)?.type;
    if (t === "json") return JSON.parse(e.value);
    if (t === "arrayBuffer") return new TextEncoder().encode(e.value).buffer;
    return e.value;
  };
  const kv = {
    data,
    async get(key: string, type?: unknown) {
      return read(live(key), type);
    },
    async getWithMetadata(key: string, type?: unknown) {
      const e = live(key);
      return { value: read(e, type), metadata: e?.metadata ?? null };
    },
    async put(key: string, value: string | ArrayBuffer, opts: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}) {
      const v = typeof value === "string" ? value : new TextDecoder().decode(value);
      const expiration = opts.expiration ?? (opts.expirationTtl !== undefined ? Math.floor(now() / 1000) + opts.expirationTtl : undefined);
      data.set(key, { value: v, metadata: opts.metadata, expiration });
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const names = [...data.keys()].filter((k) => live(k) && k.startsWith(opts.prefix ?? "")).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const limit = opts.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name, expiration: data.get(name)!.expiration, metadata: data.get(name)!.metadata })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + limit) }),
        cacheStatus: null,
      };
    },
  };
  return kv;
}
