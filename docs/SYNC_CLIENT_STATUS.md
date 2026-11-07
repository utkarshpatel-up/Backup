# Desktop sync client: implementation status

> **Status: sync core, secured Electron integration, account screens and renderer
> schedule/report hooks are implemented.** Local mode remains the default; account mode
> is an explicit opt-in. No server is deployed. PostgreSQL tests use fake GoTrue and
> PostgREST routing. Real Electron transport and local startup/shutdown have passed on
> macOS; real Supabase authentication, Windows and a second physical device remain unverified.

## Renderer account integration

- `renderer/sync-ui.js` owns the displayed revision and serialized durable commit chain.
  Status notifications cannot replace a dirty, focused, saving, importing, busy or
  prepared/running-backup view. The revision advances only after that view is applied
  or its own commit succeeds. Busy assignments are explicitly excluded from diffs.
- The Account button opens opt-in server configuration, sign-in/out, status and pending/
  held/failed counts, Sync now, authenticator enrollment and verification, conflict
  alternatives and saved-draft review. Remote values are escaped text; passwords and
  authenticator codes are cleared after use. The enrollment secret is memory-only and
  cleared on leaving/reopening the account flow, verification or account reset.
- All operators can view/edit team schedules and add/remove rows. Assignments and rows
  use UUIDs, and copied rows receive fresh UUIDs. Only an online admin with `aal2` can
  request whole-schedule delete/restore; the engine rechecks membership online. Deletion
  uses the displayed view's aggregate revision. Conflicts can be resolved using a shown
  alternative and then edited normally; no manual-combine editor is provided.
- Team defaults, starts, learned memory, cities and report records come from the account
  cache. Paths and machine preferences stay local. Account report preload cannot read
  or replace records from a local report source. The import action parses that XLSX in
  the renderer and passes its records to `engine.importLocal` for preview and explicit
  confirmation. Local originals are preserved. Possible duplicate schedules are warned
  about and kept separately; report IDs follow the existing natural-key contract.
- Preparation freezes folder/session identity before protection begins. Its exact base
  revision is pinned in the engine until protection ends, and completion commits against
  it. Historic `startedAt`, geo, source lines and source skips survive normal snapshots.
  Schedule editing is paused while an account backup is prepared/running. Completion
  releases protection; a cancelled/failed copy stays prepared for retry until explicitly
  put aside (Account → Put aside prepared backup, or remove/replace the template).
- Account/server changes are blocked during backups and pending async operations. Changes
  flush before account switching. Revocation first saves pending edits into the locked,
  encrypted cache, then clears visible account data; a protected backup retains its
  captured state for completion while account pages are hidden. Signed-out, unconfigured
  and locked states never fall back to local schedules or report records.
- **Offline revocation cannot be discovered until the server is reached.** This is also
  stated in the Account panel. Signing out preserves encrypted unsent drafts.
- Existing `onBeforeClose` drains account debounce saves and awaits the durable commit
  chain, without waiting for network upload. A failed durable save keeps close blocked.

The coordinator authorized this renderer phase and a one-time Codex implementation
exception after Claude reached its quota. No server, schema, deployment or dependency
changes were made in this phase.

## Modules (`electron/sync/`)

| file | job |
|---|---|
| `spec.js` | The server's payload rules (`payload_spec`, `validate_payload`, `check_target`), checked before anything is queued. A test checks that the table matches the migration's. |
| `source-pack.js` | "What was read" as `source_line` / `source_skip` targets. Same algorithm as the reviewed reference in `tests/supabase/roundtrip.js`, without loading anything from `tests/`. |
| `model.js` | Converts renderer snapshots to sync targets and back. File paths, saved/scan state and numeric row keys stay in a device overlay. Order keys are fractional, so inserting a row changes only that row. A schedule left out of a snapshot is never treated as deleted. |
| `vault.js` | Files written atomically (with fsync). The cache is AES-256-GCM, bound to the account and server, under a random key wrapped by Electron `safeStorage`. The session file is a `safeStorage` blob. When no OS key store exists (including Linux `basic_text`), it refuses; it never falls back to plaintext. |
| `client.js` | GoTrue and the six RPCs over an **injected** fetch. HTTPS only; HTTP only to loopback. Rejects secret and `service_role` keys, refuses every redirect, never leaves its origin, and maps errors to offline, expired, revoked, forbidden, refused, busy or server. |
| `engine.js` | `SyncEngine`: config, sign-in through `avb_me`, refresh, sign-out, offline-first start, `commit(baseRev, snapshot, busy)`, the durable exact-body queue, pull, conflicts, resolve and review, admin delete and restore, TOTP, backup protection, lock on revoke, and the one-time import. |

## Electron integration

- `sync/host.js` injects Electron `net.fetch`; initialization errors leave local files
  available. With accounts disabled, startup makes no account network requests.
- `sync/ipc.js` and `preload.js` expose typed account actions and status subscriptions,
  with argument bounds and fixed error messages. Tokens stay in the main process.
- `ipc-security.js` guards both account and existing privileged handlers using the exact
  app window, main frame and local page. Popups, webviews and foreign navigation are
  denied. The preload runs with `sandbox: true`.
- `close-coordinator.js` waits for a correlated renderer save acknowledgement and a
  local cache write before closing. It does not wait for uploads. Focused fields are
  blurred before saving; failed saves default to keeping the app open, with an explicit
  quit-without-saving choice. Running-copy confirmation remains in place.
- Schedule debounce saves are serialized and awaitable. Settings and local stores use
  the existing tested atomic writer. A single-instance lock prevents competing app
  processes from sharing the profile.

The user authorized Codex to implement this phase after Claude reached its usage limit;
this does not change the normal workflow in `AGENTS.md`.

## Network transport contract

`Client` takes `fetch` as a parameter; nothing in `electron/sync/` opens a connection by
itself. The host passes **Electron's `net.fetch`**:

- It uses Chromium's network stack, which trusts the **OS certificate store**. A
  private office CA installed in Windows (Trusted Root store) or the macOS keychain is
  then accepted with full verification. Node's built-in fetch trusts only Node's bundled
  CAs, plus `NODE_EXTRA_CA_CERTS`.
- The adapter enforces `redirect: 'error'`, omits cookies and disables caching, keeping
  `Client`'s origin check. The Electron 33 smoke test confirmed a redirect destination
  received neither a request nor a token. Installing and trusting the office CA still
  needs verification on the actual machines.
- **Never** set `NODE_TLS_REJECT_UNAUTHORIZED=0`, never pass a fetch or agent that skips
  verification, and never handle `app.on('certificate-error')` or
  `session.setCertificateVerifyProc` in a way that trusts a failed certificate. A
  certificate problem must show as a connection error.
- The server address is limited to HTTPS (or `http://127.0.0.1` / `localhost` / `[::1]`
  for a test server on the same computer). A plain-HTTP office hostname is refused.

## How the engine keeps edits safe

These are the behaviours the tests check.

- **The base an edit is diffed against is what the screen showed.** A commit is diffed
  against the view revision the renderer displayed.
  - A row or schedule added remotely after that view is never deleted by its absence.
  - Schedules still being read (`busy`) are skipped.
  - A whole schedule is never inferred as deleted.
- **One change in flight per target.** Further edits only update the local draft. The
  next change is based on this device's own applied version, never on a newer remote
  head.
- **When a local entry ends, `chainHead` records what a later edit is based on.**
  - If the entry converged, `chainHead` is the head it converged to.
  - If it was dropped (keep theirs, or discard), `chainHead` is its old base. An edit
    made on a stale screen then becomes a conflict instead of silently overwriting.
- **Exact replay.** A mutation is saved with its exact request body before it is sent.
  After a timeout or a crash, that same body is resent, and the server answers once.
  - If the queue cannot be saved, nothing is sent.
  - If a commit cannot be saved, the in-memory state is rolled back and the error says
    so.
- **Conflicts are held, never rebased.**
  - **Keep current** drops this device's draft.
  - **Accept incoming** sends this device's newer draft next, on the resolved head.
  - **Mine** sends this device's latest draft as the merged value.
  - Resolving someone else's conflict on a target never moves this device's own draft
    base.
  - A conflict that someone else closed is moved to a review list.
- **Whole-schedule delete and restore.**
  - Each one checks `avb_me` online first; a cached admin role is never enough.
  - It needs `aal2`.
  - It uses the `aggregate_rev` of the view the admin reviewed. A late edit makes delete
    a stale conflict, and makes restore answer "review again".
  - Operators are refused both by the engine and by the server.
- **Protected backup row.**
  - The row's identity fields cannot change, and it cannot be deleted, while it is
    protected.
  - A completion committed against the start-time view becomes a conflict if the row was
    edited or deleted remotely. The completed values stay on the device.
- **Revocation.** The cache locks, also after a restart. Unsent work is held, not
  dropped, and nothing uploads. When the server accepts the person again, the cache
  unlocks and the held work uploads.
- **Accounts.** One cache per account and server. Sign-out keeps that account's unsent
  work encrypted, and the next person never sees it. A cache file copied into another
  account's folder will not open.
  - Sign-out closes local access before waiting for the server. Late logout, refresh
    or membership responses cannot clear or lock a newer account.
  - Changing the server invalidates unfinished sign-in requests. A session whose cache
    could not be opened still has to be signed out before changing servers.
- **Learned corrections come back newest first**, ordered by each record's last change
  time.

## Corrections from the final review

Claude implemented the initial review corrections; Codex completed the remaining fixes
and verification with the user's explicit, one-time authorization after Claude reached
its usage limit. This exception does not change the normal workflow in `AGENTS.md`.

- A new encryption key is cached in memory only after its protected key file is saved.
  A failed first save followed by a retry remains readable after restarting.
- Atomic writes handle short byte writes, including multibyte text, and fail without
  replacing the previous file when the disk stops accepting data.
- Server error text and unknown error codes are not echoed. Only recognized codes and
  fixed messages reach the caller, including for short passwords or tokens.
- Revoked accounts cannot retrieve drafts through the review list or failed-item status.
- Session generations reject stale authentication responses across account changes;
  delayed logout and server reconfiguration are covered as well as refresh failures.
- Failed admin-action or conflict-resolution queue saves roll back the local queue and
  in-flight markers. They cannot leave an action to be sent later despite the error.
- A permanently refused in-flight mutation is removed by mutation ID, even when a
  concurrent failed save reconstructed the queue; it is not silently retried.
- The delayed-refresh test now compares all pending targets and the full draft, rather
  than incorrectly expecting an entire schedule to count as one pending target.

## Corrections from Claude's review of the renderer phase

Each fix has a regression test that fails without it.

- **A resent upload no longer overwrites newer pulled data.** When an answer is lost,
  the next sync pulls first, then resends. The server returns its stored answer, which
  can be older than the pull. `_apply` now changes the cached server state only when the
  answer was built on what the cache holds; anything newer arrives with the next pull. A
  resent draft that the server already has ends cleanly, with no leftover draft and no
  spurious conflict. (`sync-engine.test.js`: "a replayed answer older than what was
  pulled…")
- **A session replaced mid-upload keeps the upload queued.** The internal `stale` error
  was treated as a permanent refusal, so a mutation that may already have been applied
  was dropped from the queue and shown as failed. It is now resent byte-for-byte.
  ("a session replaced while an upload is in flight…")
- **Report records and cities are sent only when the screen holds the team's copy.** A
  snapshot taken with no report loaded used to send `report: []`, which the engine
  correctly reads as "delete every report record". With no team city list, the built-in
  list was replaced by an empty one, which broke city lookup and geolocation. Now the
  built-in list is used and is never uploaded, and a list is sent only when it came from
  the team or from an explicit import. (`sync-ui.test.js`: "an unloaded report or the
  built-in city list…")
- **A backup start that fails puts its row back.** Account mode fixes `startedAt` and the
  folder and session number before protection. If the start then failed, or produced no
  template, those values stayed and were uploaded, which changed later rows' numbering.
  Local mode only sets them once a start succeeds. They are now reverted and saved again
  after unprotecting; a start that succeeds keeps them, and so does Clips only, whose
  session is already on the drive. ("a backup start that fails…")

Known and not changed: when the server refuses a whole batch, every row in it goes to the
review list, not just the bad one. The client checks each payload against `spec.js`
before queueing, so this needs an error that only the server can detect.

## Tests run

```
node --test tests/sync-unit.test.js     # 17 checks: no server needed
node --test tests/sync-engine.test.js   # 24 checks: needs PostgreSQL 16 (PG_BIN); skipped otherwise
node --test tests/electron-integration.test.js # 12 IPC, lifecycle and preload checks
npm run test:renderer                   # all of tests/*.test.js, including the suites above
npm run test:electron                   # real Electron; isolated temporary app profile
```

- **Harness.** `tests/sync/harness.js` starts a socket-only cluster under `/private/tmp`
  and deletes it afterwards. It loads `tests/supabase/shim.sql` and the unchanged
  migration, and clones one database per test.
- **Mutation checks.** Four of the fixed bugs were re-introduced one at a time; each was
  caught by a failing test:
  - keep current advancing the base
  - an update based on the newest remote head
  - inferring deletes outside the snapshot's scope
  - a resolution rebasing an unrelated draft

- **Prior core verification:** `npm run test:renderer` passed all 109 tests, including
  the 41 sync checks above, with no skips. The PostgreSQL-backed tests ran locally
  against PG 16.14; authentication and HTTP routing remained test stand-ins.
- Additional regressions reproduced delayed logout, reconfiguration during sign-in,
  failed admin queue persistence and an unintended retry after a concurrent rollback
  before the corresponding fixes. They are now part of the passing suite.

- **Prior Electron-integration baseline:** `npm run test:renderer` passed **121/121**,
  with no skips (41 sync core checks and 12 Electron integration checks included).
  Syntax checks passed for all changed runtime JS and smoke scripts; `git diff --check`
  passed. The SQL regression suite was not rerun because this phase did not change SQL.

- **Electron smoke:** passed on macOS with Electron 33.4.11. Checks local-mode startup,
  sandboxed PDF rendering and local OCR, refusal of another window's IPC, successful
  loopback HTTP transport, redirect refusal, untrusted TLS refusal, blocked navigation
  and popups, and saving focused/debounced edits before window close and macOS Quit.
  Only temporary userData/sessionData and loopback test servers are used. Expected
  denied-IPC and TLS errors appear in the log. This is not a live Supabase test or a
  packaged Windows build test.

The reviewed SQL, its tests and the Windows checker are unchanged.
`tests/test_vingest.py` (`TestNoDatabaseConnection`) was **not run**, because pytest is
not installed in this Python. No Python file changed.

## Known gaps

- Windows startup, shutdown, DPAPI and the office CA remain unverified. The local-mode
  smoke does not exercise real safeStorage sign-in or auth against a running stack.
- The fake GoTrue only imitates the shapes of sign-in, refresh rotation, logout, `/user`
  factors and TOTP challenge/verify. The fake router only imitates PostgREST's error
  mapping (42501 → 403, P0001 → 400). Both must be checked against the real stack.
- The admin's list of deleted schedules shows only schedules this device saw while they
  existed. A fresh device needs `avb_target_history` to name the others.
- Learned-memory order within one upload batch falls back to key order (one server
  timestamp per batch).
- When an order key would pass 64 characters, the whole schedule is renumbered, which
  means many row updates. This should be rare.
- Up to 30 view revisions are kept, in memory only (the protected backup base is pinned). After an app restart the renderer
  must reload its view; a commit against an unknown revision is refused (`stale_view`).
- The whole encrypted cache is rewritten on every change. That is fine for a small team,
  but untested at large sizes.
- Natural-key case folding uses JavaScript's `toLowerCase`/`toUpperCase`. It is not
  checked against the server's collation for non-ASCII names.
- Import reads `schedules.json`, `cities.json`, team settings and renderer-parsed local
  `reportSource` XLSX records only after an explicit preview/confirmation. A missing or
  unreadable report source blocks that import rather than silently omitting it.

## Renderer-phase validation

- `tests/sync-ui.test.js`: 17 VM/harness checks cover local save regression, exact-base
  serialized commits, focused/debounced/dirty/busy view deferral, delayed IPC responses,
  close flush failures, signed-out/locked isolation, revocation with unsaved edits,
  backup protection and captured completion bases, copy UUIDs, busy-scope snapshots,
  admin/MFA UI authorization, escaped conflict alternatives, async-operation isolation,
  explicit import confirmation and parsed XLSX records, source/geo/start preservation.
- Three additional PostgreSQL engine checks cover pinning a protected revision across
  45 views with a remote-edit completion conflict, preparation/completion without a
  spurious self-conflict, and preview/confirmed import of parsed report records.
- `npm run test:renderer` passed **141/141**, with no skips; `npm run test:electron`
  exited 0 on macOS Electron 33.4.11 using its isolated temporary profile. Account UI behavior is exercised by
  the VM/engine harness, not a live authenticated Supabase browser session. The Electron
  smoke exercises real local-mode startup, PDF/OCR, secured IPC, TLS/redirect refusal,
  navigation restrictions, focused/debounced close saves and macOS app.quit.
- Windows, office-CA trust on deployed machines, real GoTrue/PostgREST/MFA integration,
  a second physical device and fresh-device deleted-history listing remain unverified
  or unavailable. No backend history API or schema was invented.
