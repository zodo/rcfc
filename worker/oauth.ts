// Sign-in for the Claude connector (docs/design.md "Claude connector"). This
// Worker is both the OAuth authorization server and the MCP resource (/mcp),
// with @cloudflare/workers-oauth-provider doing the protocol: discovery,
// client registration, tokens (stored hashed in KV, props encrypted).
//
// There are no user accounts: the sync code is the account. The approval page
// (/oauth/authorize) is on the app's own origin, so in a browser where rcfc is
// used it reads this browser's sync code from the app's IndexedDB and asks for
// one tap; elsewhere (an iPhone home-screen app keeps its storage apart from
// Safari) it asks for the code or the pairing link from Settings → Copy link.
// The token's props carry the code, so the MCP server acts for that account.
import { AuthorizationError, CimdFetchError, insufficientScope, OAuthAuthorizationServer, OAuthResourceServer, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { Collection } from "../src/domain/collection";
import type { AppEvent } from "../src/domain/events";
import { parseSyncCode } from "../src/domain/sync";
import { serveMcp } from "./mcp";
import { json, loadEvents, type SqlDb } from "./sync";

/** The one scope: read and change the words. */
export const SCOPE = "words";
const DAY = 86_400;

export interface OAuthEnv {
  DB: SqlDb;
  OAUTH_KV: KVNamespace;
  /** The app's canonical origin (preview, production); unset in local dev, where the request's origin is used. */
  PUBLIC_ORIGIN?: string;
}

interface Props {
  code: string;
}

interface Servers {
  auth: OAuthAuthorizationServer<OAuthEnv>;
  mcp: OAuthResourceServer<OAuthEnv, Props>;
}

const built = new Map<string, Servers>();

function servers(origin: string): Servers {
  let s = built.get(origin);
  if (s) return s;
  const resource = `${origin}/mcp`;
  const auth = new OAuthAuthorizationServer<OAuthEnv>({
    issuer: origin,
    resources: [resource],
    authorizeEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    clientRegistrationEndpoint: `${origin}/oauth/register`,
    scopesSupported: [SCOPE, "offline_access"],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    // Connected for as long as it is used: a refresh moves the end 90 days on.
    refreshTokenTTL: 90 * DAY,
    refreshTokenIdleTTL: 90 * DAY,
  });
  const mcp = new OAuthResourceServer<OAuthEnv, Props>({
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: "rcfc words" },
    requiredScopes: [SCOPE],
    validateToken: (env) => (res, token) => auth.validateToken<Props>(res, token, env),
    handler: {
      fetch: (request, env, ctx) => (ctx.auth.scope.includes(SCOPE) ? serveMcp(request, env.DB, ctx.props.code) : insufficientScope(ctx.auth, [SCOPE])),
    },
  });
  s = { auth, mcp };
  built.set(origin, s);
  return s;
}

const isMcp = (p: string) => p === "/mcp" || p.startsWith("/mcp/") || p.startsWith("/.well-known/oauth-protected-resource");
const isAuth = (p: string) => p === "/oauth/token" || p === "/oauth/register" || p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration");

/** Handles the connector's paths (/mcp, /oauth/*, OAuth discovery); null for any other. */
export async function handleOAuth(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!isMcp(p) && !isAuth(p) && !p.startsWith("/oauth/")) return null;
  const origin = env.PUBLIC_ORIGIN || url.origin;
  // One issuer per deployment: production is also served on workers.dev, but tokens name one address.
  if (url.origin !== origin) return json({ error: `use ${origin}${p}` }, 421);
  const { auth, mcp } = servers(origin);
  if (isMcp(p)) return mcp.fetch(request, env, ctx);
  if (isAuth(p)) return auth.fetch(request, env, ctx);
  if (p === "/oauth/authorize") return authorize(request, env, auth);
  if (p === "/oauth/check" && request.method === "POST") return check(request, env.DB);
  return json({ error: "not found" }, 404);
}

/** How many words an account has (0: no such account, or nothing in it). */
async function wordCount(db: SqlDb, code: string): Promise<number> {
  const col = new Collection();
  for (const e of await loadEvents(db, code)) col.apply(e as AppEvent);
  return col.liveNotes().length;
}

/** The approval page asks whether a code (or a pasted link) is an account with words. */
async function check(request: Request, db: SqlDb): Promise<Response> {
  let input = "";
  try {
    input = String(((await request.json()) as { code?: unknown }).code ?? "");
  } catch {
    /* empty */
  }
  const code = parseSyncCode(input);
  if (!code) return json({ ok: false, reason: "format" });
  const words = await wordCount(db, code);
  return json(words ? { ok: true, words, hint: code.slice(-4) } : { ok: false, reason: "empty" });
}

/** A user id for the grant (stored in KV unencrypted, so not the code itself). */
async function userIdOf(code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rcfc-user:${code}`)));
  return Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorize(request: Request, env: OAuthEnv, auth: OAuthAuthorizationServer<OAuthEnv>): Promise<Response> {
  const oauth = auth.getOAuthApi(env);
  try {
    if (request.method === "GET") {
      const req = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(req); // first: a failed lookup leaves nothing in KV
      const consent = await oauth.beginConsent(req);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set("cache-control", "no-store");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "allow") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Checked before the handle is used, so going back to the page still works.
    const code = parseSyncCode(String(form.get("code") ?? ""));
    if (!code || !(await wordCount(env.DB, code))) return message(400, "No words found for that code", "Go back and paste the link from rcfc: Settings → Copy link.");
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE, "offline_access"] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: await userIdOf(code),
      metadata: {},
      scope: approved.request.scope,
      props: { code } satisfies Props,
    });
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return message(400, "This sign-in link has expired", "Start connecting again from Claude.");
    if (e instanceof CimdFetchError) return message(400, "This app couldn't be checked", "Try connecting again in a minute.");
    throw e;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --table: #a9bfa3; --card: #fffdf8; --ink: #2f3a2c; --muted: #6b7466; --line: #d9d3c4; --button: #f2c94c; --button-ink: #2f3a2c; --bad: #a3402e; }
@media (prefers-color-scheme: dark) { :root { --table: #2f3b2d; --card: #23281f; --ink: #ece7da; --muted: #a9b0a1; --line: #3d4637; --button: #d9b23c; --button-ink: #1d2119; --bad: #e08a74; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--table); color: var(--ink); font: 17px/1.45 "Balsamiq Sans", ui-rounded, system-ui, sans-serif; display: grid; place-items: center; padding: 24px 16px; }
main { width: 100%; max-width: 420px; background: var(--card); padding: 24px 22px 20px; border-radius: 3px; box-shadow: 0 1px 2px rgb(0 0 0 / .18), 0 8px 24px rgb(0 0 0 / .12); transform: rotate(-.4deg); }
h1 { font-size: 22px; line-height: 1.25; margin: 0 0 10px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 15px; }
.warn { color: var(--bad); font-size: 15px; }
.account { border: 1px dashed var(--line); padding: 10px 12px; margin: 16px 0; }
label { display: block; font-size: 15px; color: var(--muted); margin-bottom: 4px; }
input { width: 100%; font: inherit; padding: 10px; border: 1px solid var(--line); background: transparent; color: var(--ink); border-radius: 2px; }
.found { margin: 6px 0 0; min-height: 1.4em; }
#here { margin: 4px 0 0; }
.row { display: flex; gap: 10px; margin-top: 18px; }
button { font: inherit; border: 0; padding: 11px 18px; cursor: pointer; border-radius: 2px; }
.allow { flex: 1; background: var(--button); color: var(--button-ink); font-weight: 700; }
.allow:disabled { opacity: .45; cursor: default; }
.deny { background: transparent; color: var(--muted); }
.link { background: none; padding: 0; color: var(--muted); text-decoration: underline; font-size: 15px; }
[hidden] { display: none !important; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function message(status: number, title: string, text: string): Response {
  return new Response(page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`), { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * The approval page. What MCP asks it to show: who is asking (a self-named
 * client is said to be unverified), where access goes, and a warning for a
 * local app. The account is this browser's rcfc, else a pasted code or link.
 */
export function consentPage(d: ConsentDescription, handle: string): string {
  const name = esc(d.clientName);
  const who = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app named itself; its name isn't verified.";
  const body = `
<h1>Let ${name} use your rcfc words?</h1>
<p>${name} will be able to see your words and stickers, add and change them, and mark words known.</p>
<p class="muted">${who} Access goes to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="warn">This sends access to an app on this computer. Continue only if you just started connecting from it.</p>` : ""}
<form method="post" id="f">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <div class="account">
    <div id="ask">
      <label for="code">Your rcfc link or sync code</label>
      <input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false">
      <p class="muted" id="how">In rcfc: Settings → Copy link.</p>
    </div>
    <p class="found" id="found" aria-live="polite"></p>
    <p id="here" hidden></p>
  </div>
  <div class="row"><button class="allow" name="decision" value="allow" id="allow" disabled>Allow</button><button class="deny" name="decision" value="deny" formnovalidate>Deny</button></div>
</form>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const input = $("code"), found = $("found"), allow = $("allow");
  let seq = 0;
  async function check(text, own) {
    const n = ++seq;
    allow.disabled = true;
    if (!text.trim()) return void (found.textContent = "");
    found.textContent = "Looking…";
    let r = { ok: false, reason: "error" };
    try { r = await (await fetch("/oauth/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: text }) })).json(); } catch {}
    if (n !== seq) return;
    if (r.ok) {
      found.textContent = r.words + (r.words === 1 ? " word" : " words") + (own ? " in rcfc on this browser" : " found") + " (code ending " + r.hint + ").";
      allow.disabled = false;
    } else found.textContent = r.reason === "format" ? "That isn't an rcfc link or code yet." : r.reason === "empty" ? "No words found for that code." : "Couldn't check it. Try again.";
  }
  let t;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => check(input.value, false), 250); });
  // This browser's own rcfc account, if the app is used here (its IndexedDB, same origin).
  function own(code) {
    if (!code) return;
    input.value = code;
    $("ask").hidden = true;
    const here = $("here");
    here.hidden = false;
    here.innerHTML = '<button type="button" class="link" id="other">Use another code</button>';
    $("other").onclick = () => { $("ask").hidden = false; here.hidden = true; input.value = ""; found.textContent = ""; allow.disabled = true; input.focus(); };
    check(code, true);
  }
  try {
    const req = indexedDB.open("rcfc");
    req.onupgradeneeded = () => req.transaction.abort(); // no rcfc here: don't make an empty database
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) return db.close();
      const g = db.transaction("meta").objectStore("meta").get("sync_code");
      g.onsuccess = () => { own(g.result && g.result.value); db.close(); };
    };
  } catch {}
})();
</script>`;
  return page(`Allow ${d.clientName}?`, body);
}
