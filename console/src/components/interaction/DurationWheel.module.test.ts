import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(
  join(process.cwd(), "src/components/interaction/DurationWheel.module.less"),
  "utf8",
);

describe("DurationWheel layout contract", () => {
  it("stays within its container without inline negative margins", () => {
    const durationRule = stylesSource.match(/\.duration\s*\{([^}]*)\}/)?.[1];

    expect(durationRule).toBeDefined();
    expect(durationRule).toMatch(/margin:\s*0\s+0\s+8px;/);
    expect(durationRule).not.toMatch(/margin[^;]*-\d/);
  });
});
