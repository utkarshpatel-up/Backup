# Changelog

Each release's section is what the app shows under "What's new" when it offers that
update. Add a `## <version>` section here before pushing the version tag (see
[docs/RELEASING.md](docs/RELEASING.md)); the release build stops if it is missing.

## 2.0.0

- **Team server.** No new server files in this version, but the team server needs the files from 1.10.0 or later, or entries with Remarks are refused.
- **Schedules with dark cells are read.** A schedule whose dates or title sit on a dark (navy or maroon) background, such as the JJ 119 Anand PDF, came out empty. It is now read in full, from the PDF or from a picture saved from it.
- **Several files as one schedule.** Choose or drop several pictures and PDFs at once; they are read together into one schedule.
- **Event in Informal folder names.** A backup started from the event schedule now names an Informal session folder with its event, for example `Adalaj Diwali Pujyashree's Informal Satsang with Sankul Dt-09-Nov-26`.
- **Shorter names for three events.** Gurupurnima, Janma Jayanti and Pranpratishtha are written GP, JJ and PP in folder and clip names. The report and the sheet keep the full words.
- **No empty Cam-01 folders.** A backup started from the event schedule makes a camera folder only when that camera's clips are copied, for Formal and Informal.
- **Removing the structure stops a schedule backup in Formal too**, as it already did in Informal.
- **Filter and sort the event schedule.** Every column has a filter box under its header, and clicking a header sorts by it (again to reverse, a third time for the schedule's own order). Only what is shown changes.
- **Ctrl+D, as in Excel.** In the event schedule and the report, Ctrl+D (Cmd+D on a Mac) fills a cell from the cell above.
- **Schedule titles.** Give a schedule your own title, at the top of the open schedule or in Past schedules. It is shared with the team; leave it empty to use the file name.
- **Copy a report entry to the event schedule** with the ⧉ button by its Raw Video ID. The date, folder number, duration and number of clips are not copied; set the date on the new row.
- **Suggestions when correcting the report.** The edit box offers the values already in the report, as the event schedule does.
- **Faster typing with a team account.** After each entry is saved, only the changed rows are redrawn instead of the whole page, so the event schedule and the report no longer freeze for a moment after every entry.
- **Remarks on re-import.** Importing the report file to the team again fills in empty fields, such as Remarks, on entries the team already has. Values that are already filled in, and corrected (orange) cells, are kept, and no conflicts are made.
- **Camera cards open sorted by Type** (by Kind on a Mac) when you open them after a copy.
- **Slim scrollbars** that follow the light or dark theme.

## 1.10.1

- **Update the team server first.** Copy the new `server/pb_hooks` files to the PocketBase server and restart it before anyone uses this version. With the old server files, corrected (orange) report cells stay on the computer that made them and never reach the others.
- **History for each entry.** On the Report page, click the Raw Video ID of a blue (event schedule), purple or orange (corrected) row to see every change made to that entry, who made it, and when. The History card on the Account page is gone.
- **Corrected rows stand out.** A row with corrected cells now shows its Raw Video ID in orange too.
- **Mark as uploaded.** After you upload the orange rows to Frappe, press Mark as uploaded on the Report page. The orange is removed on every computer and the corrected values stay; Save as Excel no longer includes those rows.
- **Failed uploads are shown.** The Report page now says when changes could not be uploaded, so other computers do not have them.
- **Refused changes are sent again by themselves.** A change the old server refused is sent again on each sync until the updated server accepts it. You no longer need to retry it on the Account page.

## 1.10.0

- **Update the team server first.** Copy the new `server/pb_hooks` files to the PocketBase server and restart it (see docs/POCKETBASE_SETUP.md) before anyone uses this version. Until then, saving a Remarks note or a corrected report cell is refused by the old server.
- **Signed-in name in the top bar.** After you sign in, the Account button shows your name. Open it for Dashboard or Log Out. If the maintainer did not set a display name for you, the name you gave when creating the account is used.
- **Frappe Report button** on the Report page opens the Frappe site.
- **Recent e-mails when signing in.** The e-mail box offers the last 10 e-mails used on this computer. Passwords are never saved.
- **Remarks column.** The event schedule and the report now have a Remarks column. It is read from imported Excel files, saved to the team, and included when you export the report.
- **History.** The Account page lists what each team member changed: who changed which value from what to what, and which entries were imported.
- **Correct imported report entries.** Double-click a cell of the existing data to change it. Corrected cells turn orange and sync to every computer; type the original text back to remove the orange. "Save as Excel" on the Report page saves every orange (corrected), purple (replaces an existing entry) and blue (from a schedule) row, ready to upload to Frappe.

## 1.9.1

- **Team server status in the sidebar.** A new box above the engine status shows whether this computer is on the team's ZeroTier network and whether the PocketBase server is running, with a button to the Account page. The "Set Cloudflare DNS & restart" button is gone; it is no longer needed.
- **Sort the event schedule by Raw number.** Choose Ascending or Descending; changing a row's Raw (folder) number moves it into place straight away.
- **Missing cameras are caught before copying.** The Cameras page lists each camera the structure expects as received or missing. If one is missing, Start copy asks you to confirm before going ahead with a partial session.
- **A copy that will not fit is stopped before it starts.** The Copy step names the drive and how many GB are short. When a drive would be left nearly full, you get a warning.
- **Conflicts are easier to read.** Each sync conflict is shown as a small table: the current value, the incoming one and your draft, with the differences highlighted.
- **Sign-in remembers your e-mail.** The password is never saved. Use "Forget e-mail" to clear it.
- 1.9.0 was not released; this version contains everything listed above.

## 1.9.0

- **Team server status in the sidebar.** A new box above the engine status shows whether this computer is on the team's ZeroTier network and whether the PocketBase server is running, with a button to the Account page. The "Set Cloudflare DNS & restart" button is gone; it is no longer needed.
- **Sort the event schedule by Raw number.** Choose Ascending or Descending; changing a row's Raw (folder) number moves it into place straight away.
- **Missing cameras are caught before copying.** The Cameras page lists each camera the structure expects as received or missing. If one is missing, Start copy asks you to confirm before going ahead with a partial session.
- **A copy that will not fit is stopped before it starts.** The Copy step names the drive and how many GB are short. When a drive would be left nearly full, you get a warning.
- **Conflicts are easier to read.** Each sync conflict is shown as a small table: the current value, the incoming one and your draft, with the differences highlighted.
- **Sign-in remembers your e-mail.** The password is never saved. Use "Forget e-mail" to clear it.

## 1.8.0

- **The team server is now a PocketBase server on an office computer, reached over ZeroTier.**
  Account mode no longer uses Neon, so it no longer depends on the network's DNS or on
  reaching the internet. Each computer joins the team's ZeroTier network, then in
  **Account → Advanced settings** enters the one **Server address** (for example
  `http://10.147.20.5:8090`) and signs in. Your schedules and report records are not
  lost: local files are untouched, and anything unsent stays encrypted on this computer.
- **After updating, account mode is off until you enter the new server address**, and you
  sign in again with an account on the new server (the maintainer adds it).
- A failed connection now names the reason, for example `(EHOSTUNREACH)`, so it is clear
  whether ZeroTier or the server is the problem.

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
