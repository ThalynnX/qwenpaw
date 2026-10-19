import { describe, expect, it } from "vitest";

import en from "./en.json";
import id from "./id.json";
import ja from "./ja.json";
import ptBR from "./pt-BR.json";
import ru from "./ru.json";
import vi from "./vi.json";
import zh from "./zh.json";

const locales = { en, id, ja, "pt-BR": ptBR, ru, vi, zh };

describe("chat locales", () => {
  it.each(Object.entries(locales))(
    "%s provides chat history recovery copy",
    (_language, locale) => {
      expect(locale.chat.historyLoadFailed.trim()).not.toBe("");
    },
  );

  it("directs English users to retry instead of reopening the chat", () => {
    expect(en.chat.historyLoadFailed).toBe(
      "Could not load this conversation. Try again.",
    );
    expect(en.chat.historyLoadFailed).not.toMatch(/\breopen\b/i);
  });
});
