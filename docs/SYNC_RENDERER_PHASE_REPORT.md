# Renderer account integration phase report

Implemented the approved account/settings and schedule/report integration phase under
the coordinator's explicit Codex exception. No commits, deployments, dependencies,
backend changes or schema changes. Existing uncommitted/untracked work was preserved.

## Files changed in this phase

- `renderer/sync-ui.js` (new): account controller and panel, serialization, exact edit
  bases, clean-only view application, isolation, MFA, conflict/review choices, admin
  actions, explicit import, prepared-backup protection.
- `renderer/schedule-ui.js`: account persistence and UUIDs, team settings/cities,
  operation guards, prepared-backup identity and completion, local-mode preservation.
- `renderer/report-ui.js`: account-cache records, local-preload suppression, explicit
  account import entry point.
- `renderer/app.js`, `renderer/index.html`, `renderer/styles.css`: boot, navigation,
  unavailable-account views, protection release, ephemeral authenticator-secret clearing,
  script load and bounded account-value display.
- `electron/preload.js`, `electron/sync/ipc.js`: bounded parsed-report import payload and
  optional protected base revision through the existing narrow API.
- `electron/sync/engine.js`: import parsed report records, pin the protected revision,
  expose current/expected-head values for review choices, refuse reviews while locked.
- `tests/sync-ui.test.js` (new): 17 renderer VM/harness regressions.
- `tests/sync-engine.test.js`: three additional PostgreSQL cross-layer checks.
- `README.md`, `docs/SYNC_CLIENT_STATUS.md`: delivered usage, test evidence and limits.
- `docs/SYNC_RENDERER_PHASE_REPORT.md` (this report).

## Validation

- `npm run test:renderer`: exit 0, **141 tests passed, 0 failed, 0 skipped**.
  This includes the actual temporary PostgreSQL 16 database/migration harness, with
  fake GoTrue and PostgREST routing. The first sandboxed attempt failed because macOS
  denied PostgreSQL shared memory; the successful run used approved escalation.
- `npm run test:electron`: exit 0, macOS Electron **33.4.11**, isolated temporary
  userData/sessionData only. PDF/OCR, secured IPC, loopback transport, redirect refusal,
  untrusted TLS refusal, navigation/popups, pending/focused close saves and app.quit passed.
- `node --test tests/backup-ui.test.js tests/sync-ui.test.js`: exit 0 after the final
  app secret-clearing/report-navigation adjustments.
- `node --check` passed for the changed runtime JS (`renderer/app.js`, `schedule-ui.js`,
  `report-ui.js`, `sync-ui.js`, `electron/preload.js`, `electron/sync/engine.js`, `ipc.js`).
- `git diff --check`: passed.

## Self-review corrections

- Status events no longer advance a displayed base while edits, debounce saves, focused
  inputs, pending IPC, imports/dialogs or backups are active. A delayed view is rechecked
  before application; commits serialize snapshots and use their own returned revisions.
- Revocation first flushes pending edits into the engine's locked encrypted cache before
  clearing visible account data. Account mode never falls back to original local stores.
- Folder/session identity and the first `startedAt` are persisted before protection.
  Historic starts are retained; copies receive new UUIDs and no inherited start time.
- The protected start revision survives view-history pruning. Completion against it
  conflicts with a remote edit, while following our own preparation mutation without
  producing a spurious self-conflict.
- Async schedule/import/export dialogs block account switching and remote replacement.
  Admin deletion flushes edits and retains the reviewed base through confirmation.
- MFA secrets are escaped text, held only in memory, cleared on leaving the account
  page/verification/reset, and survive unrelated status redraws during enrollment.
- Delete/restore UI requires online admin + aal2 and delegates final online authorization
  to the engine. Stale whole-assignment delete conflicts cannot be resolved through an
  operator's UI. Review choices include the displayed current head, and locked accounts
  cannot retrieve or act on drafts.
- Local report parsing is explicit and included in the import preview/confirmation;
  missing/unreadable report sources cannot be silently skipped.

## Remaining limitations and intentional behavior

- No live office/Supabase authentication, GoTrue MFA or actual PostgREST integration was
  exercised. The account UI is covered by VM and engine harnesses; the real Electron
  smoke covers local mode and transport/security/lifecycle. Windows/DPAPI, office CA
  trust on deployed machines and a second physical device remain unverified.
- Offline revocation is unknowable until a server request succeeds; the UI and docs say
  so. A protected running backup retains its captured state for completion while account
  schedule/report views are hidden on revocation.
- Schedule editing pauses while an account backup is prepared/running. Failed/cancelled
  copies remain prepared for retry; explicitly put them aside or remove/replace the
  template to release protection. Account/server switching remains blocked meanwhile.
- Fresh-device deleted-schedule history is unavailable; only previously observed deleted
  schedules can be listed. No backend API/schema was invented.
- Conflict choices can be selected and then edited normally; no manual-combine editor.
  Duplicate schedules warn and remain separate. Report records retain the existing
  natural-key/duplicate-ID contract; the preview reports those warnings.
- No SQL or Python source changed, so separate SQL-only/Python suites were not rerun.

This phase is ready for the coordinator's independent review and the next user checkpoint.
