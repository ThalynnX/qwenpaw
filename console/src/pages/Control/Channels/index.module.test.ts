import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(
  join(process.cwd(), "src/pages/Control/Channels/index.module.less"),
  "utf8",
);

describe("Channels narrow-container styles", () => {
  it("keeps the no-text switch inside its actual form container", () => {
    const rule = stylesSource
      .split('.noTextDebounceItem:has(button[role="switch"]) {')[1]
      ?.split(".channelsPage .channelSurface")[0];

    expect(rule).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(rule).toContain("min-width: 0;");
    expect(rule).toContain("width: auto !important;");
    expect(rule).not.toMatch(/overflow\s*:/);
    expect(rule).not.toMatch(/@media/);
  });
});
