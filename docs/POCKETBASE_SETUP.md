# Team server: PocketBase over ZeroTier

The team server is one always-on office computer running [PocketBase](https://pocketbase.io)
(a single program with its own database and admin dashboard). Every PC that syncs reaches it
over a private [ZeroTier](https://www.zerotier.com) network, at the server's ZeroTier IP
address. No public address, DNS name or open firewall port is needed, and ZeroTier encrypts
the traffic between the machines.

The sync rules are in `server/` (copy that folder to the server):

| | |
|---|---|
| `server/pb_hooks/avb_core.js` | The sync rules (merge, conflicts, membership, limits). |
| `server/pb_hooks/avb.pb.js` | The `/api/avb/rpc/<name>` routes and the membership audit. |
| `server/pb_migrations/…_avb_sync_v1.js` | Creates the sync tables and the `avb_members` collection. |
| `server/SYNC_CONTRACT.md` | The protocol. |

> **Status: checked on PocketBase v0.40.6 (macOS, one machine).** The migration, hooks and
> the app's real sign-in and sync engine were run against it: sign-up, membership, two
> devices syncing, a conflict, revocation, the audit and the append-only guard all worked.
> Not yet checked: Windows, and two real computers over ZeroTier (step 7). Use **PocketBase
> v0.40.6 or newer**.

## 1. ZeroTier network (once, by the maintainer)

1. Create a free account at <https://my.zerotier.com> and **Create A Network**. Note the
   16-character **Network ID**. Keep **Access Control: Private** (each device must be
   approved).
2. Leave the default IPv4 auto-assign range (for example `10.147.20.*`, `172.2x.*.*` or
   `192.168.19x.*`). The app accepts plain `http://` only to these private addresses.

## 2. The server computer

1. Install ZeroTier (<https://www.zerotier.com/download/>), join the network
   (`zerotier-cli join <Network ID>`, or the tray icon → Join), then tick **Auth** for it in
   ZeroTier Central. Note its **Managed IP**, for example `10.147.20.5`. It stays the
   same while the device stays a member; every PC is configured with it, so do not remove
   and re-add the server in Central.
2. Set the computer **not to sleep**. Sync only works while it is on.
3. Download PocketBase for that OS from <https://github.com/pocketbase/pocketbase/releases>
   and unzip it into a folder, for example `C:\avb-server\` or `~/avb-server/`.
4. Copy this repo's `server/pb_hooks` and `server/pb_migrations` folders next to the
   `pocketbase` program:

   ```
   avb-server/
     pocketbase(.exe)
     pb_hooks/avb_core.js
     pb_hooks/avb.pb.js
     pb_migrations/1762560000_avb_sync_v1.js
   ```

5. Start it, listening on the ZeroTier address only:

   ```
   ./pocketbase serve --http=10.147.20.5:8090
   ```

   On first start it applies the migration and prints a link to create the **superuser**
   (the dashboard admin). Open it, set a strong password, and keep it to the maintainer.
6. Run it at start-up: on Windows a Task Scheduler task "At startup" running the command
   above (start in the `avb-server` folder); on macOS a LaunchAgent; on Linux a systemd
   service. Allow `pocketbase` through the computer's own firewall for the ZeroTier adapter.

Data lives in `avb-server/pb_data/`. **Back it up** (copy the folder while PocketBase is
stopped, or use the dashboard's Settings → Backups).

## 3. Each PC that syncs

1. Install ZeroTier, join the same Network ID, and have the maintainer tick **Auth** for
   it in ZeroTier Central. The PC's ZeroTier status must show **OK / ONLINE**.
2. In AV Backup: **Account** → turn on **Use team account** → **Advanced settings** →
   **Server address** `http://10.147.20.5:8090` (the server's ZeroTier IP) → **Save**.
3. **Create account** (or sign in if the maintainer made one), then tell the maintainer the
   e-mail you used.

## 4. Adding and removing members (maintainer)

Accounts alone get nothing: every call answers *not a team member* until the account is in
`avb_members`. In the dashboard (`http://10.147.20.5:8090/_/`):

1. **Collections → users**: find the person's account by e-mail. If it shows an account
   they did not create (check *created*), do not add it.
2. **Collections → avb_members → New record**: pick that **user**, set **role**
   (`operator`, or `admin` for whole-schedule delete and restore), tick **is_active**, and
   set **display_name** (shown to the team as who changed what).
3. **To remove someone**, untick **is_active**. Their next call fails even with a still-valid
   token. Every change is recorded in the `avb_member_audit` table.

To stop strangers on the ZeroTier network creating accounts, set **users → API Rules →
Create** to superusers only and create accounts in the dashboard instead.

## 5. What a token is

A sign-in gives the PC a PocketBase token (valid 7 days by default) that the app renews
while it is in use. A PC that has not synced for longer than that asks for the password
again; nothing unsent is lost. Signing out forgets the token on that PC; to cut someone off
immediately, untick **is_active** (step 4).

## 6. Moving from Neon

There is no data to move: the Neon server was never used for real team data. Each PC's
local files remain; use **Preview local import…** once after signing in, as before.

## 7. Checks to do once on the real server

1. The server log shows the migration applied, and `avb_members` exists in the dashboard.
2. From a PC on ZeroTier: sign up, add it as a member, sign in, see **Online**.
3. Create a schedule on one PC and see it on a second PC after **Sync now**.
4. Edit the same row on both PCs while one is offline; the second upload shows a conflict.
5. Untick **is_active** for an account; its next **Sync now** locks the account.

## Troubleshooting

- **"The team server could not be reached (ECONNREFUSED)"**: PocketBase is not running,
  or not listening on the ZeroTier IP. **(EHOSTUNREACH / ETIMEDOUT)**: ZeroTier is not
  connected on this PC or on the server, the device is not authorised in Central, or the
  computer's firewall blocks port 8090 on the ZeroTier adapter.
- **ZeroTier stays "REQUESTING_CONFIGURATION" or "OFFLINE"**: the office network blocks
  ZeroTier (UDP 9993 outbound). Ask for it to be allowed; ZeroTier falls back to a slower
  relay when it can.
- **"Use the server's ZeroTier IP address"**: the address is a name or a public IP over
  plain http. Use the `10.x` / `172.x` / `192.168.x` ZeroTier IP, or put PocketBase behind
  https.
