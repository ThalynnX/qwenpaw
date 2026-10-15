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
const boards = new Map();
const runs = [];
const files = [];
const identitiesAcrossRuns = new Set();
requireValue(
  !(await readdir(new URL("results/", root))).some((n) => n.endsWith(".json")),
  "Put results under results/testing/ or results/official/",
);
for (const kind of ["official", "testing"]) {
  for (const name of (await readdir(new URL(`results/${kind}/`, root)))
    .filter((n) => n.endsWith(".json"))
    .sort())
    files.push({ kind, name });
}
for (const { kind, name } of files) {
  const input = await read(new URL(`results/${kind}/${name}`, root));
  requireValue(validate(input), `${name}: ${ajv.errorsText(validate.errors)}`);
  requireValue(name === `${input.id}.json`, `${name}: filename must match id`);
  requireValue(
    input.kind === kind,
    `${name}: result kind must match directory`,
  );
  requireValue(
    !identitiesAcrossRuns.has(input.id),
    `${name}: duplicate run ID`,
  );
  identitiesAcrossRuns.add(input.id);
  const boardKey = JSON.stringify([kind, input.board.id]);
  const board = JSON.stringify([input.board.name, input.board.group_by]);
  requireValue(
    !boards.has(boardKey) || boards.get(boardKey) === board,
    `${name}: inconsistent board metadata`,
  );
  boards.set(boardKey, board);
  const protocolKey = JSON.stringify([
    kind,
    input.board.id,
    input.index_version,
  ]);
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
        name: b.name,
        revision: b.revision,
        judge: {
          kind: b.judge.kind,
          model: b.judge.model,
          scorer: b.judge.scorer,
          official_model: b.judge.official_model,
          prompt_revision: b.judge.prompt_revision,
          parity_note: b.judge.parity_note,
        },
        expected: b.expected,
        domains: [...b.domains].sort(),
      })),
  );
  requireValue(
    !protocols.has(protocolKey) || protocols.get(protocolKey) === protocol,
    `${name}: benchmark definitions changed; use a new index_version`,
  );
  protocols.set(protocolKey, protocol);
  const identities = new Set();
  const records = input.records.map((r) => {
    const key = JSON.stringify([r.provider, r.model, r.harness]);
    requireValue(
      !identities.has(key),
      `${name}: duplicate model/provider/harness`,
    );
    identities.add(key);
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
        original_model_cost: null,
        mean_judge_cost_usd: null,
        original_judge_cost: null,
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
      for (const role of ["model", "judge"]) {
        const original = p[`original_${role}_cost`];
        const usd = p[`mean_${role}_cost_usd`];
        requireValue(
          (original === null) === (usd === null),
          `${name}: original ${role} cost and USD cost disagree`,
        );
        if (original !== null) {
          const converted =
            original.mean_amount /
            (original.currency === "CNY" ? input.exchange_rate.cny_per_usd : 1);
          requireValue(
            Math.abs(converted - usd) <= Math.max(1, converted) * 1e-10,
            `${name}: ${role} cost does not match the fixed exchange rate`,
          );
        }
      }
      return {
        benchmark: b.id,
        name: b.name,
        judge: b.judge,
        domains: b.domains,
        expected: b.expected,
        scored: p.scored,
        score: p.score,
        mean_runtime_seconds: p.mean_runtime_seconds,
        mean_model_cost_usd: p.mean_model_cost_usd,
        original_model_cost: p.original_model_cost,
        mean_judge_cost_usd: p.mean_judge_cost_usd,
        original_judge_cost: p.original_judge_cost,
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
      source_repository: input.source_repository,
      artifact_sha256: input.artifact_sha256,
      complete: benchmarks.every((b) => b.score !== null),
      benchmarks,
    };
  });
  runs.push({
    schema_version: 2,
    kind: input.kind,
    source_repository: input.source_repository,
    artifact_sha256: input.artifact_sha256,
    exchange_rate: input.exchange_rate,
    board: input.board,
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
runs.sort((a, b) => b.date.localeCompare(a.date));
const target = new URL("../public/evaluation/data/", import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(
  new URL("index.json", target),
  JSON.stringify({ schema_version: 2, runs }, null, 2) + "\n",
);
console.log(`Evaluation index: ${runs.length} runs → ${fileURLToPath(target)}`);
