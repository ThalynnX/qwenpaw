import { describe, expect, it } from "vitest";
import en from "./en.json";
import id from "./id.json";
import ja from "./ja.json";
import ptBR from "./pt-BR.json";
import ru from "./ru.json";
import vi from "./vi.json";
import zh from "./zh.json";

const locales = { en, id, ja, "pt-BR": ptBR, ru, vi, zh };
const questionKeys = [
  "questionTitle",
  "otherAnswer",
  "yourAnswer",
  "submitAnswer",
  "previousQuestion",
  "nextQuestion",
  "questionProgress",
  "recommended",
] as const;

describe("approval question translations", () => {
  it.each(Object.entries(locales))(
    "%s includes every question form label",
    (_language, messages) => {
      for (const key of questionKeys) {
        expect(messages.approval[key], key).toBeTypeOf("string");
        expect(messages.approval[key].trim(), key).not.toBe("");
      }
    },
  );
});
