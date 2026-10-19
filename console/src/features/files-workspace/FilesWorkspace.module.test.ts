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

type MobileActivityGeometry = {
  buttonHeight: number;
  buttonWidth: number;
  gap: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  railBorderRight: number;
  railWidth: number;
};

const readPixels = (value: string) => Number.parseFloat(value) || 0;

const expandBox = (value: string) => {
  const values = value.split(/\s+/).map(readPixels);
  const [top = 0, right = top, bottom = top, left = right] = values;
  return { top, right, bottom, left };
};

const getMobileActivityGeometry = async (
  viewportWidth: number,
): Promise<MobileActivityGeometry> => {
  const { css } = await less.render(stylesSource, {
    filename: join(
      process.cwd(),
      "src/features/files-workspace/FilesWorkspace.module.less",
    ),
  });
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);

  const rail = new Map<string, string>();
  const button = new Map<string, string>();
  const collect = (rules: CSSRuleList, mediaMatches = true) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        const mediaRule = rule as CSSMediaRule;
        const maxWidth = /max-width:\s*(\d+)px/.exec(
          mediaRule.conditionText,
        )?.[1];
        const minWidth = /min-width:\s*(\d+)px/.exec(
          mediaRule.conditionText,
        )?.[1];
        collect(
          mediaRule.cssRules,
          mediaMatches &&
            (!maxWidth || viewportWidth <= Number(maxWidth)) &&
            (!minWidth || viewportWidth >= Number(minWidth)),
        );
        continue;
      }
      if (!mediaMatches || rule.type !== CSSRule.STYLE_RULE) continue;
      const styleRule = rule as CSSStyleRule;
      const declarations =
        styleRule.selectorText === ".activityRail"
          ? rail
          : styleRule.selectorText === ".activityRail button"
          ? button
          : null;
      if (!declarations) continue;
      for (const property of styleRule.style) {
        declarations.set(property, styleRule.style.getPropertyValue(property));
      }
    }
  };

  try {
    collect(style.sheet!.cssRules);
    const padding = expandBox(rail.get("padding") ?? "0");
    return {
      railWidth: readPixels(rail.get("width") ?? "0"),
      railBorderRight: readPixels(
        rail.get("border-right-width") ?? rail.get("border-right") ?? "0",
      ),
      paddingTop: padding.top,
      paddingRight: padding.right,
      paddingBottom: padding.bottom,
      paddingLeft: padding.left,
      gap: readPixels(rail.get("gap") ?? "0"),
      buttonWidth: readPixels(button.get("width") ?? "0"),
      buttonHeight: readPixels(button.get("height") ?? "0"),
    };
  } finally {
    style.remove();
  }
};

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

  it.each([390, 768])(
    "keeps both activity targets touch-sized and center-hittable at %ipx",
    async (viewportWidth) => {
      const geometry = await getMobileActivityGeometry(viewportWidth);
      const railContentWidth =
        geometry.railWidth -
        geometry.paddingLeft -
        geometry.paddingRight -
        geometry.railBorderRight;

      expect(geometry.buttonWidth).toBeGreaterThanOrEqual(44);
      expect(geometry.buttonHeight).toBeGreaterThanOrEqual(44);
      expect(railContentWidth).toBeGreaterThanOrEqual(geometry.buttonWidth);

      const targets = ["files", "git"].map((name, index) => ({
        name,
        left: geometry.paddingLeft,
        top:
          geometry.paddingTop + index * (geometry.buttonHeight + geometry.gap),
        width: geometry.buttonWidth,
        height: geometry.buttonHeight,
      }));
      const hitTest = (x: number, y: number) =>
        targets.find(
          (target) =>
            x >= target.left &&
            x <= target.left + target.width &&
            y >= target.top &&
            y <= target.top + target.height,
        )?.name;

      for (const target of targets) {
        expect(
          hitTest(
            target.left + target.width / 2,
            target.top + target.height / 2,
          ),
        ).toBe(target.name);
      }
    },
  );

  it("keeps the desktop activity geometry unchanged above 768px", async () => {
    const geometry = await getMobileActivityGeometry(769);

    expect(geometry.railWidth).toBe(46);
    expect(geometry.buttonWidth).toBe(34);
    expect(geometry.buttonHeight).toBe(34);
  });
});
