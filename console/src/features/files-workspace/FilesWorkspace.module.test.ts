import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      /\.workspace\[data-mobile-pane="document"\][\s\S]*?\.navigatorPane\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(mobileRule).toMatch(
      /\.workspace\[data-mobile-pane="navigator"\][\s\S]*?\.documentSurface\s*\{[\s\S]*?display:\s*none;/,
    );
  });

  it("keeps the navigator and document split above 768px", () => {
    const mobileStart = stylesSource.indexOf("@media (max-width: 768px)");
    const desktopRule = stylesSource.slice(0, mobileStart);

    expect(desktopRule).toMatch(
      /\.navigator\s*\{[\s\S]*?width:\s*clamp\(210px,\s*22%,\s*290px\);[\s\S]*?min-width:\s*190px;/,
    );
    expect(desktopRule).toMatch(
      /\.documentSurface\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-width:\s*360px;/,
    );
  });
});
