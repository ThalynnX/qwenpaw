import { describe, expect, it } from "vitest";

import en from "./en.json";
import id from "./id.json";
import ja from "./ja.json";
import ptBR from "./pt-BR.json";
import ru from "./ru.json";
import vi from "./vi.json";
import zh from "./zh.json";

const locales = { en, id, ja, "pt-BR": ptBR, ru, vi, zh };

describe("inbox locales", () => {
  it.each(Object.entries(locales))(
    "%s provides the push-message load failure copy",
    (_language, locale) => {
      expect(locale.inbox.loadFailed.trim()).not.toBe("");
    },
  );
});
