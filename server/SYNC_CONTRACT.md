# AV Backup team sync: server contract, protocol v1

> **Status: implemented and checked on PocketBase v0.40.6 (one macOS machine); not yet over ZeroTier or on Windows.** The server is
> [PocketBase](https://pocketbase.io) on an office computer, reached over ZeroTier. The rules
> are [`pb_hooks/avb_core.js`](pb_hooks/avb_core.js), served by
> [`pb_hooks/avb.pb.js`](pb_hooks/avb.pb.js); [`pb_migrations/`](pb_migrations) creates the
> tables. They are tested in Node on SQLite with a stand-in for PocketBase's auth API. Setup:
> [../docs/POCKETBASE_SETUP.md](../docs/POCKETBASE_SETUP.md).

## Who may do what

The server enforces all of this. A hidden button in the app is not enforcement.

| | Active operator | Active admin | Inactive, removed or not a member | Anonymous |
|---|---|---|---|---|
| Read every schedule, dataset, history and conflict | yes | yes | no | no |
| Create, edit, delete or restore a schedule's **rows** | yes | yes | no | no |
| Edit a schedule's details, shared defaults, starts, cities, report records and learned corrections | yes | yes | no | no |
| Resolve an ordinary conflict | yes | yes | no | no |
| **Delete or restore a whole schedule** (and close a stale deletion attempt) | no | yes | no | no |
| Grant roles, add or remove members | no | no | no | no |

- **Roles are server data.** They live in the `avb_members` collection, which only a
  PocketBase superuser can read or change (all its API rules are empty). The token is used
  only to know which `users` record is calling; every call then looks that id up in the live
  membership, so deactivating someone takes effect on their next call, even if their token
  is still valid. Demotion works the same way.
- **Sign-up is open, membership is not** (unless the maintainer closes the `users` create
  rule). An account alone reads and writes nothing: every call answers `avb:not_member`
  until the maintainer adds it. The maintainer picks the `users` record itself in the
  dashboard, so a member is never named by e-mail alone.
- **An app admin is not the server maintainer.** An admin is an app account with one
  extra right. The maintainer is the PocketBase superuser, can do anything, and is the only
  one who manages members.
- **No MFA.** Whole-schedule delete and restore need the admin role only, as agreed.
  They are still checked online against the live membership, never a cached role.

## Shape

- The sync data is in plain SQLite tables (`avb_targets`, `avb_versions`, `avb_conflicts`,
  `avb_mutations`, `avb_member_audit`), not PocketBase collections, so PocketBase's record
  API never exposes them. The only way in is the six routes below, which require a valid
  `users` auth token.
- **Server-authoritative versions.** Every change to a target writes an immutable
  version with a server-generated `version_id`, actor and time. A target's *head* is
  its current version. A write names the `base_version_id` it was made from. There
  are no vector clocks and no timestamp winners.
- **One writer at a time.** Each call runs in one transaction, and PocketBase serialises
  write transactions on SQLite, so commit order equals `change_seq` order. A reader's
  cursor therefore never skips a change that commits later. A busy database answers
  `55P03`, writes nothing, and can be retried with the same `mutation_id`.
- **Append-only.** Versions, mutation records and the membership audit refuse
  `UPDATE` and `DELETE` (SQLite triggers). History is never garbage-collected.

## Target types

`target_key` is a target's identity and never changes. Payloads use the renderer's
own field names. **Any field not listed is refused** (`avb:unknown_field`). That is
how local paths, scan roots, saved-file paths, attachment bytes, the transient
`read.entries`, themes, column widths, ffprobe settings and runtime state (`busy`,
`error`, `undo`, `key`, the running backup plan, …) stay off the server.

| type | key | belongs to | fields (required in **bold**) |
|---|---|---|---|
| `assignment` | lower-case UUID | itself | **label** (≤200), sourceBasename (file name only, ≤255; `/`, `\` and `C:` refused), createdAt (ISO time), defaults (as `team_defaults`), starts (as `team_starts`) |
| `session` | lower-case UUID, globally unique, never reused | one assignment, fixed at creation | **orderKey** (`[0-9A-Za-z]{1,64}`, sorted as text, ties by key), **include** (bool), **date** (`YYYY-MM-DD`, `''` or null), start, end (≤16), hint (≤8), type (≤32), activity (≤200), place (≤500), city (≤200), topic (≤1000), events (≤64 × ≤200), languages (≤64 × ≤100), author (≤64), format (≤16), duration, clips, cameras, folder, session, camPlan (number, string ≤32 or null), backedUp (ISO time or null), title, subtitle, placeText (≤1000), source (≤4000), sharedFolder (bool), flags (≤32 string → string ≤500), geo (the picked city record's `name`, ≤300, or null), startedAt (ISO time or null) |
| `source_line` | `<assignment>:<line>:<part>` | that assignment | **line** (0–99999), **part** (0–9999), **cells** (0–256 strings), **continuesCell** (bool) |
| `source_skip` | `<assignment>:<index>` | that assignment | **index** (0–99999), **days** (1–366 `YYYY-MM-DD`), **reason** (≤32), **rowText** (≤32768) |
| `city` | `lower(trim(name))` | team | **name**, **city**, state, country |
| `report_record` | `upper(trim(id))` | team | **id**, folder, format, session, author, type, date, duration, activity, place, topic, clips, cameras, events, languages, city, state, country |
| `team_defaults` | `team` | team | author, format, camsFormal, camsInformal |
| `team_starts` | `team` | team | formal, informal |
| `learned_title` | `lower(trim(key))` | team | **key**, topic, type, activity, events, languages |
| `learned_place` | `lower(trim(key))` | team | **key**, place, city, languages |

**What was read** (`assignment.rows` and `read.skipped`). These travel as the
assignment's own child targets, so they get the same version, conflict and
parent-deletion protection as session rows:

- **`source_line`** holds the raw table rows, every cell exactly as read. Each line is
  one or more parts in `part` order. When a line won't fit one payload, the client
  splits it: by whole cells first, and inside a cell by code point when one cell is
  bigger than a payload. A part whose `continuesCell` is true starts with the rest of
  the previous part's last cell. Rebuilding concatenates that first cell and appends
  the others. Nothing is cut or dropped.
- **`source_skip`** holds the read's skipped breaks, one per entry, in `index` order.
- **Re-reading** a poster sends updates for lines that changed and deletes for lines
  and parts that are gone. Each change is based on the version the screen showed, as
  for sessions.

The splitter and rebuilder are `packLine` and `unpackLines` in
`electron/sync/source-pack.js`. They keep each part's JSON under 24,000 bytes, which
leaves room under the limit, which is measured with `", "` and `": "` separators.

`geo` is the city **record** (the `city` target's `name`) that the operator picked
when several cities share a name. `startedAt` records that a backup from the row
started and never finished. Neither is live process state: the running plan stays
on the device.

A payload is at most 32 KiB, a request at most 2 MiB and 500 operations. The client
must shorten or fix a value that breaks a limit **before** queueing it, because the
whole batch is refused. The app's numeric `row.key` stays local. `orderKey` carries
row order, and the session UUID replaces the key on the wire. A session's
`backedUp` is a historical note for the report only: the server never starts,
schedules or checks a backup. Natural-key types make two devices that import the
same sheet produce the same keys: equal values coalesce, and different ones
conflict.

`team_defaults` and `team_starts` cannot be deleted. An assignment cannot be deleted
or restored with the generic operations.

## Calling

Every call is a POST to `<server>/api/avb/rpc/<name>` with body `{ "p_request": … }` and
`Authorization: <token>`, the user's PocketBase auth token. Errors come back as
`{ code, message, details }`: `message` is a stable `avb:<code>`, and `code` is `42501`
(HTTP 403) for identity and permission errors, `P0001` (HTTP 400) for everything else, and
`55P03` (HTTP 503) when the database is busy. A missing or expired token answers 401.
**On any error, nothing in the request was applied.**

### `avb_me()` and `avb_team_members()`

```json
{"protocol_version":1,"user_id":"…","role":"operator","display_name":"Op One"}
[{"user_id":"…","display_name":"Op One","role":"operator","is_active":true}]
```

The team list has display names for showing who changed what. It has no email
addresses.

### `avb_sync_apply(p_request)`

```json
{
  "protocol_version": 1,
  "mutation_id": "6f9f0c55-8a1e-4c1e-9a52-2b7f6f0c1a10",
  "operations": [
    {"op":"create","type":"assignment","key":"0b6e…","payload":{"label":"Nov 2026 shibir","sourceBasename":"poster.pdf"}},
    {"op":"create","type":"session","key":"5d1c…","assignment_key":"0b6e…",
     "payload":{"orderKey":"a0","include":true,"date":"2026-11-08","topic":"Morning"}},
    {"op":"update","type":"session","key":"77aa…","base_version_id":"c3d4…","payload":{"orderKey":"a1","include":false,"date":"2026-11-08"}},
    {"op":"delete","type":"session","key":"88bb…","base_version_id":"e5f6…"},
    {"op":"restore","type":"session","key":"99cc…","base_version_id":"<its tombstone version>"},
    {"op":"resolve_conflict","conflict_id":"…","expected_head_version_id":"…","resolution":"keep_current"},
    {"op":"delete_assignment","assignment_key":"…","expected_aggregate_rev":42},
    {"op":"restore_assignment","assignment_key":"…","expected_aggregate_rev":43}
  ]
}
```

- `update` and `create` send the **whole** payload of that one target. Reading a whole
  schedule snapshot is a client concern: diff it against the base the screen showed,
  never against the newest state, and send only targets that changed.
- **Each target may be touched by only one operation per batch.** A
  `resolve_conflict` counts as touching its conflict's target, and
  `delete_assignment` or `restore_assignment` as touching the assignment. So a
  resolution plus an edit of the same row, two resolutions on one row, or a details
  edit plus `delete_assignment` are refused with `avb:duplicate_target_in_batch`.
  Send them in sequence, each based on the head the previous one returned. A batch
  is all-or-nothing.
- **Idempotency.** The same `mutation_id` with the same request from the same user
  returns the stored response byte-for-byte. A reused id with different content, or
  from another user, is refused (`avb:mutation_id_reused`). A refused batch stores
  nothing, so its id can be retried. Actor and time are set by the server. A request
  that carries `actor_id` or any unlisted field is refused.

Response (results are in request order):

```json
{"protocol_version":1,"mutation_id":"6f9f…","results":[
  {"index":0,"op":"create","status":"applied","version_id":"…","target_type":"assignment","target_key":"0b6e…",
   "head_version_id":"…","deleted":false,"aggregate_rev":2},
  {"index":2,"op":"update","status":"conflict","conflict_id":"…","conflict_kind":"stale_edit",
   "target_type":"session","target_key":"77aa…","head_version_id":"<unchanged head>","deleted":false,"aggregate_rev":3},
  {"index":3,"op":"delete","status":"noop","target_type":"session","target_key":"88bb…","head_version_id":"…","deleted":true,"aggregate_rev":3}
]}
```

`status` is one of:

- `applied`: a new head.
- `noop`: the value is already the head, so nothing was written.
- `conflict`: kept, not applied.
- `resolved`: a conflict was closed.

### The merge rules

| Incoming | Server state | Result |
|---|---|---|
| base = head | value differs | `applied` |
| any base | value equals the head | `noop` (a stale write of the current value is not a conflict) |
| base ≠ head, an edit | head live | `conflict` `stale_edit`: the head stays, and the incoming value is stored |
| base ≠ head, a delete | head live | `conflict` `delete_vs_edit`: the row is **not** deleted |
| an edit of an older version | head is a tombstone | `conflict` `edit_vs_delete`: stays deleted, and the edit is stored |
| an edit whose base is the current tombstone | | refused, `avb:restore_required` (use `restore`) |
| `create` of an existing key | different value | `conflict` `create_collision` |
| anything inside a deleted assignment, including a new row | | `conflict` `parent_deleted`: the assignment is not resurrected and the child head does not move |
| same incoming value as an open conflict on that target | | that conflict's id (coalesced) |

Different targets never conflict with each other. Two people editing different rows
both win. Conflicts stay open until someone resolves one, and ordinary edits do not
close them.

**Resolving.** `resolve_conflict` takes:

- `resolution`: `keep_current`, `accept_incoming`, or `merged` with a full
  `payload`, which is validated like any write.
- `expected_head_version_id`: the head the person saw. Omit it only when the target
  has no head yet. A mismatch is refused with `avb:stale_resolution`, so a decision is
  never applied to a value the resolver did not see.

Accepting a deletion leaves a tombstone, and accepting an edit of a deleted row brings
the row back. Accepting anything inside a deleted assignment is refused until an admin
restores the assignment.

### Whole-assignment deletion

Each assignment has an `aggregate_rev`. It rises with every applied change, conflict
or resolution on the assignment or any of its rows. `delete_assignment` names the
revision the admin reviewed:

- **It matches:** the assignment gets a tombstone. Rows are **not** cascaded: they
  keep their heads, hidden behind the deleted parent, so `restore_assignment` brings
  back exactly what was there.
- **It is stale** (someone edited or added a row the admin had not seen): nothing is
  deleted. The attempt is stored as an `assignment_delete_stale` conflict. Only an
  admin can close it, and only with `keep_current`. To delete, send
  `delete_assignment` again with the new revision.
- **Afterwards:** a device that has not seen the deletion has its edits and new rows
  kept as `parent_deleted` conflicts. Restoring the assignment does not apply them on
  its own; someone accepts each one.

An operator can still delete every row. That leaves an empty assignment, which is
allowed under the agreed policy.

### Reading: `avb_sync_pull`, `avb_conflicts`, `avb_target_history`, `avb_recent_history`

```json
// request
{"protocol_version":1,"after":0,"limit":200}
// response
{"protocol_version":1,"has_more":true,"next_cursor":1834,"items":[
  {"target_type":"session","target_key":"5d1c…","assignment_key":"0b6e…","change_seq":1801,
   "head_version_id":"…","deleted":false,"aggregate_rev":null,"payload":{…},
   "updated_by":"…","updated_at":"2026-11-08T09:12:03Z","open_conflicts":0},
  {"target_type":"session","target_key":"88bb…","assignment_key":"0b6e…","change_seq":1802,
   "head_version_id":"…","deleted":true,"payload":null,"open_conflicts":0,…}
]}
```

- **Pull** returns each changed target once, in its current state, ordered by
  `change_seq`. That includes tombstones (`deleted: true`) and targets that exist only
  as a conflict (`head_version_id: null`). Store `next_cursor` only after the page is
  saved locally, and repeat while `has_more` is true. `after: 0` returns everything.
  `limit` is 1 to 500 (default 200). Show a row only if its assignment item is not
  deleted.
- **`avb_conflicts`** takes `{protocol_version, status: open|resolved|all,
  assignment_key?, after, limit ≤100}`. It returns each conflict's `base`,
  `detected_head`, `incoming` and `current_head` versions with their values, actors
  and times, plus `assignment_rev`. It is paged by `conflict_seq`. When a target's
  `open_conflicts` changes in a pull, re-read its conflicts.
- **`avb_target_history`** takes `{protocol_version, type, key, before?, limit ≤100}`.
  It lists versions newest first, including stored incoming values
  (`accepted: false`). Pass `next_before` back as `before` for the next page.
- **`avb_recent_history`** takes `{protocol_version, before?, limit ≤100}`. It lists accepted
  assignment, session and report_record versions across the team, newest first, each with
  `actor_name`, `payload` and the `previous` (parent) payload. Paged like `avb_target_history`.

All four read the live membership on every call.

## Maintainers: bootstrap and members

No key or password goes in this repo or the app. The full steps are in
[../docs/POCKETBASE_SETUP.md](../docs/POCKETBASE_SETUP.md). In short:

1. **Copy `pb_hooks` and `pb_migrations` next to the `pocketbase` program** and start it on
   the server's ZeroTier IP. The migration runs once and changes nothing that already exists.
2. **Each person gets an account** (they choose Create account in the app, or the
   maintainer creates it in the dashboard), and tells the maintainer the e-mail they used.
3. **The maintainer adds a record to `avb_members`** in the dashboard: that user, a role
   (`operator` or `admin`), `is_active` ticked, and a display name. Unticking `is_active`
   revokes access on the next call. Every insert, change or removal is written to
   `avb_member_audit`.

## Limits that remain

- **Revocation stops future calls only.** Data already pulled or exported to a
  device stays there. The app keeps its cache per account, and when a session is revoked
  it locks that cache and sets pending uploads aside for review. The server refuses those
  uploads (`avb:not_member`).
- **Offline edits wait.** They reach the team only on the next upload. Until then, a
  stale device keeps old values, and its edits may arrive later as conflicts.
- **The server must be on.** Sync waits while the office computer is off, asleep or off
  ZeroTier; the app keeps working from its encrypted cache.
- **Tokens last 7 days** (PocketBase's default) and are renewed while the app is in use.
  A token cannot be revoked by signing out; membership is checked on every call instead.
- **No member-management route exists, on purpose.** Membership changes need the
  superuser.

## Still to verify on a real PocketBase

Checked on v0.40.6: the migration and hooks load, and the `users` auth paths and error
bodies match the client. Still open: two computers syncing over ZeroTier, Windows included.

## Tests

```bash
node --test tests/sync-server.test.js tests/sync-engine.test.js tests/sync-unit.test.js
```

`tests/sync/harness.js` runs the real rules on an in-memory SQLite database (`node:sqlite`)
behind a stand-in for PocketBase's auth API and routes.
