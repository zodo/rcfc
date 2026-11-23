// Pronunciation with the Web Speech API (offline where the OS has a voice).

function bestVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const base = lang.toLowerCase().split("-")[0];
  const matching = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").split("-")[0] === base);
  return matching.find((v) => v.localService && v.default) ?? matching.find((v) => v.localService) ?? matching[0];
}

export function canSpeak(): boolean {
  return typeof speechSynthesis !== "undefined";
}

export function speak(text: string, lang: string) {
  if (!canSpeak()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const v = bestVoice(lang);
  if (v) u.voice = v;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

// Some browsers load voices asynchronously.
if (canSpeak()) speechSynthesis.getVoices();
