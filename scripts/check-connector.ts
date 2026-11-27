// The Claude connector over HTTP, as Claude meets it (worker/oauth.ts, worker/mcp.ts):
//   bun scripts/check-connector.ts <url> [--write]
// Always: an MCP call without a token is challenged, and the discovery
// documents point at this deployment. With --write (dev and preview; never
// production data): a throwaway account is pushed through the sync API, a
// client registers, the approval page is filled in and allowed, the code is
// exchanged for tokens, the tools are listed and called (add, find, stick,
// mark known, delete), a refresh works, and the account's events, pulled as
// the app pulls them, show the changes.
import { Collection, EventFactory } from "../src/domain/collection";
import type { AppEvent } from "../src/domain/events";
import { newSyncCode } from "../src/domain/sync";

const [base, flag] = process.argv.slice(2);
if (!base) throw new Error("usage: check-connector.ts <url> [--write]");
const origin = new URL(base).origin;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} connector: ${name}${ok || detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failed++;
}

const cookies = new Map<string, string>();
async function go(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual" });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    cookies.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const form = (o: Record<string, string>): RequestInit => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const jsonPost = (o: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(o) });

// ---- discovery, no token
const challenge = await go("/mcp", jsonPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "application/json, text/event-stream" }));
check("MCP without a token is challenged", challenge.status === 401 && (challenge.headers.get("www-authenticate") ?? "").includes("resource_metadata="), challenge.status);
const pr = await (await go("/.well-known/oauth-protected-resource/mcp")).json().catch(() => ({}));
check("protected resource metadata", pr.resource === `${origin}/mcp` && pr.authorization_servers?.[0] === origin, pr);
const as = await (await go("/.well-known/oauth-authorization-server")).json().catch(() => ({}));
check("authorization server metadata", as.issuer === origin && as.authorization_endpoint === `${origin}/oauth/authorize` && !!as.registration_endpoint, as);
const shell = await go("/oauth/authorize");
check("the approval page is the Worker's, not the app shell", !(await shell.text()).includes("<title>rcfc</title>"), shell.status);

if (flag === "--write") {
  // ---- a throwaway account with one word, pushed as the app pushes
  const code = newSyncCode();
  const f = new EventFactory(`check-${Date.now()}`);
  const seed: AppEvent[] = [f.preset(), f.deck("Spanish", 0, { from: "es", to: "en" }, 1001), ...f.note(1001, { front: "el perro", back: "dog" }, { from: "es", to: "en" })];
  (seed[1].payload as { preset_id: number }).preset_id = (seed[0].payload as { preset_id: number }).preset_id;
  const pushed = await (await go("/api/sync/push", jsonPost({ events: seed }, { "x-user-code": code }))).json();
  check("throwaway account pushed", pushed.accepted === seed.length, pushed);

  // ---- register, approve, exchange
  const reg = await (await go(as.registration_endpoint, jsonPost({ client_name: "connector check", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }))).json();
  check("client registered", typeof reg.client_id === "string", reg);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const pkce = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: pkce, code_challenge_method: "S256", state: "st", scope: "words", resource: `${origin}/mcp` });
  const page = await go(`/oauth/authorize?${q}`);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  check("approval page shown", page.status === 200 && !!handle && html.includes("use your rcfc words"), page.status);
  const found = await (await go("/oauth/check", jsonPost({ code: `${origin}/#k=${code}` }))).json();
  check("approval page finds the account from a pasted link", found.ok === true && found.words === 1, found);
  const back = await go("/oauth/authorize", form({ handle: handle ?? "", decision: "allow", code }));
  const loc = back.headers.get("location") ?? "";
  const authCode = loc ? new URL(loc).searchParams.get("code") : null;
  check("allow sends Claude back with a code", back.status === 302 && loc.startsWith(REDIRECT) && !!authCode, { status: back.status, loc });
  const tok = await (await go(as.token_endpoint, form({ grant_type: "authorization_code", code: authCode ?? "", redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${origin}/mcp` }))).json();
  check("tokens issued", typeof tok.access_token === "string" && typeof tok.refresh_token === "string", tok);

  // ---- MCP calls (2025-era stateless JSON-RPC, as most clients speak today)
  let id = 0;
  async function rpc(token: string, method: string, params: unknown = {}) {
    const res = await go("/mcp", jsonPost({ jsonrpc: "2.0", id: ++id, method, params }, { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }));
    const text = await res.text();
    try {
      return text.startsWith("{") ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)![1]);
    } catch {
      return { status: res.status, text };
    }
  }
  async function tool(token: string, name: string, args: unknown) {
    const r = (await rpc(token, "tools/call", { name, arguments: args })).result;
    return r && !r.isError ? JSON.parse(r.content[0].text) : { error: r?.content?.[0]?.text ?? "no result" };
  }
  const init = await rpc(tok.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connector check", version: "1" } });
  check("initialize", init.result?.serverInfo?.name === "rcfc", init);
  const tools = await rpc(tok.access_token, "tools/list");
  check("tools listed", (tools.result?.tools?.length ?? 0) >= 10, tools.result?.tools?.map((t: { name: string }) => t.name));
  const added = await tool(tok.access_token, "add_words", { words: [{ word: "la casa", translation: "house", language: "Spanish", example: "Mi casa es tu casa.", stickers: ["Connector check"] }, { word: "el perro", translation: "dog", language: "es" }] });
  check("add_words adds and skips repeats", added.added?.length === 1 && added.skipped?.[0]?.reason === "exists", added);
  const casa = added.added?.[0]?.id;
  const perro = added.skipped?.[0]?.id;
  check("find_words by sticker", (await tool(tok.access_token, "find_words", { sticker: "connector check" })).total === 1);
  check("mark_known", (await tool(tok.access_token, "mark_known", { ids: [perro] })).marked?.[0]?.status === "known");
  const ru = await tool(tok.access_token, "edit_words", { words: [{ id: perro, translation: "собака", translation_language: "ru" }] });
  check("edit_words translates into another language", ru?.[0]?.translation_language === "ru", ru);
  check("delete_words", (await tool(tok.access_token, "delete_words", { ids: [casa] })).deleted?.length === 1);
  const next = await (await go(as.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }))).json();
  check("refresh", typeof next.access_token === "string", next);
  const ov = await tool(next.access_token, "overview", {});
  check("overview with the refreshed token", ov.words === 1 && ov.languages?.[0]?.known === 1, ov);

  // ---- what the app would pull
  const pulled = await (await go("/api/sync/pull?after=0", { headers: { "x-user-code": code } })).json();
  const col = new Collection();
  for (const e of pulled.events) col.apply(e);
  const p = col.liveNotes().find((n) => n.fields.front === "el perro");
  check("the app's pull folds the changes", col.liveNotes().length === 1 && !!p && p.lang_pair.to === "ru" && (col.cardsByNote.get(p.id) ?? []).every((c) => col.cards.get(c)!.last_rating === 4) && col.notes.get(casa)?.deleted === true);
}

if (failed) process.exit(1);
