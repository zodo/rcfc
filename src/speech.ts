// Spoken words and examples on the client. Audio comes from GET /api/tts (made
// once by Azure Speech, worker/tts.ts) and is downloaded ahead for the cards
// coming up, like pictures, then kept in IndexedDB so it plays at once, offline
// too. Without a stored copy it is fetched on the spot (briefly), and without
// one at all the browser's own voice says it (src/ui/speech.ts).
import type { EntityId } from "./domain/ids";
import { spokenText, voiceFor } from "./domain/tts";
import type { Store } from "./store";
import { canSpeak, speak as browserSpeak } from "./ui/speech";

/** How long a tap waits for audio not downloaded yet before the browser voice says it. */
const FETCH_WAIT_MS = 1500;

/** Plays stored audio. The browser one is Web Audio (`webAudio`); tests record calls. */
export interface Player {
  /** Plays the audio; false when it can't (not unlocked by a tap yet, undecodable). */
  play(key: string, data: ArrayBuffer): Promise<boolean>;
  stop(): void;
}

export class Speech {
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  /** The browser's voice, when no audio can be had. */
  fallback: (text: string, lang: string) => void = browserSpeak;
  online: () => boolean = () => typeof navigator === "undefined" || navigator.onLine !== false;

  private have = new Set<string>();
  /** Texts the server has no audio for (no voice for the language). */
  private absent = new Set<string>();
  /** The server has no voice service (local dev, no key) or hit its monthly limit: ask no more this run. */
  private off = false;
  private queue = new Map<string, { text: string; lang: string }>();
  private running: Promise<void> | null = null;
  /** Bumped by every `say`, so a slow earlier one doesn't speak over it. */
  private turn = 0;

  private constructor(
    private store: Store,
    private code: () => string,
    readonly player: Player,
  ) {}

  static async open(store: Store, code: () => string, player: Player): Promise<Speech> {
    const s = new Speech(store, code, player);
    for (const k of await store.ttsKeys()) s.have.add(k);
    return s;
  }

  /** Whether `say` can speak this language at all (a server voice, or the browser's). */
  canSay(lang: string): boolean {
    return !!voiceFor(lang) || canSpeak();
  }

  /** Download the audio of these cards' word and example (their studied language), for when they come up. */
  ahead(cardIds: Iterable<EntityId>): Promise<void> {
    const { col } = this.store;
    for (const id of cardIds) {
      const note = col.notes.get(col.cards.get(id)?.note_id ?? 0);
      if (!note) continue;
      for (const t of [note.fields.front, note.fields.example]) if (t?.trim()) this.want(t, note.lang_pair.from);
    }
    return this.run();
  }

  private want(text: string, lang: string): void {
    const k = key(text, lang);
    if (voiceFor(lang) && !this.have.has(k) && !this.absent.has(k)) this.queue.set(k, { text, lang });
  }

  private run(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (const [k, t] of this.queue) {
          if (this.off || !this.online()) break;
          this.queue.delete(k);
          await this.download(t.text, t.lang).catch(() => undefined); // offline or failed: asked again when it comes up
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Fetch and keep one text's audio; true when it is stored now. */
  private async download(text: string, lang: string, signal?: AbortSignal): Promise<boolean> {
    const k = key(text, lang);
    if (this.have.has(k)) return true;
    const res = await this.fetch(`/api/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(spokenText(text))}`, { headers: { "x-user-code": this.code() }, signal });
    if (res.ok) {
      await this.store.putTts({ key: k, data: await res.arrayBuffer() });
      this.have.add(k);
      return true;
    }
    const why = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
    if (res.status === 429 || (res.status === 404 && why === "no voice service")) this.off = true;
    else if (res.status === 404 || res.status === 400) this.absent.add(k);
    return false;
  }

  /** Say a text in a language: stored audio at once, else fetched briefly, else the browser's voice. */
  async say(text: string, lang: string): Promise<void> {
    const turn = ++this.turn;
    this.player.stop();
    if (canSpeak()) speechSynthesis.cancel();
    const k = key(text, lang);
    if (!this.have.has(k) && voiceFor(lang) && !this.off && !this.absent.has(k) && this.online()) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), FETCH_WAIT_MS);
      await this.download(text, lang, abort.signal).catch(() => false);
      clearTimeout(timer);
    }
    if (turn !== this.turn) return;
    const stored = this.have.has(k) ? await this.store.getTts(k) : undefined;
    if (turn !== this.turn) return;
    if (stored && (await this.player.play(k, stored.data))) return said(text, "audio");
    if (turn !== this.turn) return;
    this.fallback(text, lang);
    said(text, "browser");
  }
}

/** Tells the page what was just said and how (the smoke test listens: scripts/smoke.ts). */
function said(text: string, by: "audio" | "browser"): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("rcfc-said", { detail: { text, by } }));
}

function key(text: string, lang: string): string {
  return `${lang}|${spokenText(text)}`;
}

/**
 * Web Audio playback: decoded buffers start without the delay of an <audio>
 * element. Browsers (iOS above all) keep audio silent until a tap, so the
 * context is resumed on the first one; recently played audio stays decoded.
 */
export function webAudio(): Player {
  let ctx: AudioContext | undefined;
  let current: AudioBufferSourceNode | undefined;
  const decoded = new Map<string, AudioBuffer>();
  // iOS mutes Web Audio on the silent switch unless the page says it plays media (Safari 17+).
  const session = (navigator as { audioSession?: { type: string } }).audioSession;
  if (session) session.type = "playback";
  const unlock = () => {
    if (ctx?.state === "running") return;
    ctx ??= new AudioContext();
    void ctx.resume();
    // iOS needs a sound started inside the tap.
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start();
  };
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, unlock, { capture: true, passive: true });
  return {
    async play(key, data) {
      if (!ctx || ctx.state !== "running") return false;
      try {
        let buf = decoded.get(key);
        if (!buf) {
          buf = await ctx.decodeAudioData(data.slice(0));
          decoded.set(key, buf);
          if (decoded.size > 30) decoded.delete(decoded.keys().next().value!);
        }
        current?.stop();
        current = ctx.createBufferSource();
        current.buffer = buf;
        current.connect(ctx.destination);
        current.start();
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      try {
        current?.stop();
      } catch {
        // never started
      }
      current = undefined;
    },
  };
}
