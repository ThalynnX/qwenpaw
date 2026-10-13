import type { MenuItem } from "./types";

const CONFIG_KEY = "VITE_QWENPAW_NAVIGATION_ALLOWLIST";

/** An absent value preserves upstream navigation; [] hides all menu leaves. */
export function parseNavigationAllowlist(raw?: string): string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_KEY} must be a JSON array of non-empty IDs`);
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (id) => typeof id === "string" && id.length > 0 && id.trim() === id,
    )
  ) {
    throw new Error(`${CONFIG_KEY} must be a JSON array of non-empty IDs`);
  }
  return value;
}

/** Presentation policy owned by the host build, independent of plugins/prefs. */
export function createNavigationPolicy(ids?: readonly string[]) {
  const allowed = ids === undefined ? undefined : new Set(ids);
  return {
    // Route-less application preferences (General) remain reachable.
    isAllowed: (id?: string): boolean =>
      id === undefined || allowed === undefined || allowed.has(id),
    filterMenuItems(items: MenuItem[]): MenuItem[] {
      if (allowed === undefined) return items;
      const byId = new Map(items.map((item) => [item.id, item]));
      const keep = new Set<string>();
      for (const item of items) {
        if (item.isGroup || !allowed.has(item.id)) continue;
        keep.add(item.id);
        const visited = new Set<string>([item.id]);
        let parentId = item.parentId;
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = byId.get(parentId);
          if (!parent) break;
          if (parent.isGroup) keep.add(parent.id);
          parentId = parent.parentId;
        }
      }
      return items.filter((item) => keep.has(item.id));
    },
  };
}

// Vite substitutes this at build time, before the first registry snapshot.
// The guard also permits importing the parser in vite.config.ts (Node).
export const hostNavigationPolicy = createNavigationPolicy(
  parseNavigationAllowlist(import.meta.env?.VITE_QWENPAW_NAVIGATION_ALLOWLIST),
);
