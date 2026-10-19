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
  it("observes the table width at the desktop grid boundary", async () => {
    const { css } = await less.render(stylesheetSource, {
      filename: stylesheetPath,
    });
    const contentRule = css.match(/\.content\s*{([^}]*)}/)?.[1];
    const tableRule = css.match(/\.table\s*{([^}]*)}/)?.[1];
    const rowRule = css.match(/\.row\s*{([^}]*)}/)?.[1];
    const columns = rowRule?.match(/grid-template-columns:\s*([^;]+);/)?.[1];
    const minimumTracks = Array.from(
      columns?.matchAll(/(?:minmax\()?([0-9]+)px/g) ?? [],
      (match) => Number(match[1]),
    );
    const columnGap = Number(rowRule?.match(/gap:\s*([0-9]+)px/)?.[1]);
    const inlinePadding = Number(
      rowRule?.match(/padding:\s*[0-9]+px\s+([0-9]+)px/)?.[1],
    );
    const queryWidth = Number(
      css.match(/@container\s*\(max-width:\s*([0-9]+)px\)/)?.[1],
    );
    const desktopMinimum =
      minimumTracks.reduce((total, width) => total + width, 0) +
      columnGap * (minimumTracks.length - 1) +
      inlinePadding * 2;

    expect(contentRule).not.toMatch(/container-type:/);
    expect(tableRule).toMatch(/container-type:\s*inline-size;/);
    expect(minimumTracks).toEqual([280, 150, 100, 150]);
    expect(queryWidth).toBe(desktopMinimum);
    expect(css).toMatch(
      new RegExp(
        `@container\\s*\\(max-width:\\s*${desktopMinimum}px\\)\\s*` +
          "{[\\s\\S]*?\\.row\\s*{[^}]*grid-template-columns:" +
          "\\s*minmax\\(0, 1fr\\) auto;",
      ),
    );
    expect(css).toMatch(
      new RegExp(
        `@container\\s*\\(max-width:\\s*${desktopMinimum}px\\)\\s*` +
          "{[\\s\\S]*?\\.actions\\s*{[^}]*grid-column:" +
          "\\s*1\\s*\\/\\s*-1;",
      ),
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
