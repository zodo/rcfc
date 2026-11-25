// A word's notes. POST /api/summary {from, to, word, translation} answers a
// Summary (src/domain/summary.ts). Kept in R2 by language pair and words, so
// the same word costs nothing the second time, for anyone. LLM calls share the
// pictures' daily neuron cap (ai_budget): past it 429, never a bill. Without
// an AI binding (local dev) it answers a recognisable placeholder.
import { clean } from "../src/domain/fill";
import { budgetDay, DEFAULT_DAILY_NEURONS, secondsToReset } from "../src/domain/pictures";
import { devSummary, NEURONS_PER_SUMMARY, parseSummary, SUMMARY_MODEL, SUMMARY_SCHEMA, summaryKey, summaryMessages, summaryRequestOk, type Summary, type SummaryRequest } from "../src/domain/summary";
import { isSyncCode } from "../src/domain/sync";
import type { FillEnv } from "./fill";
import { reserve, type AiRunner } from "./pictures";
import { json } from "./sync";

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

function parseRequest(body: unknown): SummaryRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const r: SummaryRequest = {
    from: typeof b.from === "string" ? b.from : "",
    to: typeof b.to === "string" ? b.to : "",
    word: typeof b.word === "string" ? clean(b.word) : "",
    translation: typeof b.translation === "string" ? clean(b.translation) : "",
    in: typeof b.in === "string" ? b.in : typeof b.from === "string" ? b.from : "",
  };
  return LANG_RE.test(r.from) && LANG_RE.test(r.to) && summaryRequestOk(r) ? r : null;
}

async function ask(ai: AiRunner, model: string, r: SummaryRequest): Promise<Summary | null> {
  const input: Record<string, unknown> = {
    messages: summaryMessages(r),
    response_format: { type: "json_schema", json_schema: { name: "notes", schema: SUMMARY_SCHEMA } },
    max_tokens: model.includes("deepseek") || model.includes("gemma-4") ? 1200 : 3000, // models that think spend tokens before answering
    temperature: 0.2,
  };
  // Thinking off where it can be: slower, and no better at a dictionary entry.
  if (model.includes("gemma-4") || model.includes("deepseek")) input.chat_template_kwargs = { enable_thinking: false, thinking: false };
  else if (model.includes("gpt-oss")) input.reasoning = { effort: "low" };
  const res = (await ai.run(model, input)) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  return parseSummary(res.response ?? res.choices?.[0]?.message?.content);
}

/** Handles /api/summary; null for any other path. Same environment as fills. */
export async function handleSummary(request: Request, env: FillEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/summary") return null;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const code = request.headers.get("x-user-code");
  if (!code || !isSyncCode(code)) return json({ error: "missing or invalid X-User-Code" }, 401);
  const body = await request.json().catch(() => null);
  const r = parseRequest(body);
  if (!r) return json({ error: "from, to, word and translation (≤120 characters) are required" }, 400);
  if (!env.AI) {
    if (env.devDelay) await new Promise((res) => setTimeout(res, env.devDelay));
    return json(devSummary(r));
  }

  const asked = (body as { model?: unknown }).model;
  const model = !env.production && typeof asked === "string" && asked.startsWith("@cf/") ? asked : SUMMARY_MODEL;
  const key = await summaryKey(r, model);
  const kept = await env.MEDIA.get(key);
  if (kept) return json(await new Response(kept.body).json());

  const now = (env.now ?? Date.now)();
  if (!(await reserve(env.DB, budgetDay(now), NEURONS_PER_SUMMARY, env.budget ?? DEFAULT_DAILY_NEURONS))) {
    const wait = secondsToReset(now);
    return new Response(JSON.stringify({ error: "daily AI limit reached", retry_after: wait }), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(wait) },
    });
  }
  let summary: Summary | null;
  try {
    summary = await ask(env.AI, model, r);
  } catch (e) {
    return json({ error: `summary failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  // Nothing usable is not kept: next time may do better.
  if (!summary) return json({ error: "summary failed: empty reply" }, 502);
  await env.MEDIA.put(key, JSON.stringify(summary), { httpMetadata: { contentType: "application/json" } });
  return json(summary);
}
