# Changelog

Each release's section is what the app shows under "What's new" when it offers that
update. Add a `## <version>` section here before pushing the version tag (see
[docs/RELEASING.md](docs/RELEASING.md)); the release build stops if it is missing.

## 1.7.4

- **Sign-in and sync work when the network's DNS is down.** If the computer's DNS server
  times out, AV Backup now looks the server up through Cloudflare instead, so Account
  sign-in and sync keep working without changing the computer's DNS settings or breaking
  names on the local network.

## 1.7.3

- **Redesigned Account, sign-in and create-account pages.** They now fit narrow and wide
  windows alike.
- **Typing and focus are kept** when the app refreshes in the background, so a form you
  are filling in is no longer interrupted.
- **Reports and schedules render faster** when the lists are large.
- **Cloudflare DNS setup for Windows and macOS.** The app can set the computer's DNS to
  Cloudflare. It asks for administrator permission and restarts only AV Backup, not the
  computer.

## 1.7.2

- **Sign in and Create account are separate.** The Account page shows one form at a
  time, and hides them once you are signed in.
- **Account errors name the reason** in more cases, including when the Mac's Keychain
  refuses access.

## 1.7.1

- **Exported Excel files import into Frappe.** A schedule or report export with a
  continuation row (an extra event type or language) was refused by Frappe's Data
  Import ("Row has less values than columns"). Exports now open the same way as the
  official Raw Satsang Master.

## 1.7.0

- **Updates from inside the app.** The sidebar says when a new version is out, shows
  what changed, and installs it. On Windows it downloads only what changed and installs
  on restart. On a Mac it downloads the installer and opens it; drag AV Backup into
  Applications to finish. This version is the last one you install by hand.
- **Team account (optional).** Sign in under Account to share event schedules and report
  records with the team, through Neon. Local files keep working without it.
- **Import an existing data report into the team.** On the Report page, **Import file
  to team…** asks for the Excel file, previews it and uploads it; large sheets (17,000
  rows and more) upload in the background. The Account page shows how many changes are
  left to send.
- **Sync no longer stops after a quiet spell.** The team server pauses when idle; the
  app now waits for it to start and carries on, instead of asking you to sign in again.
- **Account messages say what went wrong**, such as "The team server could not be
  reached", instead of one general message.
- **Event schedule:** several events per row, and session numbers follow added sessions.
- **Report:** export.
- The Frappe connection is gone: no database key is kept on this computer.
