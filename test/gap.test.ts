import { describe, expect, test } from "bun:test";
import { gapped } from "../src/domain/gap";

const show = (word: string, example: string, lang = "es") => gapped(word, example, lang)?.join("___") ?? null;

describe("the example with the word blanked out (reverse cards)", () => {
  test("the word as typed", () => {
    expect(show("ningún", "No tengo ningún problema.")).toBe("No tengo ___ problema.");
    expect(show("de", "Soy de Madrid.")).toBe("Soy ___ Madrid.");
  });

  test("another form of it", () => {
    expect(show("ningún", "No hay ninguna casa.")).toBe("No hay ___ casa.");
    expect(show("hablar", "Hablamos mañana.")).toBe("___ mañana.");
    expect(show("das Haus", "Die Häuser sind alt.", "de")).toBe("___ sind alt.");
    expect(show("собака", "Я вижу собаку.", "ru")).toBe("Я вижу ___.");
  });

  test("a noun typed with its article: the article in the sentence goes too", () => {
    expect(show("el perro", "Mi perro ladra.")).toBe("Mi ___ ladra.");
    expect(show("el perro", "Tengo un perro grande.")).toBe("Tengo ___ grande.");
    expect(show("el perro", "El perro ladra.")).toBe("___ ladra.");
    expect(show("el perro", "El perro y los perros.")).toBe("___ y ___.");
  });

  test("every place and form it stands in (a look-alike too: better than giving the answer away)", () => {
    expect(show("casa", "Está casado y tiene una casa.")).toBe("Está ___ y tiene una ___.");
    expect(show("perro", "Un perro y dos perros.")).toBe("Un ___ y dos ___.");
  });

  test("phrases", () => {
    expect(show("a menudo", "Voy a menudo al cine.")).toBe("Voy ___ al cine.");
    expect(show("darse cuenta", "Al final se dio cuenta.")).toBeNull(); // irregular form: no sentence
  });

  test("short words only as they are", () => {
    expect(show("en", "Vive entre amigos.")).toBeNull();
  });

  test("languages without spaces", () => {
    expect(show("猫", "我有一只猫。", "zh")).toBe("我有一只___。");
  });

  test("nothing left but the word, or nothing to blank", () => {
    expect(show("hola", "¡Hola!")).toBeNull();
    expect(show("perro", "")).toBeNull();
    expect(gapped("perro", undefined, "es")).toBeNull();
  });
});
