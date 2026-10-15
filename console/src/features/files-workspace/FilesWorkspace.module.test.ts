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
  it("uses the shared mobile breakpoint for an empty workspace", () => {
    const mobileStart = stylesSource.indexOf("@media (max-width: 768px)");
    const mobileRule = stylesSource.slice(mobileStart);

    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(mobileRule).toMatch(
      /\.workspaceEmpty\s*\{[\s\S]*?\.navigator\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/,
    );
    expect(mobileRule).toMatch(
      /\.workspaceEmpty\s*\{[\s\S]*?\.documentSurface\s*\{[\s\S]*?display:\s*none;/,
    );
  });
});
