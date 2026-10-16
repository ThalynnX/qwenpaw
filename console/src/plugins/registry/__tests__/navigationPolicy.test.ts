import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNavigationPolicy,
  parseNavigationAllowlist,
} from "../navigationPolicy";
import type { MenuItem } from "../types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("host navigation policy", () => {
  const items: MenuItem[] = [
    { id: "core.group", label: "Group", isGroup: true },
    { id: "core.models", label: "Models", parentId: "core.group" },
    { id: "core.mcp", label: "MCP", parentId: "core.group" },
    { id: "core.files", label: "Files" },
  ];

  it("preserves the existing snapshot and settings when not configured", () => {
    const policy = createNavigationPolicy();
    expect(policy.filterMenuItems(items)).toBe(items);
    expect(policy.isAllowed("core.mcp")).toBe(true);
    expect(parseNavigationAllowlist(undefined)).toBeUndefined();
    expect(parseNavigationAllowlist("")).toBeUndefined();
  });

  it("retains allowed leaves and their groups without requiring group IDs", () => {
    const policy = createNavigationPolicy(["core.models"]);
    expect(policy.filterMenuItems(items).map((item) => item.id)).toEqual([
      "core.group",
      "core.models",
    ]);
    expect(policy.isAllowed("core.mcp")).toBe(false);
    expect(policy.isAllowed("core.models")).toBe(true);
    // Route-less application preferences remain reachable.
    expect(policy.isAllowed(undefined)).toBe(true);
  });

  it("supports an empty allowlist and rejects malformed configuration", () => {
    expect(createNavigationPolicy([]).filterMenuItems(items)).toEqual([]);
    expect(parseNavigationAllowlist('["core.models"]')).toEqual([
      "core.models",
    ]);
    for (const value of [
      "null",
      "{}",
      "true",
      "[1]",
      '[""]',
      '[" core.models"]',
      "broken",
    ]) {
      expect(() => parseNavigationAllowlist(value)).toThrow(
        /VITE_QWENPAW_NAVIGATION_ALLOWLIST/,
      );
    }
  });

  it("prunes empty groups and terminates for malformed parent cycles", () => {
    const policy = createNavigationPolicy(["leaf", "empty"]);
    expect(
      policy
        .filterMenuItems([
          { id: "empty", label: "Empty", isGroup: true },
          { id: "a", label: "A", isGroup: true, parentId: "b" },
          { id: "b", label: "B", isGroup: true, parentId: "a" },
          { id: "leaf", label: "Leaf", parentId: "a" },
        ])
        .map((item) => item.id),
    ).toEqual(["a", "b", "leaf"]);
  });

  it("filters the real registry from first registration through plugin disposal", async () => {
    vi.stubEnv(
      "VITE_QWENPAW_NAVIGATION_ALLOWLIST",
      '["core.models","example.page"]',
    );
    vi.resetModules();
    const { menuRegistry } = await import("../store");
    menuRegistry.addBuiltin(items);
    const first = menuRegistry.snapshot("primary.settings");
    expect(first.map((item) => item.id)).toEqual(["core.group"]);
    expect(
      (first[0] as MenuItem & { __children: MenuItem[] }).__children.map(
        (item) => item.id,
      ),
    ).toEqual(["core.models"]);
    expect(menuRegistry.snapshot("primary.settings")).toBe(first);
    const { filterSidebarMenuItems } = await import(
      "../../../layouts/registry/sidebarEntries"
    );
    // Fresh, saved and reset preferences can select only the host snapshot.
    for (const preferences of [[], ["core.models", "core.mcp"], ["core.mcp"]]) {
      const visible = filterSidebarMenuItems(
        first,
        new Set(preferences),
        new Set(),
      );
      expect(visible.some((item) => item.id === "core.mcp")).toBe(false);
    }
    menuRegistry.add("later", { id: "core.future", label: "New default" });
    const entry = menuRegistry.add("example", {
      id: "example.page",
      label: "Example",
    });
    expect(menuRegistry.snapshot().map((item) => item.id)).toEqual([
      "core.group",
      "core.models",
      "example.page",
    ]);
    entry.dispose();
    menuRegistry.refresh();
    expect(menuRegistry.snapshot().map((item) => item.id)).toEqual([
      "core.group",
      "core.models",
    ]);
    const hidden = menuRegistry.replace("example", "core.models", {
      id: "core.models",
      label: "Models",
      parentId: "core.group",
      visible: () => false,
    });
    expect(menuRegistry.snapshot("primary.settings")).toEqual([]);
    hidden.dispose();
    expect(
      menuRegistry.snapshot("primary.settings").map((item) => item.id),
    ).toEqual(["core.group"]);
  });
});
