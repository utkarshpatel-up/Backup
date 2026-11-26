/* ------------------------------------------------------------------ Help */

// The Help page: how the team's backup scheme works, for someone new to it —
// what is recorded at an event and where it ends up, Formal against Informal,
// how every name is read, where the files go, and how each job is done in the
// app, drawn rather than written out. Read-only: it can stay open while a copy
// runs, with the progress in the footer as usual.

function showHelp() {
  state.view = 'help';
  render();
}

const HELP_SECTIONS = [
  ['help-picture', 'The big picture'],
  ['help-types', 'Formal or Informal'],
  ['help-names', 'Reading the names'],
  ['help-files', 'Where the files go'],
  ['help-howto', 'How to…'],
  ['help-colours', 'Report colours'],
];

/* ------------------------------------------------ the big picture */

function helpPictureHtml() {
  const node = (icon, title, sub, cls = '') => `<div class="help-node ${cls}"><div class="help-node-icon">${icon}</div>
    <div><b>${esc(title)}</b>${sub ? `<div class="hint" style="margin:2px 0 0">${esc(sub)}</div>` : ''}</div></div>`;
  const col = (title, body) => `<div class="help-col"><div class="help-col-title">${esc(title)}</div>${body}</div>`;
  const arrow = '<div class="help-flow-arrow" aria-hidden="true">➜</div>';
  return `<div class="help-flow">
    ${col('At the event', `
      <div class="help-group"><div class="help-group-title">🎛 Video mixer — the programme (Formal)</div>
        ${node('💾', 'ProRes recorder', 'records the master onto an SSD, e.g. SSD-10', 'prores')}
        ${node('💾', 'H.265 recorder', 'the same master, smaller, onto a second SSD', 'h265')}
        ${node('📼', 'HyperDeck Studio Mini', 'a third copy in H.264, on an SD card')}</div>
      ${node('🎥', 'Cameras', 'each records on its own SD card (CanonA, CanonB …)')}
      ${node('🎙', 'Audio recorder · drone', 'cards too, filed as Cam-NN (Audio) / (Drone)')}`)}
    ${arrow}
    ${col('AV Backup', `
      ${node('≡', 'Event schedule', 'the day\'s sessions, numbered: each gets its folder and Raw Video ID', 'mark')}
      ${node('1–5', 'Backup', 'Sources → Folder → Cameras → Copy → Verify, started from the session\'s row', 'mark')}
      ${node('📼', 'H264 MM Backup', 'the HyperDeck card, on its own, at the start or end of the day', 'mark')}`)}
    ${arrow}
    ${col('Kept on', `
      ${node('💾', 'Two SSDs, identical', 'each holds the whole session: its own master plus every camera clip', 'prores')}
      ${node('🗄', 'H264 folder', 'on the server, for the multimedia team to edit from')}`)}
    ${arrow}
    ${col('On record', `
      ${node('▤', 'Report', 'every session on record plus the schedules\' rows', 'mark')}
      ${node('⇪', 'Frappe', 'Save as Excel, then import: the Raw Video Data Report')}`)}
  </div>`;
}

/* ------------------------------------------------ Formal or Informal */

function helpTypesHtml() {
  const card = (cls, title, lines, id, layout) => `<div class="help-type ${cls}">
    <div class="help-type-head"><b>${esc(title)}</b><code>${esc(id)}</code></div>
    <ul>${lines.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <div class="help-type-layout mono">${layout}</div></div>`;
  return `<div class="help-types">
    ${card('formal', 'Formal', [
      'The programme sessions, run through the video mixer: M before noon, E from noon (M1, M2 / E1, E2 when there are several).',
      'The mixer\'s output is the master, already on the two SSDs when the session ends.',
      'The cameras are extra angles: Clips for Insert, keeping their card names.',
      'Folder numbers: the Formal series (… 3066, 3067, 3068), one per day.',
    ], 'DD-F-4K-3068-E', '📁 session<br>&nbsp;&nbsp;🎞 masters (named after the folder)<br>&nbsp;&nbsp;📁 Clips for Insert / Cam-01 …')}
    ${card('informal', 'Informal', [
      'Everything recorded on cameras alone: visits, meetings, darshan, informal sessions.',
      'There is no master: the camera clips are the recording.',
      'Every clip is renamed after the session, in the order it was recorded.',
      'Sessions 1, 2, 3 in the day. Folder numbers: the Informal series (… 2627, 2628, 2629).',
    ], 'DD-I-HD-2629-1', '📁 session<br>&nbsp;&nbsp;📁 Cam-01 / Cam-01 … Clip-001.MP4<br>&nbsp;&nbsp;(one camera: the clips sit in the session itself)')}
  </div>`;
}

/* ------------------------------------------------ reading the names */

/**
 * A name as it is written, each part underlined in its colour, and underneath
 * a key: the same colour, the part, and what it means. Parts are [text, meaning,
 * colour]; colour 0 (a separator, an extension) gets no key.
 */
function helpAnatomy(title, parts, note) {
  const name = parts.map(([text, , c]) => {
    const lead = text.match(/^\s*/)[0];
    return `${lead}<span class="help-part c${c}">${esc(text.slice(lead.length))}</span>`;
  }).join('');
  const key = parts.filter(([, label, c]) => c && label).map(([text, label, c]) => `<span class="help-key-item c${c}">
    <span class="help-key-dot"></span><code>${esc(text.trim())}</code><span>${esc(label)}</span></span>`).join('');
  return `<div class="help-anatomy">
    <div class="help-anatomy-title">${esc(title)}</div>
    <div class="help-anatomy-name mono">${name}</div>
    <div class="help-anatomy-key">${key}</div>
    ${note ? `<div class="hint" style="margin:8px 0 0">${esc(note)}</div>` : ''}
  </div>`;
}

function helpNamesHtml() {
  return `
    ${helpAnatomy('Raw Video ID — one per session, on the schedule, the report and in Frappe', [
      ['DD', 'author', 1], ['-', '', 0], ['F', 'F Formal · I Informal', 2], ['-', '', 0], ['4K', 'format: HD or 4K', 3], ['-', '', 0],
      ['3068', 'folder number', 4], ['-', '', 0], ['E', 'session: M / E, or 1, 2, 3', 5]])}
    ${helpAnatomy('Job folder — one per folder number', [
      ['3068', 'folder number', 4], [' Dt-21 Nov 2026', 'the day', 6]])}
    ${helpAnatomy('Session folder — inside the job folder', [
      ['02', 'place in the job folder', 7], [' Anand', 'city', 1], [' JJ', 'event', 2], [' General Satsang', 'topic', 3],
      [' E.', 'session', 5], [' Dt-21-Nov-26', 'date', 6], [' Dur-1h42m', 'all masters together', 8], [' Clips-04', 'number of masters', 4]],
      'The place number is left off when the session is alone in its job folder. Events are written short: JJ Janma Jayanti, GP Guru Purnima, PP Pran Pratishtha. Dur- and Clips- are added by the backup once every file has landed; an Informal folder carries only Clips-, its number of clips.')}
    ${helpAnatomy('Formal master — in the session folder', [
      ['Anand JJ General Satsang E. Dt-21-Nov-26', 'the folder\'s name, without its place number', 3],
      [' Dur-46m40s', 'this clip\'s length', 8], [' Clip-03', 'its place among the masters', 4], ['.MOV', '', 0]],
      'An entry or exit clip has the topic swapped: Anand JJ Pujyashree\'s Entry E. Dt-21-Nov-26 Dur-1m18s Clip-01.MOV')}
    ${helpAnatomy('Informal clip — in its camera folder', [
      ['Cam-01', 'camera', 5], [' Anand JJ Darshan', 'the session\'s event name', 3], [' Clip-001', 'order recorded, per camera', 4], ['.MP4', '', 0]],
      'With one camera there is no Cam- in front. A session\'s only clip has no Clip- number.')}
    ${helpAnatomy('H264 MM file — in the H264 folder', [
      ['3068', 'folder number', 4], [' Anand JJ General Satsang E. Dt-21-Nov-26 Dur-46m40s Clip-03', 'named like the master', 3], ['.mp4', '', 0]])}`;
}

/* ------------------------------------------------ where the files go */

function helpFilesHtml() {
  const tree = (lines) => `<div class="help-tree mono">${lines.map(([depth, text, kind]) =>
    `<div class="help-tree-row ${kind || ''}" style="padding-left:${depth * 16}px">${esc(text)}</div>`).join('')}</div>`;
  const drive = (name, badge, lines) => `<div class="help-drive">
      <div class="help-drive-head">💾 <b>${esc(name)}</b> ${badge ? `<span class="badge ${badge}">${badge === 'prores' ? 'ProRes' : 'H.265'}</span>` : ''}</div>
      ${tree(lines)}</div>`;
  const ssd = (ext) => [
    [0, '3068 Dt-21 Nov 2026', 'dir'],
    [1, '02 Anand JJ General Satsang E. Dt-21-Nov-26 Dur-1h42m Clips-04', 'dir'],
    [2, `Anand JJ Pujyashree's Entry E. Dt-21-Nov-26 Dur-1m18s Clip-01.${ext}`, 'master'],
    [2, `Anand JJ General Satsang E. Dt-21-Nov-26 Dur-3m2s Clip-02.${ext}`, 'master'],
    [2, `Anand JJ General Satsang E. Dt-21-Nov-26 Dur-46m40s Clip-03.${ext}`, 'master'],
    [2, `Anand JJ General Satsang E. Dt-21-Nov-26 Dur-51m21s Clip-04.${ext}`, 'master'],
    [2, 'Clips for Insert', 'dir'],
    [3, 'Cam-01', 'dir'], [4, 'C0001.MP4', 'clip'],
    [3, 'Cam-02', 'dir'], [4, 'A001C002.MP4', 'clip'],
  ];
  const informal = [
    [0, '2629 Dt-21 Nov 2026', 'dir'],
    [1, 'Anand JJ Dimplebhai\'s Experience Session Dt-21-Nov-26 Clips-03', 'dir'],
    [2, 'Cam-01', 'dir'],
    [3, 'Cam-01 Anand JJ Dimplebhai\'s Experience Session Clip-001.MP4', 'clip'],
    [3, 'Cam-01 Anand JJ Dimplebhai\'s Experience Session Clip-002.MP4', 'clip'],
    [2, 'Cam-02 (Audio)', 'dir'],
    [3, 'Cam-02 Anand JJ Dimplebhai\'s Experience Session Clip-001.WAV', 'clip'],
  ];
  const root = [
    [0, '2630 Dt-22 Nov 2026', 'dir'],
    [1, 'Anand JJ Darshan Dt-22-Nov-26 Clips-02', 'dir'],
    [2, 'Anand JJ Darshan Clip-001.MP4', 'clip'],
    [2, 'Anand JJ Darshan Clip-002.MP4', 'clip'],
  ];
  return `
    <div class="help-subtitle">Formal</div>
    <div class="help-files">
      <div class="help-cards">📇 CanonA → Cam-01<br>📇 CanonB → Cam-02<div class="hint" style="margin:6px 0 0">camera cards</div></div>
      <div class="help-arrow">copied to both ➜</div>
      <div class="help-drives">${drive('SSD-10', 'prores', ssd('MOV'))}${drive('k', 'h265', ssd('mp4'))}</div>
    </div>
    <p class="hint" style="margin:8px 0 18px"><span class="help-key master">master</span> moved into the folder on its own drive (nothing is copied) ·
      <span class="help-key clip">camera clip</span> copied to both SSDs, card name kept</p>
    <div class="help-subtitle">Informal</div>
    <div class="help-files">
      <div class="help-cards">📇 Camera cards<div class="hint" style="margin:6px 0 0">each to its camera folder</div></div>
      <div class="help-arrow">copied &amp; renamed ➜</div>
      <div class="help-drives">${drive('Output drive · several cameras', '', informal)}${drive('Output drive · one camera', '', root)}</div>
    </div>
    <p class="hint" style="margin:8px 0 0"><span class="help-key clip">clip</span> renamed in the order recorded; with one camera
      the clips sit in the session folder itself</p>`;
}

/* ------------------------------------------------ how to … */

// Each job as a chain of steps; a step's mark is the sidebar page it happens on.
const HELP_HOWTO = [
  ['Back up a Formal session', 'The master is on the SSDs; the camera cards are in hand.', [
    ['≡', 'Event schedule: check the row, press Start backup'],
    ['1', 'Add both SSDs · Probe codecs & assign roles'],
    ['2', 'Check the names · masters ticked · Entry/Exit labels'],
    ['3', 'Import camera cards · Skip what is not this session'],
    ['4', 'Build the plan · Start'],
    ['5', 'Verify against the card · Compare the SSDs'],
    ['▤', 'Report · Save as Excel'],
  ]],
  ['Back up an Informal session', 'Only camera cards: no master.', [
    ['≡', 'Event schedule: press Start backup on the Informal row'],
    ['1', 'Choose the output directory'],
    ['2', 'Check the names'],
    ['3', 'Import camera cards · give each clip its camera'],
    ['4', 'Build the plan · approve the new names · Start'],
    ['5', 'Verify against the card'],
    ['▤', 'Report · Save as Excel'],
  ]],
  ['Take one session\'s clips from a card holding several', 'Cameras page.', [
    ['3', 'Narrow the list: filter or a day button'],
    ['⌨', '↑/↓ to move · Space to tick · Shift+↑/↓ to tick a run'],
    ['3', 'Press a camera (or Root / Skip) in the bar: every ticked clip goes there'],
  ]],
  ['Add camera clips that came late', 'Or finish a backup that stopped part way.', [
    ['≡', 'Right-click the row · Clips only'],
    ['≡', 'Confirm the session folders it found'],
    ['3', 'Import camera cards (or Add files…)'],
    ['4', 'Build the plan · Start'],
  ]],
  ['H264 MM Backup', 'Formal only, once a day: the HyperDeck Studio Mini SD card.', [
    ['≡', 'Right-click the Formal row · H264 MM Backup…'],
    ['📼', 'Choose the HyperDeck card'],
    ['🗄', 'Choose the output folder (the server)'],
    ['☑', 'Tick clips to copy only some — none ticked copies all'],
    ['▶', 'Start copy'],
  ]],
  ['Fix a session folder named wrongly', 'Already backed up, but its name or number is not the row\'s.', [
    ['≡', 'Right-click the row · Rename backed-up folder to this row…'],
    ['📁', 'Choose the session folder'],
    ['💾', 'Both drives, or Only this one'],
    ['👁', 'Read the preview · Rename'],
  ]],
  ['Fill durations for sessions already filed', 'Backed up earlier, or outside the app.', [
    ['≡', 'Fill durations from drive…'],
    ['💾', 'Choose the drive or folder holding the sessions'],
  ]],
  ['Eject the camera card', 'Once it is copied — Compare does not need it.', [
    ['📁', 'In Explorer, select the card (or open it)'],
    ['⌨', 'Press Ctrl+Alt+E — or Drive ▸ Eject card'],
    ['🔔', 'The notification says Safe to remove'],
  ]],
  ['Send the day to Frappe', 'After the day\'s backups.', [
    ['▤', 'Report: check the purple rows (▸ shows the difference)'],
    ['▤', 'Right-click one to keep the Excel or the schedule entry'],
    ['▤', 'Save as Excel'],
    ['⇪', 'Import it in Frappe'],
  ]],
];

function helpHowtoHtml() {
  return `<div class="help-howtos">${HELP_HOWTO.map(([title, when, steps]) => `<div class="help-howto">
    <div class="help-howto-head"><b>${esc(title)}</b><span class="hint" style="margin:0">${esc(when)}</span></div>
    <ol class="help-chain">${steps.map(([mark, text]) => `<li><span class="help-step-mark">${esc(mark)}</span>
      <span>${esc(text)}</span></li>`).join('')}</ol></div>`).join('')}
    <p class="hint" style="margin:4px 0 0">≡ Event schedule · 1 Sources · 2 Folder · 3 Cameras · 4 Copy · 5 Verify · ▤ Report — the marks in the sidebar.</p>
  </div>`;
}

/* ------------------------------------------------ report colours */

function helpColoursHtml() {
  const row = (cls, name, text) => `<div class="help-colour"><span class="help-swatch ${cls}">${esc(name)}</span>
    <span>${esc(text)}</span></div>`;
  return `<div class="help-colours">
    ${row('plain', 'White', 'In Frappe already: the existing data. A schedule row that matches it shows this way too.')}
    ${row('blue', 'Blue', 'From an event schedule and not in Frappe yet: Save as Excel takes it.')}
    ${row('purple', 'Purple', 'From a schedule, replacing a Frappe entry that differs. ▸ shows the difference; right-click to keep one. No of cameras is never compared: Frappe\'s import has no such column yet.')}
    ${row('orange', 'Orange', 'Corrected here (double-click a cell): Save as Excel takes it until it is marked as uploaded.')}
    ${row('yellow', 'Yellow', 'A gap in the numbering: a folder or session number with nothing on record.')}
  </div>`;
}

/* ------------------------------------------------ the page */

function helpHtml() {
  const section = (id, title, body, lead = '') => `<div class="card help-section" id="${id}">
    <h3>${esc(title)}</h3>${lead ? `<p class="hint">${esc(lead)}</p>` : ''}${body}</div>`;
  return `
    <nav class="help-toc" aria-label="Help sections">${HELP_SECTIONS.map(([id, title]) =>
      `<a href="#${id}" class="help-toc-link">${esc(title)}</a>`).join('')}</nav>
    ${section('help-picture', 'The big picture', helpPictureHtml(),
      'What is recorded at an event, what AV Backup does with it, and where it ends up.')}
    ${section('help-types', 'Formal or Informal', helpTypesHtml(),
      'Every session is one or the other: it decides its numbers, its folders and how its files are named.')}
    ${section('help-names', 'Reading the names', helpNamesHtml(),
      'Every name follows the house convention, so each part can be read off it.')}
    ${section('help-files', 'Where the files go', helpFilesHtml())}
    ${section('help-howto', 'How to…', helpHowtoHtml())}
    ${section('help-colours', 'Report colours', helpColoursHtml())}`;
}

function helpPaint() {
  $('content').innerHTML = helpHtml();
  document.querySelectorAll('.help-toc-link').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
