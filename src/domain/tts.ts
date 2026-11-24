// Spoken words and examples: which voice says a language, the SSML it gets and
// the key its audio is stored under. Pure, so the Worker (worker/tts.ts) and
// the client (src/speech.ts) agree. Audio is made once per voice and text by
// Azure Speech, kept in R2, and downloaded ahead to the device.

/** Azure neural voice per studied language; a language without one is spoken by the browser. */
export const VOICES: Record<string, string> = {
  es: "es-ES-ElviraNeural",
  en: "en-US-JennyNeural",
  ru: "ru-RU-SvetlanaNeural",
  uk: "uk-UA-PolinaNeural",
  de: "de-DE-KatjaNeural",
  fr: "fr-FR-DeniseNeural",
  it: "it-IT-ElsaNeural",
  pt: "pt-BR-FranciscaNeural",
  pl: "pl-PL-ZofiaNeural",
  nl: "nl-NL-FennaNeural",
  tr: "tr-TR-EmelNeural",
  ja: "ja-JP-NanamiNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  ko: "ko-KR-SunHiNeural",
  ar: "ar-SA-ZariyahNeural",
  he: "he-IL-HilaNeural",
  sv: "sv-SE-SofieNeural",
  cs: "cs-CZ-VlastaNeural",
};

/** A little slower than conversation, for a learner. */
export const RATE = "-10%";
export const MAX_TTS_TEXT = 300;
/** Azure's free tier is 500,000 characters a month; stay under it. */
export const DEFAULT_TTS_CHARS_PER_MONTH = 450_000;
export const AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export function voiceFor(lang: string): string | undefined {
  return VOICES[lang.toLowerCase().split("-")[0]];
}

/** The text as it is spoken: trimmed, inner whitespace collapsed (so the same text is one audio). */
export function spokenText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function ssml(text: string, voice: string): string {
  const lang = voice.split("-").slice(0, 2).join("-");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${RATE}">${xml(spokenText(text))}</prosody></voice></speak>`;
}

/** R2 key of a voice saying a text (a new voice, rate or format makes new audio). */
export async function audioKey(text: string, voice: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${AUDIO_FORMAT}|${RATE}|${spokenText(text)}`);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `tts/${voice}/${hash}.mp3`;
}

/** Calendar month (UTC) for the character budget. */
export function budgetMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}
