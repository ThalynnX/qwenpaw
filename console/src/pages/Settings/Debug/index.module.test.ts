import { readFileSync } from "node:fs";
import { join } from "node:path";
import less from "less";
import { afterEach, describe, expect, it } from "vitest";

const stylesheetPath = join(
  process.cwd(),
  "src/pages/Settings/Debug/index.module.less",
);
const stylesheetSource = readFileSync(stylesheetPath, "utf8");

function getActiveCss(css: string, width: number) {
  const source = document.createElement("style");
  source.textContent = css;
  document.head.appendChild(source);

  const activeRules = Array.from(source.sheet?.cssRules ?? []).flatMap(
    (rule) => {
      if (rule.type !== CSSRule.MEDIA_RULE) return rule.cssText;

      const mediaRule = rule as CSSMediaRule;
      const maxWidth = mediaRule.conditionText.match(/max-width:\s*(\d+)px/);
      if (maxWidth && width > Number(maxWidth[1])) return [];
      return Array.from(mediaRule.cssRules, (nestedRule) => nestedRule.cssText);
    },
  );
  source.remove();
  return activeRules.join("\n");
}

describe("Debug responsive toolbar", () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it.each([
    { width: 820, direction: "column", alignment: "stretch" },
    { width: 1280, direction: "row", alignment: "center" },
  ])(
    "uses a $direction toolbar at $width px",
    async ({ width, direction, alignment }) => {
      const { css } = await less.render(stylesheetSource, {
        filename: stylesheetPath,
      });
      const activeStyles = document.createElement("style");
      activeStyles.textContent = getActiveCss(css, width);
      document.head.appendChild(activeStyles);

      const toolbar = document.createElement("div");
      toolbar.className = "toolbar";
      document.body.appendChild(toolbar);

      const computed = getComputedStyle(toolbar);
      expect(computed.flexDirection).toBe(direction);
      expect(computed.alignItems).toBe(alignment);
    },
  );
});
