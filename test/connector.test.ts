// The Claude connector end to end, as Claude meets it: an MCP request without a
// token, discovery, client registration, the approval page, the token
// exchange, tool calls, a refresh. The real Worker code (worker/oauth.ts,
// worker/mcp.ts) on bun:sqlite and an in-memory KV.
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { Collection, EventFactory } from "../src/domain/collection";
import type { AppEvent } from "../src/domain/events";
import { newSyncCode } from "../src/domain/sync";
import { appendEvents, type WireEvent } from "../worker/sync";
import { sqliteD1 } from "./support/d1";
import { memoryKV } from "./support/kv";

// The OAuth library imports WorkerEntrypoint (for Service Bindings, unused here).
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
let handleOAuth: typeof import("../worker/oauth").handleOAuth;
beforeAll(async () => {
  ({ handleOAuth } = await import("../worker/oauth"));
});

const ORIGIN = "http://localhost:8787";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function world() {
  const db = sqliteD1();
  const env = { DB: db, OAUTH_KV: memoryKV() as unknown as KVNamespace };
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const cookies = new Map<string, string>();
  /** A browser-ish fetch against the Worker: keeps cookies, never follows redirects. */
  const fetchW = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = (await handleOAuth(new Request(new URL(path, ORIGIN), { ...init, headers }), env, ctx)) ?? new Response("not ours", { status: 599 });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  return { db, env, fetchW };
}

/** An account with two Spanish words, as the app would have pushed it. */
async function account(db: ReturnType<typeof sqliteD1>): Promise<string> {
  const code = newSyncCode();
  const f = new EventFactory("phone");
  const events: AppEvent[] = [f.preset({ preset_id: 7 }), f.deck("Spanish", 7, { from: "es", to: "en" }, 11), ...f.note(11, { front: "el perro", back: "dog" }, { from: "es", to: "en" }), ...f.note(11, { front: "el gato", back: "cat" }, { from: "es", to: "en" })];
  await appendEvents(db, code, events as WireEvent[]);
  return code;
}

async function pkce() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

/** Everything up to a token, as Claude does it. */
async function connect(w: ReturnType<typeof world>, code: string) {
  const reg = await (await w.fetchW("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "words", resource: `${ORIGIN}/mcp` });
  const page = await w.fetchW(`/oauth/authorize?${q}`);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const back = await w.fetchW("/oauth/authorize", form({ handle, decision: "allow", code }));
  const loc = new URL(back.headers.get("location")!);
  const tok = await (await w.fetchW("/oauth/token", form({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }))).json();
  return { reg, page, html, back, loc, tok };
}

/** One JSON-RPC call to /mcp (2025-era stateless, as most clients still speak). */
async function rpc(w: ReturnType<typeof world>, token: string, method: string, params: unknown = {}, id = 1) {
  const res = await w.fetchW("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await res.text();
  const body = text.startsWith("{") ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)![1]);
  return { status: res.status, body };
}

const tool = async (w: ReturnType<typeof world>, token: string, name: string, args: unknown) => {
  const { body } = await rpc(w, token, "tools/call", { name, arguments: args });
  const r = body.result;
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

describe("Claude connector", () => {
  it("challenges a request without a token and points to its authorization server", async () => {
    const w = world();
    const res = await w.fetchW("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    const meta = await (await w.fetchW("/.well-known/oauth-protected-resource/mcp")).json();
    expect(meta).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ["words"] });
    const as = await (await w.fetchW("/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register` });
  });

  it("leaves the app's own paths alone", async () => {
    const w = world();
    expect((await w.fetchW("/api/health")).status).toBe(599);
    expect((await w.fetchW("/")).status).toBe(599);
  });

  it("the approval page names the client and where access goes, and checks codes", async () => {
    const w = world();
    const code = await account(w.db);
    const { html, page } = await connect(w, code);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("Let Claude use your rcfc words?");
    expect(html).toContain("claude.ai");
    expect(html).toContain("isn't verified");
    const ok = await (await w.fetchW("/oauth/check", { method: "POST", body: JSON.stringify({ code: `https://rcfc.example/#k=${code}` }) })).json();
    expect(ok).toEqual({ ok: true, words: 2, hint: code.slice(-4) });
    expect(await (await w.fetchW("/oauth/check", { method: "POST", body: JSON.stringify({ code: newSyncCode() }) })).json()).toEqual({ ok: false, reason: "empty" });
    expect(await (await w.fetchW("/oauth/check", { method: "POST", body: JSON.stringify({ code: "nope" }) })).json()).toEqual({ ok: false, reason: "format" });
  });

  it("an unknown code is refused without using up the page, so going back works", async () => {
    const w = world();
    const code = await account(w.db);
    const reg = await (await w.fetchW("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const handle = /name="handle" value="([^"]+)"/.exec(await (await w.fetchW(`/oauth/authorize?${q}`)).text())![1];
    const bad = await w.fetchW("/oauth/authorize", form({ handle, decision: "allow", code: newSyncCode() }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("No words found");
    const good = await w.fetchW("/oauth/authorize", form({ handle, decision: "allow", code }));
    expect(good.status).toBe(302);
    expect(new URL(good.headers.get("location")!).searchParams.get("state")).toBe("s");
  });

  it("deny sends Claude back with access_denied", async () => {
    const w = world();
    const reg = await (await w.fetchW("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const handle = /name="handle" value="([^"]+)"/.exec(await (await w.fetchW(`/oauth/authorize?${q}`)).text())![1];
    const res = await w.fetchW("/oauth/authorize", form({ handle, decision: "deny" }));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("with a token, Claude lists tools, reads and changes the words, and the app gets the events", async () => {
    const w = world();
    const code = await account(w.db);
    const { loc, tok } = await connect(w, code);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(tok).toMatchObject({ token_type: "bearer", scope: expect.stringContaining("words") });
    expect(tok.refresh_token).toBeString();

    const init = await rpc(w, tok.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("rcfc");
    expect(init.body.result.instructions).toContain("dictionary form");
    const list = await rpc(w, tok.access_token, "tools/list", {}, 2);
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["add_words", "delete_sticker", "delete_words", "edit_words", "find_words", "mark_known", "mark_unknown", "overview", "rename_sticker", "restore_words", "stick", "unstick"]);

    expect((await tool(w, tok.access_token, "overview", {})).data).toMatchObject({ words: 2, languages: [{ language: "es", words: 2 }] });
    const added = await tool(w, tok.access_token, "add_words", { words: [{ word: "la casa", translation: "house", language: "Spanish", example: "Mi casa es tu casa.", stickers: ["Home"] }, { word: "el perro", translation: "dog", language: "es" }] });
    expect(added.data.added.map((x: { word: string }) => x.word)).toEqual(["la casa"]);
    expect(added.data.skipped[0]).toMatchObject({ word: "el perro", reason: "exists" });
    const found = await tool(w, tok.access_token, "find_words", { sticker: "home" });
    expect(found.data.total).toBe(1);
    const err = await tool(w, tok.access_token, "find_words", { sticker: "nothing" });
    expect(err).toMatchObject({ isError: true, data: expect.stringContaining('no sticker named "nothing"') });
    const casa = added.data.added[0].id;
    const bad = await tool(w, tok.access_token, "edit_words", { words: [{ id: casa, translation: "дом", translation_language: "ru" }, { id: 1, translation: "x" }] });
    expect(bad).toMatchObject({ isError: true, data: expect.stringContaining("no word with id 1") });
    const edited = await tool(w, tok.access_token, "edit_words", { words: [{ id: casa, translation: "дом", translation_language: "Russian" }] });
    expect(edited.data[0]).toMatchObject({ translation: "дом", translation_language: "ru" });
    // The old list again: the translated word is still that word.
    const again = await tool(w, tok.access_token, "add_words", { words: [{ word: "la casa", translation: "house", language: "es", translation_language: "en" }] });
    expect(again.data).toMatchObject({ added: [], skipped: [{ reason: "exists", id: casa }] });

    // What the app pulls on its next sync folds into the same words.
    const pulled = await (await import("../worker/sync")).loadEvents(w.db, code);
    const col = new Collection();
    for (const e of pulled) col.apply(e as AppEvent);
    expect(col.liveNotes().map((n) => n.fields.front)).toEqual(["el perro", "el gato", "la casa"]);
    expect(col.liveNote(casa)!.lang_pair).toEqual({ from: "es", to: "ru" });
    expect(col.labelsOf(found.data.words[0].id).map((l) => l.name)).toEqual(["Home"]);
    expect((pulled as AppEvent[]).filter((e) => e.device_id === "claude").length).toBeGreaterThan(0);
  });

  it("refreshes tokens and refuses a token for another account's words", async () => {
    const w = world();
    const code = await account(w.db);
    const { reg, tok } = await connect(w, code);
    const next = await (await w.fetchW("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }))).json();
    expect(next.access_token).toBeString();
    expect((await tool(w, next.access_token, "overview", {})).data.words).toBe(2);
    const forged = await w.fetchW("/mcp", { method: "POST", headers: { authorization: "Bearer nope:nope:nope", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(forged.status).toBe(401);
  });

  it("answers only on the deployment's own address", async () => {
    const db = sqliteD1();
    const env = { DB: db, OAUTH_KV: memoryKV() as unknown as KVNamespace, PUBLIC_ORIGIN: "https://rcfc.example" };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await handleOAuth(new Request("https://rcfc.workers.example/mcp", { method: "POST" }), env, ctx);
    expect(res!.status).toBe(421);
    expect(await res!.json()).toEqual({ error: "use https://rcfc.example/mcp" });
  });
});
