# Self-hosted Supabase on the office Windows PC

> **Status: preparation only.** No server has been deployed by this document. AV
> Backup has no login, accounts or sync yet, and installing Supabase does not add
> them. Nothing here has been run on the office PC: every command is a manual step
> to run and check there.

Sources were checked on 7 Nov 2026 and are linked where used. Repeat the check
before deploying, because the upstream stack changes about monthly.

## 1. What this is, and is not

| | |
|---|---|
| **Is** | The open-source Supabase Docker stack, run by this team on its own office PC. |
| **Is not** | Supabase Cloud. [Self-hosting has no managed backups or point-in-time recovery, and support is community-based](https://supabase.com/docs/guides/self-hosting). Security, patching, monitoring, uptime, backups and recovery are ours. |
| **Is not** | `supabase start`. The CLI's local development stack is [not hardened and must not be exposed to external traffic](https://supabase.com/docs/guides/self-hosting). |

**Where data lives, in the planned design:**

| Data | Location |
|---|---|
| Footage and manifests | SSDs only, as today. Never sent to the server. |
| Imported schedule and event metadata | Database on the office server, plus an offline cache in the app. **The cache and sync do not exist yet.** |
| Supabase file Storage | Not required by this app. The service still runs in the stock stack, but the app does not need it. |

## 2. Known facts and open decisions

**Confirmed by the user**

- The host is an existing always-on office PC with 32 GB RAM and **Windows 11**, used
  from the office and from remote locations.
- It has a **4 TB HDD**. Free space is **unknown**, so do not assume 4 TB is free.
- **Schedule policy:** every active team operator can read and edit every schedule, and
  add or delete individual rows. Only an app admin can delete a whole schedule. All
  app users share one team's metadata. There is no public sign-up: the server
  maintainer creates logins and memberships. No service or admin database key is ever
  on an operator's machine. Server maintainers (Studio, `.env`) are not app admins.

**Not yet known; each one can block deployment**

| Open item | Why it matters | Resolved by |
|---|---|---|
| Windows edition and servicing status | Docker's guidance on Home is inconsistent, and support depends on Microsoft servicing (section 3) | Section 5 report, then a manual check |
| Free disk space, and which drive holds what | Sets capacity and performance | Section 5 report, section 4 |
| Docker Desktop licence | Free use has limits (section 3) | Organisation owner |
| Recovery after restart with nobody signed in | Decides whether Docker Desktop is good enough (section 7) | Test, then decision |
| VPN product, DNS name and TLS certificate method | Section 9 | Team |
| Backup frequency, off-host destination, named owner | Section 8 | Team |

## 3. Requirements

| Item | Requirement | Source |
|---|---|---|
| Windows 11 | Minimum build 22631 (23H2), **and** a release Microsoft still services for this edition | [Docker](https://docs.docker.com/desktop/setup/install/windows-install/) |
| Windows Server | Not supported by Docker Desktop | same |
| WSL | 2.1.5 or later, ideally the latest | [Docker](https://docs.docker.com/desktop/features/wsl/best-practices/) |
| Firmware | Hardware virtualization on, SLAT-capable 64-bit CPU | Docker |
| Service | `LanmanServer` set to Automatic | Docker |
| RAM | Docker lists 8 GB; Supabase 4 GB minimum, 8 GB+ recommended | [Supabase](https://supabase.com/docs/guides/self-hosting/docker) |
| CPU | 2 cores minimum, 4+ recommended | Supabase |
| Disk | **40 GB SSD minimum, 80 GB+ SSD recommended** | Supabase |

**Windows edition.** Docker's page is not consistent about Home: its WSL 2 requirements
list Enterprise, Pro and Education, while a note on the same page says Home and Education
"only allow you to run Linux containers", which is what this stack uses. So Home is not
ruled out, and it is not confirmed either. The report gives Home a `WARN`. If this PC runs
Home, check Docker's current page, then confirm the build, WSL 2 and Linux containers all
work in Stage 1. Do not buy an edition upgrade on this basis alone.

**Windows servicing.** Meeting the minimum build is not enough on its own. Docker supports
only Windows versions within [Microsoft's servicing timeline](https://learn.microsoft.com/en-us/lifecycle/products/windows-11-home-and-pro)
([Enterprise and Education dates](https://learn.microsoft.com/en-us/lifecycle/products/windows-11-enterprise-and-education)
differ), and those dates pass over time. The report shows your version but marks this
`UNVERIFIED`. Look it up by hand, and repeat at each patch window.

**Licensing.** Docker Desktop is [free for small businesses with fewer than 250
employees **and** under $10M annual revenue](https://docs.docker.com/subscription-billing/desktop-license/),
as well as personal, education and non-commercial open-source use. Larger organisations
and government entities need a paid plan. Someone must confirm this for your
organisation before installing. Do not assume it is free.

**Official-doc gap.** Supabase's Docker guide lists Docker Desktop on Windows as a
prerequisite but has no Windows or WSL section, and its quick-start script is Linux only.
So this runbook uses its *manual* steps from inside a WSL Linux distribution. That
combination is reasonable but not something Supabase documents end to end, so the tests
in sections 6 to 8 are what establish that it works here.

## 4. The HDD must be evaluated before event production

Supabase's stated requirement is SSD. **A 4 TB HDD does not meet it**, and capacity does
not make up for that: a database depends on small synchronous writes, which is where
HDDs are slowest. A single disk also has no redundancy.

The HDD may still do for this small metadata workload, but that has to be measured:

1. **Find out what is where.** Docker Desktop and WSL store their virtual disks on the
   system drive by default. Check whether Windows itself is on this HDD and whether any
   SSD exists; the section 5 report lists each drive's media type, free space and health.
2. **Check disk health** with the vendor's tool and the report's `health` value. Do not
   put the only copy of production metadata on a disk already reporting problems.
3. **Run a realistic test on the actual disk** once the stack is up in testing: several
   operators signing in, importing the largest real schedule, and editing at the same
   time, while the disk is also doing whatever else this PC does. Agree the acceptable
   wait with operators *before* testing and record the results.
4. **Disable disk spin-down on mains power** if the report flags it.

Pass all four, or use an SSD. Whatever the outcome, it does not replace off-host backups
(section 8).

## 5. Stage 0: preparation (changes nothing on the server)

Copy `scripts/windows/Check-SupabaseServer.ps1` to the PC, open PowerShell (admin is not
required) and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Check-SupabaseServer.ps1
```

`Bypass` applies to this one process and changes no saved policy. The script:

- only reads system state, and runs only `wsl.exe`, `powercfg.exe` and `docker.exe`
  with fixed read-only arguments. `docker.exe` is whichever one is first on PATH, as it
  would be if you typed `docker`.
- takes no paths or commands as input, and reads no secrets.
- works when WSL or Docker are missing, reporting them rather than crashing.

| Status | Meaning |
|---|---|
| `PASS` | Meets the listed requirement. |
| `WARN` | Needs a person's judgement (for example, any HDD). |
| `FAIL` | Listed requirement not met, or a needed tool is missing. Exit code 1. |
| `UNVERIFIED` | Could not be determined here. **Not a pass.** |

A clean report means only that the prerequisites look right. It does not test Supabase,
restart recovery, or what other machines can reach.

**Manual actions, only after reading the report.** Administrators decide and perform
these; no script here does them:

1. Enable virtualization in BIOS/UEFI if reported off.
2. From an administrator terminal, install WSL and a Linux distribution:
   `wsl --install -d Ubuntu`. [Microsoft's install guide](https://learn.microsoft.com/en-us/windows/wsl/install) covers this.
3. Confirm the Docker licence (section 3), then download Docker Desktop from
   [Docker's install page](https://docs.docker.com/desktop/setup/install/windows-install/)
   and read its terms. Select the WSL 2 backend and turn on WSL integration for the
   distribution in Settings. Docker Desktop will not run until the terms are accepted.
4. Review sleep, hibernate and restart settings (section 7).
5. Run the report again.

## 6. Stage 1: test deployment (local to the PC)

> Run this only when the Stage 0 blockers are cleared. Do not start it during an event.
> It stays reachable from the PC only: no router, VPN or public change is made here.

**Version pin:** [`self-hosted/v0.8.4`](https://github.com/supabase/supabase/tree/self-hosted/v0.8.4),
commit `189adda99d1b56da55fc5a6ee3f849354aaea92a`, which pins Postgres
`supabase/postgres:17.6.1.136`. Use a tag, never `master`, and do not mix image tags
across snapshots. The Compose stack stays upstream's; this repo keeps no copy.

Inside the WSL distribution, in its Linux home folder and **not** under `/mnt/c`
([Docker's guidance](https://docs.docker.com/desktop/features/wsl/best-practices/)
for bind mounts; a Linux checkout also avoids the CRLF failure Supabase warns about):

```bash
# update.sh needs git and jq; key scripts need openssl; backups (section 8) need gnupg, tar and sha256sum
sudo apt update && sudo apt install -y git jq openssl gnupg tar coreutils

cd ~
git clone --depth 1 --branch self-hosted/v0.8.4 https://github.com/supabase/supabase
mkdir supabase-project
cp -rf supabase/docker/. supabase-project
cd supabase-project && cp .env.example .env
chmod 600 .env
printf 'ref=self-hosted/v0.8.4\n' > .supabase-version
docker compose pull
```

**Secrets.** Never start on the `.env.example` defaults. These write generated secrets to
`.env`. Both scripts also print every value, so normal output is discarded here while
errors still show. Without `--update-env` they would prompt, or only print and leave
`.env` unchanged.

Run these one at a time. **If a step prints an error, a non-zero exit, or `STOP`, do not
run `sh run.sh start`.** Find the cause first.

```bash
sh utils/generate-keys.sh --update-env > /dev/null
echo "generate-keys exit: $?"          # must be 0

sh utils/add-new-auth-keys.sh --update-env > /dev/null
echo "add-new-auth-keys exit: $?"      # must be 0

# Protect .env and any .env.old backup the scripts left. Both may hold secrets.
for f in .env .env.old; do
  [ ! -e "$f" ] || chmod 600 "$f" || echo "STOP: could not protect $f"
done

# Confirm values were set and differ from the examples. Prints key names, never values.
for k in POSTGRES_PASSWORD DASHBOARD_PASSWORD JWT_SECRET SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY; do
  now=$(grep "^$k=" .env); example=$(grep "^$k=" .env.example)
  if [ -n "${now#*=}" ] && [ "$now" != "$example" ]; then echo "ok: $k"; else echo "STOP: $k"; fi
done
```

Then review `.env` in a private editor:

- Set `POOLER_TENANT_ID` to your own value.
- Set **`DISABLE_SIGNUP=true`**. The default (`false`) would let anybody who reaches the
  server create an account, with phone sign-up also on and auto-confirmed.
- Store `.env` in the team's password manager. Never put it in this repo.
- `sh run.sh secrets`, `sh run.sh printenv` and `sh run.sh compose-config` can all reveal
  secrets. Keep their output out of logs and tickets.

**Keep everything local.** By default, the stack publishes port 8000 (which serves Studio
as well as the APIs), 5432 and 6543 on *all* interfaces. Create
`docker-compose.office.yml` beside `docker-compose.yml`:

```yaml
# Local-only ports for testing. Remote access is added separately (section 9).
services:
  api-gw:
    ports: !override
      - "127.0.0.1:${API_GW_HTTP_PORT:-8000}:8000/tcp"
  supavisor:
    ports: !override
      - "127.0.0.1:${POSTGRES_PORT}:5432"
      - "127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION}:6543"
```

```bash
sh run.sh config add office    # records it in COMPOSE_FILE in .env
sh run.sh start
docker compose ps              # every service should reach "healthy" within about a minute
curl -I http://localhost:8000/auth/v1/
```

**Check it worked:**

- [ ] `docker compose ps` shows all services healthy.
- [ ] Studio opens at `http://localhost:8000` on the PC, with the dashboard password.
- [ ] Run the section 5 report: 8000, 5432 and 6543 now show as `Local only`.
- [ ] From **another** machine, `<PC-IP>:8000`, `:5432` and `:6543` do not connect.

This shows the server runs on this PC. It does not mean operators can use it, because no
AV Backup accounts, tables or sync exist yet.

**Do not run** `sh reset.sh` on a deployment you care about: it deletes the database and
Storage data.

## 7. Stage 2: testing versus unattended use

A stack working while someone sits at the PC proves little about unattended use.

**The main risk.** Docker Desktop's documented autostart is
["Start Docker Desktop when you sign in"](https://docs.docker.com/desktop/settings-and-maintenance/settings/),
which is off by default. Docker documents no way to start it, and therefore the
containers, **before anyone signs in**. The `--always-run-service` installer flag only
concerns `com.docker.service`, and Docker does not present it as a way to do this. After
a Windows Update restart or a power cut, expect the server to stay down until someone
signs in, unless the test below shows otherwise.

Turn on the sign-in autostart setting. Then run each test outside event time and record
the result. Check the server **from another machine**, where possible.

**Never deliberately cut power to the real server.** An abrupt cut can damage the HDD or
its data, even with a backup in hand. If you want to see power-loss recovery, try it only
on a separate test environment holding no production data.

| Test | Record |
|---|---|
| Restart, then **do not sign in** for 15 minutes | Does the server answer? Expected: no. |
| Sign in after that restart | Minutes until all services are healthy, without manual commands. |
| Windows Update restart, in a maintenance window | Same two results. |
| Full orderly shutdown, then power on | Do services return without manual commands? Is data intact? |
| UPS, if fitted | Use its own self-test or simulation mode. Does it signal Windows to shut down cleanly? |
| Leave idle overnight | Still answering? Any sleep or disk stall? |

After each test:

```bash
cd ~/supabase-project
docker compose ps
curl -I http://localhost:8000/auth/v1/
docker compose logs --since 30m db | tail -n 50    # look for recovery or disk errors
```

Eleven of the stock services use `restart: unless-stopped`. `sh run.sh stop` removes the
containers, so after that only `sh run.sh start` brings them back.

**Choose one, based on the results:**

| Option | Trade-off |
|---|---|
| **A. Someone signs in after every restart** | Simple. Server is down until then, so it needs a named person and a backup person. |
| **B. Automatic Windows sign-in** | Recovers unattended, but stores a credential on the PC and leaves a signed-in session on a shared machine. Security owner must agree. |
| **C. Linux and Docker Engine** (a dedicated Linux machine, or a Linux VM that starts at boot) | Supabase's primary documented setup and needs no sign-in. Needs fresh planning and testing. |

**Plan for interruptions, all set by hand:**

- **Windows Update:** set active hours around event times and pick a monthly patch window.
  Windows may still restart outside active hours, so operators need the offline cache
  (future work) and someone must know how to recover the server.
- **Sleep and hibernate:** set to never on mains power; the report shows the current state.
- **Power loss:** consider a UPS and the BIOS option to power on after power returns.
  Postgres is designed to recover from crashes, but a failing HDD or lost write can still
  corrupt data, which is what backups are for. After a real outage, run the checks above
  and restore from backup if the data is damaged.
- **Monitoring:** agree who notices when the server is down and how, before relying on it.

## 8. Backup and recovery

Backups are entirely our job when self-hosting, and **a backup does not count until a
restore has been tested** from it.

### Not all copies are backups

| Copy | Consistent? | Use |
|---|---|---|
| Cold copy with Postgres stopped | Yes. [PostgreSQL requires the server to be shut down](https://www.postgresql.org/docs/17/backup-file.html) for a file-level copy. | **Primary backup.** |
| `pg_dump` while running | Yes for that database. [Consistent during concurrent use](https://www.postgresql.org/docs/17/app-pgdump.html). Excludes role definitions, config and secrets. | Secondary, with no downtime. |
| Copying `volumes/db/data` while running | **No.** "Half-way measures" do not work, per PostgreSQL. | Never. |
| Copying a Docker volume, the WSL disk or a PC image while running | **Not proven.** Only a true point-in-time snapshot of everything would be crash-consistent, and these copies don't promise that. | Not a database backup. |
| Docker volumes on the same disk | Same failure as the server. | Not a backup. |

### What must be saved

| Item | Where | Why |
|---|---|---|
| Database, including `auth` users and database roles | `volumes/db/data` | The actual data and logins. |
| `.env` (and any `.env.old`) | deployment folder | Without the JWT secret and keys, a restored server cannot honour app keys and tokens. |
| Pinned config: `docker-compose*.yml`, `.supabase-version`, `volumes/` | deployment folder | Rebuilds the same stack. |
| `pgsodium` root key | **Named Docker volume** `db-config`, outside the folder | [Backups never include this key](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore); without it, encrypted values such as Vault secrets stay unreadable. Easy to miss. |
| Backup passphrase | Password manager, **not** with the backups | Without it, backups are unusable. |

**Extras, only if enabled:** file Storage in `volumes/storage`, Edge Functions in
`volumes/functions` and the analytics data all sit in the deployment folder, so the cold
copy takes them. External S3 is not covered. The `pg_dump` route does not copy Storage
files at all.

### A. Cold backup (primary)

This stops the server for a few minutes, so do not run it during an event. This repo
ships **no backup script** on purpose: it could not be tested against a real deployment,
and a script that seems to work is worse than clear steps. Automate only after the drill
passes.

Run these one at a time in the WSL distribution. Each `echo` must print only zeros.
**If not, stop:** the backup is invalid, and step 5 still has to run.

```bash
# 0. Before stopping anything, confirm the tools exist. Must print nothing.
#    If a tool is missing: sudo apt update && sudo apt install -y gnupg tar coreutils
for t in gpg tar sha256sum docker; do command -v "$t" > /dev/null || echo "MISSING: $t"; done

# 1. Stop. This is compose down, which keeps volumes. Never add -v, and never use reset.sh.
cd ~/supabase-project
sudo -v
export GPG_TTY=$(tty)
sh run.sh stop
docker compose ps -q        # must print nothing

# 2. New, timestamped folder. mkdir fails rather than reusing an old one.
BK=~/supabase-backups/$(date +%Y%m%d-%H%M%S)
mkdir -p ~/supabase-backups && mkdir -m 700 "$BK"

# 3. Deployment folder (database, .env, config). Encrypted as it streams; no plain copy is written.
sudo tar --numeric-owner -cpf - -C "$HOME" supabase-project \
  | gpg --symmetric --cipher-algo AES256 --output "$BK/deployment.tar.gpg"
echo "${PIPESTATUS[@]}"

# 4. Key volume, without naming the container or volume. Postgres is not started.
docker compose run --rm --no-deps -T --entrypoint tar db -C /etc/postgresql-custom -cpf - . \
  | gpg --symmetric --cipher-algo AES256 --output "$BK/db-config.tar.gpg"
echo "${PIPESTATUS[@]}"

# 5. Restart, and check it, even if an earlier step failed.
sh run.sh start
docker compose ps

# 6. Prove the backup files decrypt and read. This does not prove they restore.
gpg --decrypt "$BK/deployment.tar.gpg" | tar -tf - > /dev/null; echo "${PIPESTATUS[@]}"
gpg --decrypt "$BK/db-config.tar.gpg"  | tar -tf - > /dev/null; echo "${PIPESTATUS[@]}"
(cd "$BK" && sha256sum *.gpg > SHA256SUMS)
```

### B. Online dump (secondary)

No downtime. Create a new `$BK` folder and set `GPG_TTY` as above; the `echo` rule is the
same.

```bash
cd ~/supabase-project
docker compose exec -T db pg_dump -U supabase_admin -d postgres -Fc \
  | gpg --symmetric --cipher-algo AES256 --output "$BK/postgres.dump.gpg"
echo "${PIPESTATUS[@]}"

# Roles, including password hashes: treat as secret.
docker compose exec -T db pg_dumpall -U supabase_admin --roles-only \
  | gpg --symmetric --cipher-algo AES256 --output "$BK/roles.sql.gpg"
echo "${PIPESTATUS[@]}"
```

These are for recovering specific data, such as one table's rows. Supabase
[warns](https://supabase.com/docs/guides/self-hosting/restore-from-platform) that a raw
`pg_dump` includes its internal schemas and causes permission errors on restore, so do
not count this as a whole-server recovery until a drill has proved that. Also note that
`supabase db dump` [excludes `auth` and `storage` from its schema dump and has no data or
custom roles by default](https://supabase.com/docs/reference/cli/supabase-db-dump), so
its default output alone does not save accounts.

### Off-host copies

1. Copy the whole timestamped folder off this PC, at least to a place that would survive
   theft, fire or disk failure in the office. The destination is the team's choice.
2. At the destination, run `sha256sum -c SHA256SUMS`.
3. Keep the passphrase separate. Only already-encrypted files should leave the PC.
4. Nothing here deletes old backups. Remove one only by hand, after a newer backup has
   passed a restore drill.

The team decides how much data loss is acceptable. That decides how often to back up,
including before and after any event that imports metadata.

### Restore drill (required)

> **Do not run any restore command on the office PC.** Another WSL distribution on the
> same Docker Desktop is **not** separate: integrated distributions share one Docker
> engine, so they share Supabase's fixed container names and the same Compose project's
> volumes. The restore's `db-config` step could overwrite the production encryption key
> volume, and starting the stack would collide with the live one.

Use a **separate physical machine**, or a VM with **its own Docker engine** that you have
confirmed is not the production one. Keep it unreachable from operators, so it cannot be
mistaken for the real server. Before the backup, record a few facts to compare against,
such as row counts for your main tables.

On the drill machine, run this first. **Each of the last three commands must list no
Supabase project, container or volume. Otherwise stop:** you may be on the production
engine.

```bash
hostname                 # must be the drill machine
docker context show      # note it; must not point at the office PC
for t in gpg tar sha256sum docker; do command -v "$t" > /dev/null || echo "MISSING: $t"; done
docker compose ls --all
docker ps -a --filter name=supabase
docker volume ls --filter label=com.docker.compose.project=supabase
```

Then restore:

```bash
export BK=/path/to/copied/backup/folder
export GPG_TTY=$(tty)
sudo -v
(cd "$BK" && sha256sum -c SHA256SUMS)    # every line must say OK; otherwise stop

# Extracts only if there is no existing deployment. Must print only zeros; otherwise stop.
[ ! -e ~/supabase-project ] && gpg --decrypt "$BK/deployment.tar.gpg" | sudo tar --numeric-owner -xpf - -C "$HOME"
echo "${PIPESTATUS[@]}"

cd ~/supabase-project
docker compose pull      # images pinned by the restored compose file
gpg --decrypt "$BK/db-config.tar.gpg" \
  | docker compose run --rm --no-deps -T --entrypoint tar db -C /etc/postgresql-custom -xpf -
echo "${PIPESTATUS[@]}"

sh run.sh start
docker compose ps
docker compose exec db psql -U postgres -c 'SELECT count(*) FROM auth.users;'
docker compose exec db psql -U postgres -c '\dt public.*'
docker compose exec db psql -U postgres -c 'SELECT extname FROM pg_extension;'
```

**It passes only if all of these are true, and written down:**

- [ ] All services become healthy.
- [ ] Row counts and `auth.users` match the recorded facts.
- [ ] A test account can sign in on the restored server, proving `.env` and roles match.
- [ ] Any Vault or encrypted value in use can be read, proving the key restored.
- [ ] Date, person, backup used, time taken and how old the backup was are recorded.

Repeat it after any upgrade and on a regular schedule the team sets. Then wipe the drill
machine, because it holds real data and secrets.

## 9. Remote access plan (not implemented)

**Choices left to the team:** the VPN product and its licence (no provider is assumed, and
business use is not assumed to be free), the private DNS name, the TLS certificate method,
and whether office machines also use the VPN. Nothing below has been configured.

```
Operator's AV Backup app (publishable key + own login)
   |  VPN, team-managed
   v
Office PC, HTTPS 443, reachable from VPN/office ranges only
   |  reverse proxy: allow only the paths the app needs
   v
Gateway -> Auth and REST -> Postgres
```

**Rules:**

- **No router port-forwarding** of 80, 443, 5432, 6543 or 8000 to this PC.
- **Raw Postgres (5432, 6543) stays local** to the server. Operators never connect to it,
  and neither does the app.
- **Studio stays private.** Maintainers use it on the PC itself, or by a private admin
  route agreed separately. The gateway's `/` is Studio, and `/pg/` is its database API, so
  **exposing port 8000 exposes the dashboard**. Keep 8000 bound to localhost and do not
  forward it.
- **Allow only needed paths** at the proxy: `/auth/v1/` and `/rest/v1/`, adding
  `/realtime/v1/` only if the sync design needs it.

**Do not adopt the stock Caddy override unchanged.**
[Supabase's HTTPS guide](https://supabase.com/docs/guides/self-hosting/self-hosted-proxy-https)
and its v0.8.4 files publish 80 and 443 on all interfaces, serve Studio behind basic auth
on the same hostname, and allow Storage, Functions and `/mcp` paths. They also leave 5432
and 6543 as they are. For this plan, the proxy needs local changes, which `update.sh` then
has to merge on every upgrade.

**Certificates.** The guide's automatic certificates assume a public DNS record and open
ports 80 and 443, which conflicts with a VPN-only server. The realistic options are a
DNS-validated certificate for a private name, or an internal CA trusted by every operator
machine and by the app. The guide calls self-signed certificates development only. The
team chooses, then we test.

**When set up, check from each location. Anything unexpected is a failure:**

| Test | Office LAN | VPN | Internet, off VPN |
|---|---|---|---|
| `https://<name>/auth/v1/` responds | as decided | yes | **no** |
| `https://<name>/` shows Studio | **no** | **no** | **no** |
| `https://<name>/pg/` | **no** | **no** | **no** |
| Connects to 5432, 6543 or 8000 | **no** | **no** | **no** |

Also set `SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL` and `SITE_URL` as the HTTPS guide
describes, and rerun the section 5 report. Docker Desktop can add its own Windows firewall
rules, so trust these tests, not the rule list.

## 10. Who can do what

These are **three separate kinds of access.** The first two do not exist yet: installing
Supabase does not create AV Backup operators or admins. Studio is not the admin screen.

| Who | Uses | Can do | Must never have |
|---|---|---|---|
| **Operator** (future app account) | App, own login, publishable key | Read and edit every schedule, add and delete rows | Studio login, secret key, `POSTGRES_PASSWORD`, `.env` |
| **Admin** (future app role) | Same app, own login, MFA | Also delete or restore a whole schedule, with an MFA-verified (aal2) session | Same as operator |
| **Server maintainer** | Studio, `.env`, Docker, on the PC | Everything, including bypassing all app rules; the only one who adds members or changes roles | Should not use these for daily app work |

The database rules, the bootstrap steps and the sync protocol are in
[supabase/SYNC_CONTRACT.md](../supabase/SYNC_CONTRACT.md).

The publishable key is [for client-side use](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys)
and stands in for the limited `anon` role. Security comes from each person's login and the database
rules. The **secret key**, `SERVICE_ROLE_KEY`, Postgres passwords and dashboard
password must never ship in the app or this repo. This follows the rule from the Frappe
removal: no key on an operator's machine that could damage the whole database.

## 11. Upgrades and ownership

**Name one owner and a deputy** before going live. They own Supabase versions, Docker
Desktop, WSL and Windows patching, backups, drills and access. Self-hosted updates
are [not automatic](https://supabase.com/docs/guides/self-hosting/updating), and
snapshots arrive about monthly.

Each upgrade:

1. Read the [changelog](https://github.com/supabase/supabase/blob/master/docker/CHANGELOG.md).
2. Take a **cold backup**. `update.sh` saves config to `backups/` but explicitly not
   Postgres or Storage data, and there is no documented database rollback. Going back means
   restoring from the backup.
3. Try it on the drill machine first.
4. Outside events, in `~/supabase-project`:

   ```bash
   sh update.sh --dry-run --to self-hosted/vX.Y.Z
   sh update.sh --to self-hosted/vX.Y.Z    # exit status 2 means merge conflicts to resolve
   sh run.sh pull
   sh run.sh recreate
   docker compose ps
   ```

5. Repeat the section 6 checks, confirm `docker-compose.office.yml` still applies, and
   update the version pin in this document.

## 12. Next required work (none of this exists yet)

**Server**, after decisions in section 2:

1. Run Stage 0 and settle edition, disk and licence.
2. Run Stages 1 and 2 and the HDD evaluation, then choose a restart option.
3. Pass a restore drill.
4. Choose and test VPN, DNS, certificate and proxy.

**Backend.** A first version is in the repo and tested only on a disposable local
PostgreSQL 16: [supabase/migrations/](../supabase/migrations/), contract
[supabase/SYNC_CONTRACT.md](../supabase/SYNC_CONTRACT.md), tests `tests/supabase/run.sh`.
It covers:

- server-held membership and roles that only the maintainer can change;
- every check made in the database;
- whole-schedule deletion limited to an admin with aal2;
- versions and durable conflicts;
- idempotent batches and a change cursor.

Still open:

5. Apply it on the pinned Supabase PostgreSQL 17 stack and repeat the scenarios through
   PostgREST with real tokens.
6. Turn on TOTP MFA in Auth for admins. Until then, nobody can delete a whole schedule.
7. Members are added with `avb_private.set_member` in the SQL editor
   ([bootstrap](../supabase/SYNC_CONTRACT.md#maintainers-bootstrap-and-members)), which
   works with `DISABLE_SIGNUP=true` and gives admins no Studio access.

**App**

8. Login, session storage using the OS credential store, and a publishable-key-only
   configuration.
9. Offline cache and sync on the contract above. This includes:
   - per-target diffs against the displayed base;
   - a conflict screen;
   - a cache kept separately for each account, with pending uploads quarantined on revoke;
   - a one-time, opt-in import of existing local schedules that changes no local file.
10. A deliberate decision about `test_engine_has_no_network_code` in
    `tests/test_vingest.py`: the Python engine is tested to have no network code. Keeping
    sync out of the engine would keep this guard intact.
11. Footage and manifest handling stays SSD-local throughout.
