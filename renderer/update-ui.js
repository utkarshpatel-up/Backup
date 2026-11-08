'use strict';
// Sidebar update notice (electron/updater.js does the work). Text only: release notes are
// shown with textContent, never as HTML.
(() => {
  const box = document.getElementById('update');
  const notes = document.getElementById('updateNotes');
  if (!box || !window.api || !window.api.update) return;
  const api = window.api.update;

  function button(label, fn, cls = 'sm') {
    const b = document.createElement('button');
    b.className = cls; b.textContent = label;
    b.addEventListener('click', () => { b.disabled = true; fn().catch(() => {}).finally(() => { b.disabled = false; }); });
    return b;
  }
  function showNotes(s) {
    document.getElementById('updateNotesTitle').textContent = `What's new in ${s.version}`;
    document.getElementById('updateNotesBody').textContent = s.notes || 'No notes for this version.';
    notes.showModal();
  }

  function render(s) {
    box.replaceChildren();
    const line = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'update-row';
    const mac = s.mode === 'dmg';
    switch (s.phase) {
      case 'checking': line.textContent = 'Checking for updates…'; break;
      case 'available':
        line.textContent = `Version ${s.version} is available (you have ${s.current}).`;
        row.append(button("What's new", async () => showNotes(s), 'sm ghost'),
          button(s.mode === 'page' ? 'Open download page' : mac ? 'Download installer' : 'Download update', api.download, 'sm primary'));
        break;
      case 'downloading': line.textContent = `Downloading ${s.version}… ${Number(s.percent || 0)}%`; break;
      case 'ready':
        line.textContent = `Version ${s.version} is ready.`;
        row.append(button('Restart to update', api.restart, 'sm primary'));
        break;
      case 'opened':
        line.textContent = `The ${s.version} installer is open. Quit AV Backup, drag it into Applications and replace the old copy, then reopen it.`;
        break;
      case 'none': line.textContent = `Up to date (${s.current}).`; row.append(button('Check again', api.check, 'sm ghost')); break;
      case 'error': line.textContent = s.message; row.append(button('Try again', api.check, 'sm ghost')); break;
      default: line.textContent = `Version ${s.current}`; row.append(button('Check for updates', api.check, 'sm ghost'));
    }
    box.append(line);
    if (s.phase === 'available' && s.message) {
      const m = document.createElement('div');
      m.className = 'update-err'; m.textContent = s.message;
      box.append(m);
      row.append(button('Release page', api.openPage, 'sm ghost'));
    }
    if (row.childElementCount) box.append(row);
  }

  api.onStatus(render);
  api.status().then(render).catch(() => {});
})();
