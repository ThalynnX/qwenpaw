# Evaluation results

This directory contains manually submitted evaluation results. Benchmark execution,
credentials, images, and trajectory storage belong to the external evaluation system.
No workflow in this feature starts an agent or provisions compute.

## Submit results

1. Copy `example.json` to `results/<id>.json`, and update `$schema` to
   `../schema.json`. Set `id` to the filename without `.json`.
2. Fill in the SDK version, full source commit, UTC timestamp, dataset revisions,
   and model/provider results. The example is intentionally unscored and is never
   published. Do not put real results in the demo directory.
3. Run `pnpm --dir website evaluation:build` for validation, or
   `pnpm --dir website build` for a full website build.
4. Submit a PR. Merging result changes into `main` triggers the existing website
   deployment. Never edit generated `public/evaluation/data/index.json`.

Use one file per evaluation run; a file can contain several models. Results are
**append-only**: after merging, never edit, delete or rename a result JSON. Each
SDK version, rerun or correction gets a new ID and filename; old records remain
visible. CI compares against the PR base commit and rejects changes to existing
result files. To check locally, run `node website/scripts/build-evaluation-index.mjs
<base-commit>`.

Every file declares `board: { "id": "qwenpaw", "name": "QwenPaw", "group_by":
"model" }`. Files with the same board ID belong to the same collection and must
use the same name and grouping. `model` highlights the best SDK run per
provider/model; `model_harness` groups by provider/model/harness. The collection
selector appears only when JSON contains multiple boards. Domain and benchmark
options come from the selected collection’s results. There is no visibility toggle.

Different protocols are displayed separately. Within a board and `index_version`,
benchmark IDs, dataset revisions, domains and expected counts must match across
files; change the protocol version when changing the suite.

Scores are percentages **0–100**, model costs are **USD per task**, runtime is
**seconds per task**. A score is publishable only when `scored === expected`;
failed model attempts count as scored tasks with zero reward. Infrastructure
failures and missing tasks do not count as scored. Missing benchmark results
become incomplete; the composite is unavailable until every benchmark has a
score. The composite and domain sub-leaderboards use equal benchmark weights,
not task-count weights. Domains are tags, so a benchmark may belong to more than
one domain.

Unknown cost is `null`, with `cost_source` and `cost_basis` both `unknown`.
Zero means a measured zero cost, not missing information. Mark token-price
calculations as `snapshot_estimated`; mark a conservative bound as `upper_bound`.
Bounds are shown but excluded from the cost/performance Pareto frontier.
The website does not call pricing APIs or calculate charges from tokens.

`trajectory_url` is optional per model result. `workflow_url` is optional per run.
Use permanent public HTTPS URLs without credentials, query parameters or fragments;
do not submit expiring signed URLs, keys, raw trajectories or dataset attachments.
A record links to the external trajectory archive and can be downloaded as JSON.
Schema validation checks structure and consistency, not whether a reported score
is trustworthy: review the external evidence before merging.

All submitted files are published. Board metadata controls presentation, not access
permissions. Do not commit private evaluation data to this public repository.

## Preview

`/evaluation/` reads only submitted results. With no result files, it displays an
empty state. `/evaluation/demo/` is a separate, explicitly labeled mock page;
its data never enters the real leaderboard. There are no initial measured scores
in this PR. `example.json` is an input-format example, not a score submission.
