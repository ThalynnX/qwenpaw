import { readFileSync } from "node:fs";
import { join } from "node:path";
import less from "less";
import { describe, expect, it } from "vitest";

const stylesheetPath = join(
  process.cwd(),
  "src/pages/Settings/Environments/index.module.less",
);
const stylesheetSource = readFileSync(stylesheetPath, "utf8");

describe("Environments container-responsive rows", () => {
  it("switches to the compact row layout from container width", async () => {
    const { css } = await less.render(stylesheetSource, {
      filename: stylesheetPath,
    });

    expect(css).toMatch(/\.content\s*{[^}]*container-type:\s*inline-size;/s);
    expect(css).toMatch(
      /@container\s*\(max-width:\s*760px\)\s*{[\s\S]*?\.row\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/,
    );
    expect(css).toMatch(
      /@container\s*\(max-width:\s*760px\)\s*{[\s\S]*?\.actions\s*{[^}]*grid-column:\s*1\s*\/\s*-1;/,
    );
  });

  it("does not hide overflow as the responsive fallback", async () => {
    const { css } = await less.render(stylesheetSource, {
      filename: stylesheetPath,
    });
    const containerRule = css.match(
      /@container\s*\(max-width:\s*760px\)\s*{([\s\S]*)$/,
    )?.[1];

    expect(containerRule).toBeDefined();
    expect(containerRule).not.toMatch(/overflow-x:\s*hidden/);
  });
});
