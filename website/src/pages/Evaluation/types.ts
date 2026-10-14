export interface Benchmark {
  benchmark: string;
  domains: string[];
  expected: number;
  scored: number;
  score: number | null;
  mean_runtime_seconds: number | null;
  mean_model_cost_usd: number | null;
  cost_sources: Record<string, number>;
  cost_bases: Record<string, number>;
}
export interface RecordResult {
  trajectory_url?: string;
  provider?: string;
  model: string;
  harness: string;
  sdk_version: string;
  source_sha: string;
  complete: boolean;
  benchmarks: Benchmark[];
}
export interface Run {
  schema_version: 1;
  board: { id: string; name: string; group_by: "model" | "model_harness" };
  index_version: string;
  id: string;
  evaluation_sha: string;
  date: string;
  workflow_url: string;
  records: RecordResult[];
  complete: boolean;
}
export interface History {
  schema_version: 1;
  runs: Run[];
}
export interface Row extends RecordResult {
  id: string;
  run: Run;
  score: number | null;
  cost: number | null;
  runtime: number | null;
  upperBound: boolean;
  coverage: string;
}
export const benchmarks: Record<string, string> = {
  gaia: "GAIA",
  "spreadsheetbench-verified": "SpreadsheetBench Verified",
  "swebench-verified": "SWE-bench Verified",
};
export function mean(values: (number | null)[]): number | null {
  return !values.length || values.some((value) => value === null)
    ? null
    : (values as number[]).reduce((a, b) => a + b, 0) / values.length;
}
export function selectRows(runs: Run[], metric: string): Row[] {
  return runs.flatMap((run) =>
    run.records.map((record, i) => {
      const parts = record.benchmarks.filter(
        (part) =>
          metric === "index" ||
          metric === `benchmark:${part.benchmark}` ||
          part.domains.some((domain) => metric === `domain:${domain}`),
      );
      return {
        ...record,
        run,
        id: `${run.id}-${i}`,
        score: mean(parts.map((p) => p.score)),
        cost: mean(parts.map((p) => p.mean_model_cost_usd)),
        runtime: mean(parts.map((p) => p.mean_runtime_seconds)),
        upperBound: parts.some((p) => p.cost_bases.upper_bound > 0),
        coverage: `${parts.filter((p) => p.scored === p.expected).length}/${
          parts.length
        }`,
      };
    }),
  );
}
export function logo(model: string): string | undefined {
  const provider = model.toLowerCase().startsWith("qwen")
    ? "qwen"
    : model.toLowerCase().startsWith("deepseek")
    ? "deepseek"
    : model.toLowerCase().startsWith("glm")
    ? "zai"
    : undefined;
  if (!provider) return undefined;
  return `${import.meta.env.BASE_URL}evaluation/logos/${provider}.svg`;
}
export function money(
  cost: number | null,
  locale: string,
  unknown: string,
): string {
  return cost === null
    ? unknown
    : new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cost < 0.01 ? 4 : 3,
        maximumFractionDigits: cost < 0.01 ? 4 : 3,
      }).format(cost);
}
export function safeWorkflow(url: string): string | undefined {
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(
    url,
  )
    ? url
    : undefined;
}
