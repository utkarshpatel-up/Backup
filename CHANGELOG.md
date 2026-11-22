# Changelog

Each release's section is what the app shows under "What's new" when it offers that
update. Add a `## <version>` section here before pushing the version tag (see
[docs/RELEASING.md](docs/RELEASING.md)); the release build stops if it is missing.

## 2.0.7

- **H264 MM Backup: ticked clips are numbered without gaps.** Untick a clip and the ones you keep are numbered Clip-01, 02, 03 … in card order. An unticked clip stays in the list as "not copied", so you can tick it again.
- **Event schedule: M before E on the same date.** When the schedule is sorted by date, a folder's sessions on one day always show in M, then E order (1, 2 … for Informal), however the rows were read or added.

## 2.0.6

- **H264 MM Backup: copy only the clips you tick.** Each clip in the list has a tick box, with a tick-all box on top. With nothing ticked, every clip is copied as before. Clips keep their numbers from the whole card.
- **H264 MM Backup shows the transfer speed** and the time left while copying.
- **Informal with one camera: clips go straight into the session folder.** When an Informal session has one camera folder at most, its clips are filed into the session folder (Root) instead of Cam-01, and no empty Cam-01 is left. Insert a second card or press Add Cam-02 to use camera folders again.
- **Rename a backed-up folder to an event schedule row.** Right-click a row and choose **Rename backed-up folder to this row…**, pick the session folder, and choose whether to rename its copy on the other drive too. You see every change before anything is renamed. The folder keeps its Dur- and Clips-, the masters named after it are renamed too, and the job folder is renamed only when this session is the only one in it. The row then takes its duration and clip count from the renamed folder.
- **Pujyashree's Entry / Welcome / Exit keep the event.** Ticking one of these now gives "Anand JJ Pujyashree's Entry E. …" instead of dropping the JJ (and GP, PP the same way).

## 2.0.5

- **Event schedule opens in date order.** Every time you open a schedule, the rows are sorted by date, oldest first (D ▲). Sorting by Y, M or D now uses the whole date, so the end of one month no longer comes after the start of the next. Click the D header to switch between oldest first, newest first and the schedule's own order.
- **Durations come from the ProRes / SSD drive.** When a backup finishes, the row's duration is read from the ProRes destination first, then from a drive named like SSD-01, SSD-09 or SSD 15, then from any other destination.
- **Adding camera clips uses the SSD drives first.** When you add camera clips to a session that is already backed up and it is on several drives, the SSD-named drives take the clips and give the row its duration, including the value shown before the copy finishes.

## 2.0.4

- **See what the Excel file had for a purple row.** In the report, a purple "Schedule · replaces existing" row now has a ▸ in front of its Raw Video ID. Click it to show the entry from the existing data (Excel) underneath, with the cells that differ highlighted.
- **Keep one of the two.** Right-click a purple row, or the Excel entry under it:
  - **Keep the Excel entry** asks first and lists every change, then changes the event schedule row to match. The row turns white on every computer and **Save as Excel** leaves it out.
  - **Keep the event schedule entry** leaves it purple, ready to upload to Frappe.
  - When the dates differ, Keep the Excel entry is greyed out: change the date on the event schedule row yourself, since it can renumber the schedule.
- **New schedules start after every folder already used.** The first Formal and Informal folder numbers of a newly read schedule now come after every folder the team's schedules use, including sessions added later with **Add unplanned session**, and after the report's own folders. Pressing **Save .xlsx** is no longer needed to keep them right.
- **Right-click on the event schedule explains itself.** While a backup is set up but not finished, the schedule is locked; right-clicking a row now says so and how to put that backup aside, instead of doing nothing. Right-clicking a row that isn't ticked says to tick it first.

## 2.0.3

- **Report: schedule rows already in Frappe show as normal.** After uploading the event schedule to Frappe and reading the downloaded report back in, a session that is exactly the same in both now shows in normal white text instead of purple "Schedule · replaces existing". **Save as Excel** leaves it out, so it is not uploaded twice. If anything differs, the schedule's version is still shown in purple. The **Source** filter still finds these rows under **In both**.

## 2.0.2

- **Starting a backup from the event schedule after Only camera clips.** After an **Only camera clips** job, starting the next backup of the same type (Formal or Informal) from the event schedule kept the old clips-only job, so **Next** on the Sources page stayed greyed out. Each backup started from the schedule now begins fresh.
- **Only camera clips keeps the session's date and your camera choices.** The Cameras page now uses the date in the chosen session folder's name from the moment it opens, so clips from another day are flagged correctly. Going on to the Folder step no longer picks a master or clears the cameras you had assigned.

## 2.0.1

- **H264 MM Backup.** A new backup for the HyperDeck Studio Mini's H.264 recording of a Formal master, for the multimedia team. Open it from the new card under **Only camera clips** on the Formal Sources page, or right-click a Formal row on the Event schedule. Each file is named exactly like the H.265/ProRes masters with the folder number in front, for example `3058 Adalaj Soneri Satsang E. Dt-17-Oct-26 Dur-44m43s Clip-01.mp4`, and only the files are copied, flat into one folder on the server, an HDD or an SSD. Clips are numbered from the HyperDeck Studio Mini SD card itself, so a card that split the recording differently is still numbered correctly. Every file is checked after copying, and nothing is ever overwritten. This copy is never counted in a session's duration or in the report, so it cannot be saved inside a job folder.
- **Right-click menu on the event schedule.** **Clips only** and **H264 MM Backup** are on a row's right-click menu (or the keyboard's Menu key) instead of buttons, so the schedule shows more columns. A row whose backup started and did not finish has an orange dot on its Start backup button.

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
