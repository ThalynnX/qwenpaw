import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";

const root = new URL("../evaluation/", import.meta.url);
const read = async (url) => JSON.parse(await readFile(url, "utf8"));
const ajv = new Ajv({ allErrors: true });
ajv.addFormat(
  "timestamp",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace("Z", ".000Z"),
);
ajv.addFormat("public-https-url", (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
});
const validate = ajv.compile(await read(new URL("schema.json", root)));
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const protocols = new Map();
const runs = [];
for (const name of (await readdir(new URL("results/", root)))
  .filter((n) => n.endsWith(".json"))
  .sort()) {
  const input = await read(new URL(`results/${name}`, root));
  requireValue(validate(input), `${name}: ${ajv.errorsText(validate.errors)}`);
  requireValue(name === `${input.id}.json`, `${name}: filename must match id`);
  const catalog = new Map(input.benchmarks.map((b) => [b.id, b]));
  requireValue(
    catalog.size === input.benchmarks.length,
    `${name}: duplicate benchmark`,
  );
  const protocol = JSON.stringify(
    [...catalog.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((b) => ({
        id: b.id,
        revision: b.revision,
        expected: b.expected,
        domains: [...b.domains].sort(),
      })),
  );
  requireValue(
    !protocols.has(input.index_version) ||
      protocols.get(input.index_version) === protocol,
    `${name}: benchmark definitions changed; use a new index_version`,
  );
  protocols.set(input.index_version, protocol);
  const identities = new Set();
  const records = input.records.map((r) => {
    const key = JSON.stringify([r.provider, r.model, r.harness]);
    requireValue(
      !identities.has(key),
      `${name}: duplicate model/provider/harness`,
    );
    identities.add(key);
    requireValue(
      input.visibility !== "public" || r.harness === "QwenPaw",
      `${name}: public results must use QwenPaw`,
    );
    const parts = new Map(r.benchmarks.map((p) => [p.benchmark, p]));
    requireValue(
      parts.size === r.benchmarks.length &&
        [...parts.keys()].every((k) => catalog.has(k)),
      `${name}: duplicate or unknown benchmark result`,
    );
    const benchmarks = [...catalog.values()].map((b) => {
      const p = parts.get(b.id) ?? {
        scored: 0,
        score: null,
        mean_model_cost_usd: null,
        mean_runtime_seconds: null,
        cost_source: "unknown",
        cost_basis: "unknown",
      };
      requireValue(
        p.scored <= b.expected && (p.score === null || p.scored === b.expected),
        `${name}: incomplete benchmark cannot have a published score`,
      );
      requireValue(
        (p.mean_model_cost_usd === null) === (p.cost_source === "unknown") &&
          (p.mean_model_cost_usd === null) === (p.cost_basis === "unknown"),
        `${name}: cost value and provenance disagree`,
      );
      return {
        benchmark: b.id,
        domains: b.domains,
        expected: b.expected,
        scored: p.scored,
        score: p.score,
        mean_runtime_seconds: p.mean_runtime_seconds,
        mean_model_cost_usd: p.mean_model_cost_usd,
        cost_sources: { [p.cost_source]: p.scored },
        cost_bases: { [p.cost_basis]: p.scored },
      };
    });
    return {
      model: r.model,
      provider: r.provider,
      harness: r.harness,
      trajectory_url: r.trajectory_url,
      sdk_version: input.sdk_version,
      source_sha: input.source_sha,
      complete: benchmarks.every((b) => b.score !== null),
      benchmarks,
    };
  });
  runs.push({
    schema_version: 1,
    visibility: input.visibility,
    index_version: input.index_version,
    id: input.id,
    evaluation_sha: input.source_sha,
    date: input.date,
    workflow_url: input.workflow_url ?? "",
    benchmark_versions: input.benchmarks,
    records,
    complete: records.every((r) => r.complete),
  });
}
requireValue(
  new Set(runs.map((r) => r.visibility)).size <= 1,
  "Public and private results cannot be published together",
);
runs.sort((a, b) => b.date.localeCompare(a.date));
const target = new URL("../public/evaluation/data/", import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(
  new URL("index.json", target),
  JSON.stringify(
    { schema_version: 1, visibility: runs[0]?.visibility ?? "public", runs },
    null,
    2,
  ) + "\n",
);
console.log(`Evaluation index: ${runs.length} runs → ${fileURLToPath(target)}`);
