# Team sync on Neon: setup

> **Status: not yet tried on a real Neon project.** The database rules and the app's
> account mode are built and tested locally against stand-ins (see
> [../db/SYNC_CONTRACT.md](../db/SYNC_CONTRACT.md)). The first real setup below is also
> the first real test; step 7 lists what to check and report.

Neon hosts the database, the API and sign-in, so there is no server, Docker or VPN to
run. Footage and manifests never leave the SSDs; only schedule text and metadata go to
Neon. Account mode is optional: until it is set up, the app works from local files as
before.

## What you need to know first

- **Two addresses, both public.** The **Auth URL** (Managed Better Auth) and the **Data
  API URL**. Every operator enters both in the app. They are not secrets.
- **One secret: the owner connection string** (`neondb_owner`). It has full access to
  the database. Keep it in the team's password manager; never put it in this repo, the
  app, a ticket or an operator's computer. Only the maintainer uses it, for steps 4
  and 6.
- **Anyone can create an account.** Neon cannot restrict sign-up yet. That is safe here:
  a new account sees and changes nothing until the maintainer adds it (step 6).
- **Free plan** limits: check [neon.com/pricing](https://neon.com/pricing). The database
  pauses after 5 idle minutes, so the first sync after a quiet spell takes a few
  seconds longer.

## Steps (maintainer)

1. **Create a Neon project** at [console.neon.tech](https://console.neon.tech). Pick an
   **AWS** region near the office: Managed Better Auth is AWS-only. Do not turn on IP
   Allow or Private Networking, which Managed Better Auth does not support.
2. **Turn on Auth** for the project's main branch (Console, Auth). Copy the **Auth
   URL**. It ends in `/neondb/auth`.
   - Turn **off** "Allow Localhost" (Settings, Better Auth), as Neon's production
     checklist advises. The app does not need it.
3. **Turn on the Data API** for the `neondb` database, with **Neon Auth** as the
   authentication provider. Copy the **Data API URL**. It ends in `/neondb/rest/v1`.
   - Keep the exposed schema as `public` only. Do not expose `avb_private`.
   - The "Grant public schema access" option makes no difference to this app either
     way. Its tables are in `avb_private`, and its functions grant access themselves.
4. **Apply the database migration once**, as `neondb_owner`. Either open the Console's
   SQL Editor and run the whole of
   [`db/migrations/20261107000000_av_backup_sync_v1.sql`](../db/migrations/20261107000000_av_backup_sync_v1.sql),
   or use psql:

   ```bash
   psql "<owner connection string>" -v ON_ERROR_STOP=1 -f db/migrations/20261107000000_av_backup_sync_v1.sql
   ```

   It runs in one transaction and changes nothing that already exists. Any error means
   nothing was applied. Send the error text, not the connection string.
5. **Each person creates an account in the app.** Open the app, choose **Account**,
   tick "Use team account", paste both URLs, and save. Then enter an e-mail, a password
   (8 or more characters) and a name, and choose **Create account**. Signing in now
   shows "not an active team member". That is expected until step 6.
6. **Add each person** in the SQL Editor, as `neondb_owner`:

   ```sql
   -- Find the account; check the e-mail and that createdAt matches when they made it.
   select id, email, "createdAt" from neon_auth."user" order by "createdAt" desc;

   select avb_private.set_member('<id>', 'person@example.org', 'operator', true, 'Their Name');
   select avb_private.set_member('<your id>', 'you@example.org', 'admin', true, 'Your Name');

   -- Revoke: the next call is refused, even with a still-valid token. Works after the
   -- account is deleted, too.
   select avb_private.set_member('<id>', 'person@example.org', 'operator', false);
   ```

   Both the id and the e-mail are needed: they must name the same account. If the
   e-mail shows an account the person did not create, do not add it. Ask them to sign
   up with another address.
   - **Never use the Console's "Make admin"** on a Neon Auth user. The app's admin role
     is the one set here. Neon's admin role would make the Data API refuse that person
     (the app says so at sign-in).
7. **First real test.** Check these, and report anything that fails with the exact
   message the app shows (never a password):
   - [ ] Sign-in works; Account shows your name and role.
   - [ ] An account that was not added gets "not an active team member".
   - [ ] **Sync now** works. A schedule imported on one computer appears on a second one.
   - [ ] Edits to different rows on two computers both survive. The same row edited on
     both shows a conflict.
   - [ ] As admin, deleting a whole schedule works, and an operator cannot.
   - [ ] After revoking someone (step 6), their next sync is refused.
   - [ ] Repeat on a Windows computer.

## Backups

Neon keeps a history for point-in-time restore. Its length depends on the plan, so
check it in the Console. For a copy you control, the maintainer can export from time to
time:

```bash
pg_dump "<owner connection string>" --schema=avb_private --schema=neon_auth -Fc -f avb-$(date +%F).dump
```

Keep exports encrypted and off operators' computers. They contain the team's metadata
and account records.

## When something is off

- **"Wrong e-mail or password"**: check the address, or create the account (step 5).
- **"Not an active team member"**: step 6 has not been done, or was revoked.
- **"The team server could not be reached"**: no internet, a wrong URL, or a company
  proxy that intercepts HTTPS (not supported: the app verifies Neon's certificate
  itself).
- **"Account mode is not set up"**: paste both URLs in Account and save.
