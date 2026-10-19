import { readFileSync } from "node:fs";
import { join } from "node:path";
import less from "less";
import { afterEach, describe, expect, it } from "vitest";

const stylesheetPath = join(
  process.cwd(),
  "src/pages/Import/index.module.less",
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
      const minWidth = mediaRule.conditionText.match(/min-width:\s*(\d+)px/);
      const maxWidth = mediaRule.conditionText.match(/max-width:\s*(\d+)px/);
      if (
        (minWidth && width < Number(minWidth[1])) ||
        (maxWidth && width > Number(maxWidth[1]))
      ) {
        return [];
      }
      return Array.from(mediaRule.cssRules, (nestedRule) => nestedRule.cssText);
    },
  );
  source.remove();
  return activeRules.join("\n");
}

describe("Import responsive stylesheet", () => {
  afterEach(() => {
    document.head
      .querySelectorAll("style[data-import-test]")
      .forEach((style) => {
        style.remove();
      });
    document.body.replaceChildren();
  });

  it.each([390, 600, 601, 820])(
    "keeps the content right edge inside a 16px gutter at %ipx",
    async (width) => {
      const { css } = await less.render(stylesheetSource, {
        filename: stylesheetPath,
      });
      const activeStyles = document.createElement("style");
      activeStyles.dataset.importTest = "true";
      activeStyles.textContent = getActiveCss(css, width);
      document.head.appendChild(activeStyles);

      const content = document.createElement("main");
      content.className = "content";
      document.body.appendChild(content);

      const computed = getComputedStyle(content);
      expect(computed.paddingTop).toBe("16px");
      expect(computed.paddingRight).toBe("16px");
      expect(computed.paddingBottom).toBe("32px");
      expect(computed.paddingLeft).toBe("16px");
    },
  );
});
