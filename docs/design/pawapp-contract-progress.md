# PawApp contract implementation status — 2026-10-15

The contract now supports managed small Apps and existing external adapters on
one Host task model. The compatible Engine revision is published; Host browser acceptance and
hosted CI are being completed against the exact pairing below.

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
The Engine is fork revision `df044e8d91733982851befbe0e740883b2632a92`,
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
| Host/PawApp/plugin and selected Creator/File Browser tests | 958 passed, 7 skipped (before the additional CLI validation regression) |
| Engine session stores and affected API suites | 126 passed |
| Separate-process Host–Engine integration | 16 passed |
| Console SDK/task API/task card tests | 66 passed |
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
