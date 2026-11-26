import { describe, expect, test } from "bun:test";
import { languageOfText, scriptOf } from "../src/domain/script";

describe("language of a typed word, from its letters", () => {
  test("scripts", () => {
    expect(scriptOf("собака")).toBe("Cyrl");
    expect(scriptOf("dog")).toBe("Latn");
    expect(scriptOf("食べる")).toBe("Kana");
    expect(scriptOf("狗")).toBe("Hani");
    expect(scriptOf("123 !")).toBeUndefined();
  });

  test("Cyrillic on an English side is Russian; Latin on a Russian side is English", () => {
    expect(languageOfText("собака", "en", [])).toBe("ru");
    expect(languageOfText("dog", "ru", [])).toBe("en");
  });

  test("the card's language stays while the letters could be it, whatever the word", () => {
    expect(languageOfText("Hund", "en", ["de"])).toBe("en"); // never guesses within a script
    expect(languageOfText("собака", "ru", [])).toBe("ru");
    expect(languageOfText("собака", "uk", [])).toBe("uk");
  });

  test("the user's own languages come first", () => {
    expect(languageOfText("dog", "ru", ["ru", "de", "en"])).toBe("de");
    expect(languageOfText("собака", "en", ["en", "uk"])).toBe("uk");
  });

  test("Ukrainian letters", () => {
    expect(languageOfText("їжак", "en", ["en", "ru"])).toBe("uk");
    expect(languageOfText("їжак", "ru", [])).toBe("uk");
  });

  test("too little to go by", () => {
    expect(languageOfText("я", "en", [])).toBe("en");
    expect(languageOfText("", "en", [])).toBe("en");
  });

  test("kanji alone can be Japanese", () => {
    expect(languageOfText("犬", "ja", [])).toBe("ja");
    expect(languageOfText("犬犬", "en", [])).toBe("zh");
    expect(languageOfText("いぬ", "en", ["zh", "ja"])).toBe("ja");
  });
});
