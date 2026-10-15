const LARGE_BASE64_CHARS = 4_096;
const RAW_DISPLAY_CHAR_BUDGET = 100_000;
const RAW_DISPLAY_NODE_BUDGET = 2_000;
const RAW_DISPLAY_DEPTH_BUDGET = 100;

type BudgetKind = "character" | "node";

function budgetSummary(kind: BudgetKind): string {
  const limit =
    kind === "character"
      ? `${RAW_DISPLAY_CHAR_BUDGET}-character`
      : `${RAW_DISPLAY_NODE_BUDGET}-node`;
  return (
    `[Raw value omitted: exceeds the ${limit} display budget. ` +
    "Switch to Current view or rerun the tool with narrower output.]"
  );
}

function inspectDisplayBudget(value: unknown): BudgetKind | null {
  let characters = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const inspect = (item: unknown, depth: number): BudgetKind | null => {
    nodes += 1;
    if (nodes > RAW_DISPLAY_NODE_BUDGET || depth > RAW_DISPLAY_DEPTH_BUDGET) {
      return "node";
    }

    if (typeof item === "string") {
      characters += item.length;
      return characters > RAW_DISPLAY_CHAR_BUDGET ? "character" : null;
    }
    if (item === null || item === undefined) return null;
    if (typeof item !== "object") {
      characters += String(item).length;
      return characters > RAW_DISPLAY_CHAR_BUDGET ? "character" : null;
    }
    if (ancestors.has(item)) return null;

    ancestors.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const exceeded = inspect(child, depth + 1);
        if (exceeded) return exceeded;
      }
    } else {
      const container = item as Record<string, unknown>;
      for (const key in container) {
        if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
        characters += key.length;
        if (characters > RAW_DISPLAY_CHAR_BUDGET) return "character";
        const exceeded = inspect(container[key], depth + 1);
        if (exceeded) return exceeded;
      }
    }
    ancestors.delete(item);
    return null;
  };

  return inspect(value, 0);
}

function base64Placeholder(length: number): string {
  return `[base64 data omitted: ${length} characters]`;
}

function isLargeBase64DataUrl(value: string): boolean {
  if (
    value.length <= LARGE_BASE64_CHARS ||
    value.slice(0, 5).toLowerCase() !== "data:"
  ) {
    return false;
  }

  const commaIndex = value.indexOf(",", 5);
  if (commaIndex < 5 || commaIndex > 256) return false;

  const header = value.slice(0, commaIndex).toLowerCase();
  return header.startsWith("data:") && header.endsWith(";base64");
}

function isBase64Field(
  key: string,
  container: Record<string, unknown>,
): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey.includes("base64") ||
    normalizedKey === "b64_json" ||
    (normalizedKey === "data" &&
      (container.type === "base64" || container.encoding === "base64"))
  );
}

function sanitizeForDisplay(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return "[circular reference]";
    ancestors.add(value);
    const sanitized = value.map((item) => sanitizeForDisplay(item, ancestors));
    ancestors.delete(value);
    return sanitized;
  }

  if (value && typeof value === "object") {
    if (ancestors.has(value)) return "[circular reference]";
    ancestors.add(value);
    const container = value as Record<string, unknown>;
    const sanitized = Object.fromEntries(
      Object.entries(container).map(([key, item]) => {
        if (
          typeof item === "string" &&
          (isLargeBase64DataUrl(item) ||
            (item.length > LARGE_BASE64_CHARS && isBase64Field(key, container)))
        ) {
          return [key, base64Placeholder(item.length)];
        }
        return [key, sanitizeForDisplay(item, ancestors)];
      }),
    );
    ancestors.delete(value);
    return sanitized;
  }

  return value;
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Format raw tool data for readable JSON display without mutating its value. */
export function formatRawToolValue(value: unknown): string {
  if (value === undefined) return "";

  const initialBudget = inspectDisplayBudget(value);
  if (initialBudget) return budgetSummary(initialBudget);

  const parsed = typeof value === "string" ? parseJsonString(value) : value;
  if (typeof parsed === "string") {
    return isLargeBase64DataUrl(parsed)
      ? base64Placeholder(parsed.length)
      : parsed;
  }

  if (parsed !== value) {
    const parsedBudget = inspectDisplayBudget(parsed);
    if (parsedBudget) return budgetSummary(parsedBudget);
  }

  try {
    const sanitized = sanitizeForDisplay(parsed, new WeakSet<object>());
    return JSON.stringify(sanitized, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
