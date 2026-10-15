# PawApp contract implementation status — 2026-10-15

The contract now supports managed small Apps and existing external adapters on
one Host task model. The compatible Engine revision is published; Host browser acceptance has passed against the exact pairing below.
Hosted contract CI passed; the final full-repository lint cleanup is being
verified separately.

| Area | Implementation |
| --- | --- |
| Public contract | Python export surface, generated JSON Schema and TS types, SDK response validation, typed executor event fields with legacy normalization |
| Results | Schema-checked structured result beside human summary, artifact refs and project; bounded continuation projection |
| Small Apps | `app.action` / handler registration, Host-owned submission/event/command journal, explicit restart policy |
| Scoped SDKs | Python task/setup/artifact clients; frontend task/setup/artifact namespaces; Host-managed Direct origin; explicit request IDs |
| Main Chat | Generic task labels and action guidance; delegated-only discovery; existing task continuation, questions and handoffs retained |
| Data scope | Legacy session route ownership checks, owner-filtered list pagination in SQL and JSON stores, body/form checks, Host compatibility gate |
| Example migration | File Browser `browse-directory` uses a managed handler, structured result and frontend SDK |
| Compatibility | Published Engine commit pinned by revision, preparation script, schema drift check and contract CI workflow |

## Tested pairing

The machine-readable source is
[`tests/fixtures/pawapp-compatibility.json`](../../tests/fixtures/pawapp-compatibility.json).
The Engine is fork revision `2f9a44461525d04dffc9f719f1745ee741ec06cd`,
which includes the scoped-session ownership changes. CI checks out and verifies
that exact revision. No compatibility patch is required. Run
`scripts/prepare-pawapp-engine.py <checkout>` to verify the pairing locally.

The Host requires the Engine's `scoped_sessions` capability before exposing
legacy session APIs. Protocol version 1 alone is insufficient. An older Engine
fails closed, including the previous unpatched base.

## Migration and scope invariants

Existing descriptors without result_schema keep their prior grant digest.
Guidance is not authorization material. Typed shared event fields normalize to
the old replay meaning, preserving durable event receipts. The SQLite v4 task
store gains additive managed journal tables; existing adapters/tasks remain on
their original protocol and identities. Data's previous native chat origin IDs
are retained behind the shared origin helper.

File Browser's old `list-directory` descriptor and adapter remain App-private to
recover tasks already accepted. The new `browse-directory` action has a new
schema and requires its own grant in App access; old grants are retained and
are not silently widened. Saved task pointers can still display legacy JSON
text results. New requests use structured results and persist an intent before
sending, so uncertain retries keep the same request ID.

Artifact access remains user/workspace/App scoped, with exact-version grants
for cross-App handoffs. Sessions provide provenance, not a blanket isolation
boundary within that scope. The Engine's Host-supplied identity encodes user and
workspace; its legacy routes now enforce the same ownership as submissions.

## Verification and limits

The suites cover descriptor/event compatibility, generic task lifecycle,
questions and command receipts, restart interruption and replay, project and
experience projection, artifact publication and scope isolation, Direct SDK
origin creation and retry, frontend validation and workspace pinning. Real
Host–Engine tests use separate processes, HTTP/SSE, SQLite and controlled
execution; both Engine storage implementations have owner-pagination coverage.

Local verification results:

| Check | Result |
| --- | --- |
| Host/PawApp/plugin and selected Creator/File Browser tests | 1,000 passed, 7 skipped (Host/plugins/config/CLI); 192 Creator and 49 Console/boundary tests passed |
| Engine session stores and affected API suites | 126 passed |
| Separate-process Host–Engine integration | 16 passed |
| Console SDK/task API/task card tests | 72 passed (including 6 plugin-loader tests) |
| Data UI tests | 3 passed |
| Console/Data UI TypeScript, generated contract drift, Python lint, new SDK ESLint, diff checks | Passed |

The direct setup test was also rerun after adding SDK-route coverage. The managed stream race regression forces a terminal commit between reads;
the consumer must receive and persist that final event. The seven Host/plugin skips are environment-dependent tests.

The live Creator preflight on 2026-10-15 failed because its saved credential
could not be decrypted. It made zero provider submissions. A usable credential
is required before live-provider acceptance can pass. Browser acceptance and
hosted CI results will be recorded separately from these local tests. Managed
handlers run within the Host process and must explicitly opt into replay-safe
execution. Setup completion and policy grants remain Host/backend operations.

For the integration recipe, see the [App quickstart](pawapp-app-quickstart.md).
For the underlying architecture, see [task runtime](pawapp-task-runtime.md) and
[Data adapter](pawapp-data-task-adapter.md).

Acceptance fixes on 2026-10-15: managed streams now read run state before the
event snapshot, preventing a concurrent completion from being dropped. CLI
module validation accepts the same `app` export as the runtime loader, allowing
PawApps to pass installation validation. Console production build and its
bundle/CSS checks passed.

## Browser acceptance — 2026-10-15

The production Console and real Host ran on loopback in an isolated acceptance
working directory. File Browser was installed through the CLI/API and activated
through its normal App route. Browser checks verified:

- Ungranted listing is rejected with the App access link.
- `browse-directory` accepts an exact directory grant saved in Settings.
- The granted listing renders its structured result (`acceptance.txt`, 35 B).
- Reload restores the completed task without a duplicate run.
- The parent directory remains forbidden under that exact grant.
- Saving the default and omitting the input produces the same authorized result.

Cold App navigation exposed late installation of Host hooks. The loader now
installs the SDK before executing any App script; a regression test covers the
ordering. The corrected production build passed the browser flow without a new
render error. The broader Creator UI check also exposed three old whole-film
fixtures that used `timeline_render`; they now explicitly use `final_video`,
matching the canonical-film contract. All six tests in that file passed.

Restart acceptance also uncovered repeated rewriting of workspace paths when a
custom working directory lived below `~/.copaw`. Normalization now preserves
paths already inside the current root and requires a directory boundary for
legacy prefixes. All 58 config utility tests pass. After repairing the isolated
fixture's already-rewritten path, the existing listing was readable again with
no additional managed task and no browser errors.

The Engine cron test now waits for its terminal event as well as completed chat
state: those are separate durable writes. The updated exact Engine pin includes
that deterministic test fix. Hosted Creator and Console/website format checks passed.
[Contract conformance passed](https://github.com/cyruszhang/QwenPaw/actions/runs/38765983418)
against the updated Engine pin. Full-repository lint cleanup was then applied;
all changed files pass pre-commit, and the full-repository mypy check passes.

A further restart without repairing any state confirmed both original tasks
remain accessible with HTTP 200 and `succeeded`, exactly two managed runs, and
an unchanged workspace path. The acceptance runtime is isolated from the normal
Host installation; this is local deployment evidence, not a production rollout.

The final cleanup applies repository formatting to the earlier acceptance
scripts, corrects the capability-builder input annotation and Console queue
narrowing, and documents Pylint limitations for isolated plugin module names and
dynamic callable classes. Lifecycle complexity exceptions are scoped to the
specific state-machine functions/guards. No global lint rule was weakened.

Live-provider acceptance remains the only credential-dependent gate. Restore
the Creator Wan credential in its settings, then run the bounded acceptance
recipe in [real-provider acceptance](pawapp-real-provider-acceptance.md).
The failed preflight made zero provider submissions.
