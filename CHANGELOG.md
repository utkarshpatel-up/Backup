# Changelog

Each release's section is what the app shows under "What's new" when it offers that
update. Add a `## <version>` section here before pushing the version tag (see
[docs/RELEASING.md](docs/RELEASING.md)); the release build stops if it is missing.

## 1.7.0

- **Updates from inside the app.** The sidebar says when a new version is out, shows
  what changed, and installs it. On Windows it downloads only what changed and installs
  on restart. On a Mac it downloads the installer and opens it; drag AV Backup into
  Applications to finish. This version is the last one you install by hand.
- **Team account (optional).** Sign in under Account to share event schedules and report
  records with the team, through Neon. Local files keep working without it.
- **Account messages say what went wrong**, such as "The team server could not be
  reached", instead of one general message.
- **Event schedule:** several events per row, and session numbers follow added sessions.
- **Report:** export.
- The Frappe connection is gone: no database key is kept on this computer.
