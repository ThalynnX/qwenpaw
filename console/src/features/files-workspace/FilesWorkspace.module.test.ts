import { readFileSync } from "node:fs";
import { join } from "node:path";
import less from "less";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(
  join(
    process.cwd(),
    "src/features/files-workspace/FilesWorkspace.module.less",
  ),
  "utf8",
);

describe("FilesWorkspace responsive layout", () => {
  it("uses mutually exclusive full-width panes at the mobile breakpoint", () => {
    const mobileStart = stylesSource.indexOf("@media (max-width: 768px)");
    const mobileRule = stylesSource.slice(mobileStart);

    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(mobileRule).toMatch(
      /\.navigatorPane\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/,
    );
    expect(mobileRule).toMatch(
      /\.workspace\[data-mobile-pane="document"\][\s\S]*?\.navigatorPane[\s\S]*?\.sourcePanel\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(mobileRule).toMatch(
      /\.workspace\[data-mobile-pane="navigator"\][\s\S]*?\.documentSurface\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(mobileRule).toMatch(
      /\.workspace\[data-mobile-pane="source"\][\s\S]*?\.documentSurface\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(mobileRule).toMatch(
      /\.sourcePanel\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/,
    );
  });

  it("keeps navigator/source-control and document splits at 820px", () => {
    const mobileStart = stylesSource.indexOf("@media (max-width: 768px)");
    const desktopRule = stylesSource.slice(0, mobileStart);

    expect(desktopRule).toMatch(
      /\.navigator\s*\{[\s\S]*?width:\s*clamp\(210px,\s*22%,\s*290px\);[\s\S]*?min-width:\s*190px;/,
    );
    expect(desktopRule).toMatch(
      /\.documentSurface\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-width:\s*360px;/,
    );
    expect(desktopRule).toMatch(
      /\.sourcePanel\s*\{[\s\S]*?width:\s*clamp\(240px,\s*26%,\s*320px\);[\s\S]*?min-width:\s*220px;/,
    );
  });

  it("keeps mobile pane controls at least 44px at the default font scale", async () => {
    const { css } = await less.render(stylesSource, {
      filename: join(
        process.cwd(),
        "src/features/files-workspace/FilesWorkspace.module.less",
      ),
    });
    const controlHeight =
      /min-height:\s*max\((\d+)px,\s*calc\(\1px \* var\(--app-font-scale\)\)\);/g;
    const sourcePanelRule = css.match(/\.sourcePanel > header \{[^}]+\}/)?.[0];
    const mobileSwitchRule = Array.from(
      css.matchAll(/\.mobilePaneSwitch \{[^}]+\}/g),
      (match) => match[0],
    ).find((rule) => rule.includes("min-height"));

    expect(sourcePanelRule).toBeDefined();
    expect(mobileSwitchRule).toBeDefined();
    for (const rule of [sourcePanelRule!, mobileSwitchRule!]) {
      const baseline = Number(controlHeight.exec(rule)?.[1]);
      controlHeight.lastIndex = 0;
      const defaultFontScale = 1;
      const computedMinHeight = Math.max(baseline, baseline * defaultFontScale);
      expect(computedMinHeight).toBeGreaterThanOrEqual(44);
    }
  });
});
