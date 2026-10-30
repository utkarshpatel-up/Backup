'use strict';

/* Event schedule -> rows in the Raw Satsang Master's layout. Pure rules shared by the renderer
 * and its Node regression tests.
 *
 * The input is what a schedule reader produced: rows of cell texts, from the
 * OCR'd poster (one cell per table cell), a Word table, a spreadsheet, or plain
 * lines with everything in one cell. Nothing here needs a network or a model:
 * dates and times are patterns, titles are matched against the house wording,
 * and anything unsure is flagged for the operator rather than guessed silently.
 */
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VIngestSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const COLUMNS = ['ID', 'Folder/DVCAM No.', 'Format', 'Session Time/No.', 'Author',
    'Satsang Type', 'Full Date', 'Duration', 'Activity', 'Place Details',
    'Topic/Description', 'No of clips', 'No of cameras',
    'Event Type (Event/Category)', 'Language Type (Language)'];

  /* ------------------------------------------------------------ dates */

  const MONTHS = [
    ['jan', 'january', 'જાન્યુઆરી', 'જાન્યુ', 'जनवरी'],
    ['feb', 'february', 'ફેબ્રુઆરી', 'ફેબ્રુ', 'फरवरी'],
    ['mar', 'march', 'માર્ચ', 'मार्च'],
    ['apr', 'april', 'એપ્રિલ', 'अप्रैल'],
    ['may', 'મે', 'मई'],
    ['jun', 'june', 'જૂન', 'જુન', 'जून'],
    ['jul', 'july', 'જુલાઈ', 'જુલાઇ', 'जुलाई'],
    ['aug', 'august', 'ઓગસ્ટ', 'ઑગસ્ટ', 'ઓગષ્ટ', 'अगस्त'],
    ['sep', 'sept', 'september', 'સપ્ટેમ્બર', 'સપ્ટે', 'सितंबर', 'सितम्बर'],
    ['oct', 'october', 'ઓક્ટોબર', 'ઑક્ટોબર', 'ઓક્ટો', 'अक्टूबर'],
    ['nov', 'november', 'નવેમ્બર', 'નવે', 'नवंबर', 'नवम्बर'],
    ['dec', 'december', 'ડિસેમ્બર', 'ડિસે', 'दिसंबर', 'दिसम्बर'],
  ];
  const MONTH_OF = new Map();
  MONTHS.forEach((names, i) => names.forEach((n) => MONTH_OF.set(n, i + 1)));
  // Longest first so "september" wins over "sep"; Latin names need a word end.
  const MON = [...MONTH_OF.keys()].sort((a, b) => b.length - a.length)
    .map((n) => (/^[a-z]+$/.test(n) ? `${n}(?![a-z])` : n)).join('|');
  // A day number, then up to three stray characters: OCR turns the superscript
  // "th" into ", %, ™, “ or !.
  const DAY = '(\\d{1,2})[^\\s\\d]{0,3}';
  const RE_CROSS = new RegExp(`${DAY}\\s*(${MON})\\s*(?:-|–|to|થી|से)\\s*${DAY}\\s*(${MON})`, 'i');
  const RE_RANGE = new RegExp(`${DAY}\\s*(?:-|–|to|થી|से)\\s*${DAY}\\s*(${MON})`, 'i');
  const RE_SINGLE = new RegExp(`${DAY}\\s*(${MON})`, 'i');
  const RE_NUMERIC = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b/;
  const RE_YEAR = /\b(20\d\d)\b/;
  const WEEKDAY = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b\.?|(સોમ|મંગળ|બુધ|ગુરુ|શુક્ર|શનિ|રવિ)વાર/gi;

  const monthNum = (s) => MONTH_OF.get(String(s).toLowerCase());
  const pad2 = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

  function validDay(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /** Every day from `a` to `b` (ISO strings), inclusive. */
  function daysBetween(a, b) {
    const out = [];
    const cur = new Date(`${a}T00:00:00Z`);
    const end = new Date(`${b}T00:00:00Z`);
    for (let n = 0; cur <= end && n < 62; n++) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  /**
   * The date(s) named in `text`: {days: [ISO...], match: substring} or null.
   * `year` is used when the text carries none.
   */
  function findDates(text, year) {
    const t = String(text || '');
    let m = RE_CROSS.exec(t);
    if (m) {
      const m1 = monthNum(m[2]), m2 = monthNum(m[4]);
      const y2 = year + (m2 < m1 ? 1 : 0);
      if (validDay(year, m1, +m[1]) && validDay(y2, m2, +m[3])) {
        return { days: daysBetween(iso(year, m1, +m[1]), iso(y2, m2, +m[3])), match: m[0] };
      }
    }
    m = RE_RANGE.exec(t);
    if (m) {
      const mo = monthNum(m[3]);
      if (+m[1] < +m[2] && validDay(year, mo, +m[1]) && validDay(year, mo, +m[2])) {
        return { days: daysBetween(iso(year, mo, +m[1]), iso(year, mo, +m[2])), match: m[0] };
      }
    }
    m = RE_SINGLE.exec(t);
    if (m && validDay(year, monthNum(m[2]), +m[1])) {
      return { days: [iso(year, monthNum(m[2]), +m[1])], match: m[0] };
    }
    m = RE_NUMERIC.exec(t);
    if (m) {   // day first, the way Indian schedules write it
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (validDay(y, +m[2], +m[1])) return { days: [iso(y, +m[2], +m[1])], match: m[0], hasYear: true };
    }
    return null;
  }

  /* ------------------------------------------------------------ times */

  const RE_TIME = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|to|થી|से)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i;
  const RE_ONE_TIME = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i;
  const MORNING = /સવાર|morning|सुबह|प्रातः/i;
  const EVENING = /સાંજ|રાત્ર|બપોર|evening|night|afternoon|शाम|रात/i;

  const isPm = (s) => /^p/i.test(s || '');
  const to24 = (h, pm) => (h % 12) + (pm ? 12 : 0);

  /** {start: 'HH:MM', end: 'HH:MM'|null, match} from text, or null. */
  function findTime(text) {
    const t = String(text || '');
    let m = RE_TIME.exec(t);
    if (m) {
      const sh = +m[1], eh = +m[4];
      if (sh > 12 || eh > 12) return null;
      const endPm = isPm(m[6]);
      // "9 - 10 PM": the start takes the end's half of the day, unless that
      // would put it after the end ("11 - 1 PM" starts in the morning).
      let startPm = m[3] ? isPm(m[3]) : endPm;
      if (!m[3] && endPm && sh !== 12 && eh !== 12 && sh > eh) startPm = false;
      return {
        start: `${pad2(to24(sh, startPm))}:${m[2] || '00'}`,
        end: `${pad2(to24(eh, endPm))}:${m[5] || '00'}`,
        match: m[0],
      };
    }
    m = RE_ONE_TIME.exec(t);
    if (m && +m[1] <= 12) {
      return { start: `${pad2(to24(+m[1], isPm(m[3])))}:${m[2] || '00'}`, end: null, match: m[0] };
    }
    return null;
  }

  /* ----------------------------------------------------- text clean-up */

  const GUJ = /[઀-૿]/;
  const DEVA = /[ऀ-ॿ]/;
  // Latin words worth keeping inside a Gujarati title; anything else Latin there
  // is OCR noise from the LIVE badge or the italic sub-line.
  const KEEP_LATIN = /^(MBA|MHT|[A-Z]MHT|GNC|NRI|YMHT|LMHT|AK|DBF|Q&A|ATPL)$/;

  function cleanTitle(line) {
    let s = String(line || '')
      .replace(/\[[^\]]*\]?/g, ' ')                       // [LIVE] and friends
      .replace(/\(([^)]*)\)?/g, (all, inner) => (GUJ.test(inner) || DEVA.test(inner) ? all : ' '))
      .replace(/\b[A-Za-z]*IVE\b\)?/gi, ' ');               // LIVE, IVE, CVE)
    if (GUJ.test(s) || DEVA.test(s)) {
      s = s.split(/\s+/).filter((w) => {
        if (!/[A-Za-z]/.test(w)) return /[\p{L}\p{N}]/u.test(w);
        return KEEP_LATIN.test(w.replace(/[^A-Za-z&]/g, ''));
      }).join(' ');
    }
    return s.replace(/\s+/g, ' ').replace(/^[\s\-–|:.,]+|[\s\-–|:.,]+$/g, '').trim();
  }

  /** A venue line without OCR debris ("ધરમપુર AISS] પાસે" -> "ધરમપુર પાસે"). Latin words stay. */
  function cleanPlace(text) {
    return String(text || '').split(/\s+/)
      .filter((w) => !/[[\]{}|]/.test(w) && /[\p{L}\p{N}]/u.test(w))
      .join(' ').replace(/^[\s,:.-]+|[\s,:.-]+$/g, '');
  }

  const letters = (s) => String(s || '').replace(/[^\p{L}]/gu, '');
  /** Letters only, lower-cased: what keys and comparisons use. */
  const norm = (s) => letters(s).toLowerCase();

  function bigrams(s) {
    const out = new Map();
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }
  /** Dice similarity of two strings' letter pairs, 0..1: tolerant of OCR slips. */
  function similarity(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const A = bigrams(x), B = bigrams(y);
    let both = 0;
    for (const [g, n] of A) both += Math.min(n, B.get(g) || 0);
    return (2 * both) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1));
  }

  /* ------------------------------------------------- reading the rows */

  const RE_PLACE_LINE = /સ્થળ|સ્યળ|સ્થલ|स्थल|स्थान|venue|place|location|address/i;
  const RE_CONTACT = /સંપર્ક|संपर्क|contact|phone|mob/i;
  const RE_BREAK = /બ્રેક|break|विश्राम|ब्रेक|no\s*satsang|holiday/i;

  /** The text after "સ્થળ :" up to the contact details. */
  function placeFromLine(text) {
    const t = String(text || '').split('\n').find((l) => RE_PLACE_LINE.test(l)) || text;
    const after = t.replace(/^.*?(સ્થળ|સ્યળ|સ્થલ|स्थल|स्थान|venue|place|location|address)\s*[:：-]?\s*/i, '');
    return after.split(/\||સંપર્ક|संपर्क|contact/i)[0].replace(/[\s,|]+$/, '').trim();
  }

  /** "Adalaj, DCC Hall" out of the poster's header line. */
  function placeFromHeader(text) {
    const line = String(text || '').split('\n').find((l) => RE_YEAR.test(l)) || '';
    const after = line.slice(line.search(RE_YEAR) + 4).replace(/^[\s,]+/, '');
    return after.replace(/indian\s*time.*$/i, '').split(/\s{2,}/)[0]
      .split(/\s+/).filter((w) => /[\p{L}]{2,}/u.test(w) && (GUJ.test(w) || /^[A-Z]/.test(w)))
      .join(' ').replace(/[,\s]+$/, '').trim();
  }

  /** A section heading's city: "વલસાડ સત્સંગ કાર્યક્રમ" -> "વલસાડ". */
  function cityFromHeading(text) {
    const first = String(text || '').split('\n')
      .find((l) => GUJ.test(l) || DEVA.test(l) || /[A-Za-z]{3}/.test(l)) || '';
    const words = cleanTitle(first).split(/\s+/).filter(Boolean);
    return words.length ? words[0] : '';
  }

  /**
   * Read schedule rows into entries. `rows` is [[cell text, ...], ...].
   * Returns {year, entries, skipped, header}. Each entry:
   * {days, start, end, title, subtitle, live, place, rowText}.
   */
  function readRows(rows, opts = {}) {
    const all = (rows || []).map((r) => (Array.isArray(r) ? r : [r]).map((c) => String(c ?? '')));
    const joined = all.map((r) => r.join('\n'));
    // The year: the first one written anywhere (the header normally).
    const ym = joined.map((t) => RE_YEAR.exec(t)).find(Boolean);
    const today = opts.today ? new Date(opts.today) : new Date();
    const year = ym ? +ym[1] : today.getFullYear();

    const entries = [];
    const skipped = [];
    let header = '';
    let headerPlace = '';
    let sectionPlace = '';
    let venue = '';

    all.forEach((cells, idx) => {
      const text = joined[idx];
      const filled = cells.filter((c) => c.trim());
      if (!filled.length) return;
      const dates = findDates(text, year);
      const time = findTime(text);
      // A heading or info line: no date in it, or a lone line that carries the
      // year — the poster header ("14 ઓક્ટોબર થી 5 નવેમ્બર 2026, Adalaj") names
      // dates but is not a session.
      if (!dates || (filled.length === 1 && !time && RE_YEAR.test(text))) {
        if (RE_PLACE_LINE.test(text)) {
          venue = cleanPlace(placeFromLine(text));
        } else if (RE_CONTACT.test(text)) {
          // "સ્થળ" misread but the contact line is under it: the venue is after the colon.
          const first = text.split('\n')[0];
          if (!RE_CONTACT.test(first) && first.includes(':')) {
            venue = cleanPlace(first.slice(first.indexOf(':') + 1));
          }
        } else if (!header && RE_YEAR.test(text)) {
          header = text;
          headerPlace = cleanPlace(placeFromHeader(text));
        } else if (!dates) {
          sectionPlace = cityFromHeading(text);
          venue = '';
        }
        return;
      }

      // Which cell holds what: the date cell, the time cell, a place cell (a
      // short cell with neither), and the title (the longest of the rest).
      let dateCell = cells.findIndex((c) => findDates(c, year));
      let timeCell = cells.findIndex((c, i) => i !== dateCell && findTime(c));
      let titleText = '';
      let rowPlace = '';
      if (filled.length === 1) {
        // Everything in one line: cut the date, weekday and time out of it.
        titleText = text.replace(dates.match, ' ').replace(time ? time.match : '', ' ').replace(WEEKDAY, ' ');
      } else {
        const rest = cells.map((c, i) => ({ c, i }))
          .filter(({ c, i }) => i !== dateCell && i !== timeCell && c.trim());
        if (dateCell < 0) dateCell = 0;
        // A cell after the title with no digits and few words is the row's place
        // ("ભાદરણ" sits in the time column for a shibir).
        rest.sort((a, b) => a.i - b.i);
        const titleIdx = rest.length ? rest[0] : null;
        titleText = titleIdx ? titleIdx.c : '';
        const tail = rest.slice(1).filter(({ c }) => !/\d/.test(c) && c.split(/\s+/).length <= 6);
        if (tail.length) rowPlace = tail.map(({ c }) => cleanPlace(c)).join(', ');
        if (timeCell < 0 && titleIdx) {
          // A time written inside the title cell.
          const inner = findTime(titleIdx.c);
          if (inner) titleText = titleIdx.c.replace(inner.match, ' ');
        }
      }
      const lines = titleText.split('\n').map(cleanTitle).filter(Boolean);
      const live = /\bL?IVE\b|\bLIVE|CVE\)/i.test(titleText);
      const title = lines[0] || '';
      const subtitle = lines.slice(1).join(' ');
      const rowText = filled.join(' | ').replace(/\n/g, ' ');

      if (RE_BREAK.test(title) || (!time && letters(title).length < 3)) {
        skipped.push({ days: dates.days, reason: 'break', rowText });
        return;
      }
      entries.push({
        days: dates.days,
        start: time ? time.start : null,
        end: time ? time.end : null,
        title,
        subtitle,
        live,
        place: rowPlace || venue || sectionPlace || headerPlace,
        rowText,
      });
    });

    // A schedule running over New Year: a month that goes backwards is the next year.
    let lastMonth = 0;
    let bump = 0;
    for (const e of entries) {
      const m = +e.days[0].slice(5, 7);
      if (lastMonth && m < lastMonth - 6) bump += 1;
      lastMonth = m;
      if (bump) e.days = e.days.map((d) => `${+d.slice(0, 4) + bump}${d.slice(4)}`);
    }
    return { year, entries, skipped, header, headerPlace };
  }

  /* ------------------------------------------------ house vocabulary */

  // Schedule wording -> master values, first match wins. `t` is tested against
  // the title and sub-line together; spellings allow for common OCR slips.
  const TITLE_RULES = [
    { t: /ખાતમુહ|ખાત\s*મુહ|ખાતમૂહ|khat\s*mu|khatmurat|ground\s*breaking|ભૂમિ\s*પૂજન|भूमिपूजन/i,
      topic: 'Ground Breaking Ceremony (Khatmurat)', events: ['Ground Breaking Ceremony'], type: 'Formal' },
    { t: /જ્ઞાન\s*વિધિ|જ્ઞાનવિધી|gn?y?aa?n\s*vidhi|ज्ञान\s*विधि/i,
      topic: 'Gnanvidhi Informal Recording', events: ['Gnanvidhi'], type: 'Informal' },
    { t: /પૂ\S*ણિમા|પુ\S*ણિમા|guru\s*purnima|गुरु\s*पूर्णिमा/i,
      topic: (e) => (/દર્શન|darshan|दर्शन/i.test(e.title) ? 'Gurupurnima Darshan' : 'Gurupurnima Celebration'),
      events: (e) => (/દર્શન|darshan|दर्शन/i.test(e.title) ? ['Gurupurnima', 'Darshan'] : ['Gurupurnima']),
      type: (e) => (/દર્શન|darshan|दर्शन/i.test(e.title) ? 'Informal' : 'Formal') },
    { t: /ગરબા|garba|गरबा/i,
      topic: (e) => (e.live ? 'Live Garba' : 'Garba, Informal Session'),
      events: (e) => (/નવરાત્ર|navratri/i.test(e.title) || ['09', '10'].includes(e.days[0].slice(5, 7))
        ? ['Navratri', 'Garba'] : ['Garba']),
      type: 'Formal' },
    { t: /શિ[બખવ][િી]ર|shibir|शिबिर/i, topic: 'General Satsang', guessTopic: true,
      events: (e) => (/હિન્દી|hindi/i.test(e.title) ? ['Hindi Shibir'] : ['Shibir']),
      activity: (e) => (/MBA/i.test(e.title)
        ? (/બહેન|behen|behn|sisters/i.test(e.title) ? 'MBA - Behno' : 'MBA - Bhaio') : null),
      type: 'Formal', allDay: true },
    { t: /પારાયણ|parayan|पारायण/i,
      topic: (e) => {
        const n = /(?:આપ્તવાણી|aptavani|आप्तवाणी)\s*[-–]?\s*(\d{1,2})/i.exec(`${e.title} ${e.subtitle}`);
        return n ? `Aptavani-${n[1]} Parayan` : 'Parayan';
      },
      events: ['Parayan'], type: 'Formal' },
    { t: /સ[ાો]?નેરી|પ્રશ્ન|soneri|q\s*&\s*a/i,
      topic: (e) => {
        const mht = /\b([A-Z])MHT\b/.exec(e.subtitle || '');
        if (mht) return `with ${mht[1]}MHT MHTs`;
        if (/અનુભવ|ટ્રીપ|ટ્રિપ|trip|experience/i.test(e.subtitle || '')) {
          return 'Experience session of Satsang Trip, General Satsang';
        }
        return 'General Satsang';
      },
      guessTopic: (e) => !/\b[A-Z]MHT\b/.test(e.subtitle || ''),
      events: ['Soneri Satsang'], type: 'Formal' },
    { t: /આપ્તપુત્ર|aptaputra/i, topic: "Pujyashree's Informal Satsang with Aptaputra",
      events: ['General'], type: 'Informal', guessActivity: true },
    { t: /જન્મ\s*જયંતી|જન્મજયંતી|janma\s*jayanti/i, topic: 'Janma Jayanti Celebration',
      events: ['Janma Jayanti'], type: 'Formal' },
    { t: /પ્રાણ\s*પ્રતિષ્ઠા|pran\s*pratishtha/i, topic: 'Pranpratishtha',
      events: ['Pranpratishtha'], type: 'Formal' },
    { t: /ભક્તિ|bhakti/i, topic: 'Bhakti', events: ['Bhakti'], type: 'Informal' },
    { t: /દર્શન|darshan|दर्शन/i, topic: 'Darshan', events: ['Darshan'], type: 'Informal' },
    { t: /સત્સંગ|સત્સગ|satsang|सत्संग/i, topic: 'General Satsang', events: ['General'], type: 'Formal' },
  ];

  // Venue wording -> master place, with the language the session is usually in.
  const PLACE_RULES = [
    { t: /[ભમ]ાદરણ|bhadran/i, place: 'Trimandir, Bhadran' },
    { t: /dcc\s*hall|દાદાનગર|dada\s*nagar|dadanagar/i, place: 'Dadanagar Hall' },
    { t: /રુદ્રાક્ષ|rudraksh/i, place: 'Rudraksh International Cooperation and Convention Centre', languages: ['Hindi'] },
    { t: /વાત્સલ્ય|vatsalya/i, place: 'Vatsalya' },
    { t: /સીમંધર\s*સિટી|simandhar\s*city/i, place: 'Simandhar City' },
    { t: /અડાલજ|adalaj/i, place: 'Dadanagar Hall' },
    { t: /વારાણસી|varanasi|banaras/i, place: 'Varanasi', guess: true, languages: ['Hindi'] },
  ];

  const pick = (v, e) => (typeof v === 'function' ? v(e) : v);

  /** Best remembered value for `text` among `list` [{key, ...}], or null. */
  function recall(list, text, min = 0.8) {
    let best = null;
    let score = min;
    for (const item of list || []) {
      const s = similarity(item.key, text);
      if (s >= score) { best = item; score = s; }
    }
    return best;
  }

  /**
   * The master fields for one entry: {topic, events, type, activity, place,
   * languages, flags}. `flags` names each field the operator should check and why.
   * `memory` holds what the operator corrected before ({titles, places}).
   */
  function classify(entry, memory = {}) {
    const flags = {};
    const out = { topic: '', events: ['General'], type: 'Formal', activity: 'General',
      place: '', languages: ['Gujarati'], allDay: false, flags };
    const text = `${entry.title} ${entry.subtitle}`;
    const rule = TITLE_RULES.find((r) => r.t.test(text));
    if (rule) {
      out.topic = pick(rule.topic, entry);
      out.events = pick(rule.events, entry).slice();
      out.type = pick(rule.type, entry);
      out.activity = pick(rule.activity, entry) || 'General';
      out.allDay = !!rule.allDay;
      if (pick(rule.guessTopic, entry)) flags.topic = 'Check the topic — the schedule does not say it.';
      if (rule.guessActivity) flags.activity = 'Check the activity.';
    } else {
      out.topic = entry.title;
      flags.topic = 'Unrecognised title — write it in English.';
      flags.events = 'Pick the event type.';
    }

    const remembered = recall(memory.titles, entry.title);
    if (remembered) {
      for (const f of ['topic', 'events', 'type', 'activity', 'languages']) {
        if (remembered[f] == null) continue;
        out[f] = Array.isArray(remembered[f]) ? remembered[f].slice() : remembered[f];
        flags[f] = 'Filled in from last time — check it.';
      }
    }

    const placeText = entry.place || '';
    const place = recall(memory.places, placeText);
    const prule = PLACE_RULES.find((r) => r.t.test(placeText));
    if (place) {
      out.place = place.place;
      if (place.languages && !(remembered && remembered.languages)) out.languages = place.languages.slice();
    } else if (prule) {
      out.place = prule.place;
      if (prule.guess) flags.place = 'Only the city is known — add the venue.';
      if (prule.languages && !(remembered && remembered.languages)) out.languages = prule.languages.slice();
    } else {
      out.place = placeText;
      if (placeText) flags.place = 'Write the place in English.';
      else flags.place = 'The schedule does not name a place.';
    }
    return out;
  }

  /* ------------------------------------------------------ sessions */

  let nextKey = 1;

  /**
   * Draft master sessions from read entries: one per day per programme; a
   * multi-day shibir with no time gets a morning and an evening session a day.
   */
  function draftSessions(read, memory = {}, defaults = {}) {
    const sessions = [];
    for (const entry of read.entries) {
      const c = classify(entry, memory);
      const slots = entry.start ? [{ start: entry.start, end: entry.end, hint: null }]
        : c.allDay ? [{ start: null, end: null, hint: 'M' }, { start: null, end: null, hint: 'E' }]
          : [{ start: null, end: null, hint: null }];
      for (const day of entry.days) {
        for (const slot of slots) {
          const flags = { ...c.flags };
          if (!entry.start) flags.session = c.allDay
            ? 'The schedule gives no times — add or remove sessions to match the day.'
            : 'No time on the schedule — check M/E.';
          sessions.push({
            key: nextKey++,
            include: true,
            date: day,
            start: slot.start,
            end: slot.end,
            hint: slot.hint,
            type: c.type,
            activity: c.activity,
            place: c.place,
            topic: c.topic,
            events: c.events.slice(),
            languages: c.languages.slice(),
            author: defaults.author || 'DD',
            format: defaults.format || 'HD',
            duration: '',
            clips: '',
            cameras: '',
            folder: null,          // null = numbered automatically
            session: null,         // null = numbered automatically
            title: entry.title,
            subtitle: entry.subtitle,
            placeText: entry.place,
            source: entry.rowText,
            flags,
          });
        }
      }
    }
    return sessions;
  }

  /** Morning or evening from a 'HH:MM' start (or the shibir hint). */
  function half(s) {
    if (s.start) return +s.start.slice(0, 2) < 12 ? 'M' : 'E';
    return s.hint || 'E';
  }
  const HALF_RANK = { M: 0, E: 1 };

  /** Sort key of a session label within its folder: M < M1 < M2 < E < E1 …; 1 < 2 < 10. */
  function sessionRank(label) {
    const m = /^([ME])-?(\d*)$/i.exec(String(label || ''));
    if (m) return HALF_RANK[m[1].toUpperCase()] * 1000 + (+m[2] || 0);
    return Number(label) || 0;
  }

  /**
   * Folder and session numbers for every included session. Formal and Informal
   * keep separate folder series; each day takes the next folder in its series.
   * Formal sessions are M / E (M1, M2 … when a half has several); Informal are
   * 1, 2, 3 by time. A number the operator typed is kept as typed.
   * Returns a Map key -> {folder, session}.
   */
  function assignNumbers(sessions, starts = {}) {
    const out = new Map();
    const order = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || HALF_RANK[half(a)] - HALF_RANK[half(b)]
      || String(a.start || '').localeCompare(String(b.start || ''))
      || a.key - b.key;
    for (const type of ['Formal', 'Informal']) {
      const list = sessions.filter((s) => s.include && s.type === type).sort(order);
      const start = Number(type === 'Formal' ? starts.formal : starts.informal);
      const days = [...new Set(list.map((s) => s.date))];
      const folderOf = new Map(days.map((d, i) => [d, Number.isFinite(start) && start > 0 ? start + i : null]));
      for (const day of days) {
        const group = list.filter((s) => s.date === day);
        const folder = (s) => (s.folder != null && s.folder !== '' ? Number(s.folder) : folderOf.get(day));
        if (type === 'Informal') {
          group.forEach((s, i) => out.set(s.key, { folder: folder(s), session: s.session || String(i + 1) }));
          continue;
        }
        for (const h of ['M', 'E']) {
          const g = group.filter((s) => half(s) === h);
          g.forEach((s, i) => out.set(s.key, {
            folder: folder(s),
            session: s.session || (g.length > 1 ? `${h}${i + 1}` : h),
          }));
        }
      }
    }
    return out;
  }

  /** The Raw Video Id: DD-F-HD-3057-E2. */
  function masterId(s, folder, session) {
    const author = String(s.author || '').split(',')[0].trim();
    const f = folder == null || folder === '' ? '????' : String(folder).padStart(4, '0');
    return `${author}-${String(s.type || '').charAt(0)}-${s.format}-${f}-${session}`;
  }

  /**
   * Sheet rows for the included sessions, newest first like the master. A
   * second event type or language goes on its own row underneath with every
   * other cell blank — the master's convention. Dates are ISO strings here.
   */
  function sheetRows(sessions, starts = {}) {
    const nums = assignNumbers(sessions, starts);
    const included = sessions.filter((s) => s.include && nums.has(s.key));
    const rank = (s) => {
      const n = nums.get(s.key);
      return [s.date, n.folder || 0, sessionRank(n.session)];
    };
    included.sort((a, b) => {
      const x = rank(a), y = rank(b);
      return x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : (y[1] - x[1]) || (y[2] - x[2]);
    });
    const rows = [];
    for (const s of included) {
      const { folder, session } = nums.get(s.key);
      const events = (s.events || []).filter(Boolean);
      const langs = (s.languages || []).filter(Boolean);
      rows.push([masterId(s, folder, session), folder, s.format, session, s.author, s.type,
        s.date, s.duration || '', s.activity, s.place, s.topic,
        s.clips === '' || s.clips == null ? '' : Number(s.clips),
        s.cameras === '' || s.cameras == null ? '' : Number(s.cameras),
        events[0] || '', langs[0] || '']);
      for (let i = 1; i < Math.max(events.length, langs.length); i++) {
        const extra = new Array(COLUMNS.length).fill('');
        extra[13] = events[i] || '';
        extra[14] = langs[i] || '';
        rows.push(extra);
      }
    }
    return rows;
  }

  /* --------------------------------------------------- drive results */

  /** '1h 2m 3s' / '2m 3s' / '3s' — the master's duration format. */
  function fmtDuration(sec) {
    if (sec == null || !(sec >= 0)) return '';
    let s = Math.floor(sec);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /**
   * Fill duration, clips and cameras from scanned session folders
   * ([{project, tag, number, seconds, clips, cams, folder}]). A session matches
   * its folder number plus its M/E tag (Formal) or session number (Informal);
   * a folder holding just one session matches the one row numbered into it.
   * Returns {filled, missing: [sessions with no folder on the drive], extra}.
   */
  function applyScan(sessions, starts, scanned) {
    const nums = assignNumbers(sessions, starts);
    const byProject = new Map();
    for (const s of scanned || []) {
      if (!byProject.has(String(s.project))) byProject.set(String(s.project), []);
      byProject.get(String(s.project)).push(s);
    }
    const used = new Set();
    let filled = 0;
    const missing = [];
    const rowsPerFolder = new Map();
    for (const s of sessions) {
      const n = nums.get(s.key);
      if (n && n.folder != null) rowsPerFolder.set(String(n.folder), (rowsPerFolder.get(String(n.folder)) || 0) + 1);
    }
    for (const s of sessions) {
      const n = nums.get(s.key);
      if (!n || n.folder == null) continue;
      const found = byProject.get(String(n.folder)) || [];
      let hit = found.find((f) => (s.type === 'Formal'
        ? String(f.tag || '').toUpperCase() === String(n.session).toUpperCase()
        : String(f.number) === String(n.session)));
      if (!hit && found.length === 1 && rowsPerFolder.get(String(n.folder)) === 1) [hit] = found;
      if (!hit) { missing.push(s); continue; }
      used.add(hit);
      s.duration = fmtDuration(hit.seconds);
      s.clips = hit.clips;
      s.cameras = hit.cams;
      delete s.flags.duration;
      filled += 1;
    }
    const extra = (scanned || []).filter((f) => !used.has(f)
      && [...nums.values()].some((n) => String(n.folder) === String(f.project)));
    return { filled, missing, extra };
  }

  /* ------------------------------------------------------ memory */

  /**
   * Remember what the operator corrected: for each session whose fields differ
   * from what the rules gave, store them against its schedule title and place.
   * Returns the updated memory (it is small: the newest 300 of each).
   */
  function learn(memory, sessions) {
    const mem = { titles: [...((memory && memory.titles) || [])], places: [...((memory && memory.places) || [])] };
    for (const s of sessions) {
      if (!s.include || !s.title) continue;
      const auto = classify({ title: s.title, subtitle: s.subtitle || '', place: s.placeText || '',
        days: [s.date], live: false }, {});
      const changed = {};
      for (const f of ['topic', 'type', 'activity']) if (s[f] !== auto[f]) changed[f] = s[f];
      for (const f of ['events', 'languages']) {
        if ((s[f] || []).join('|') !== (auto[f] || []).join('|')) changed[f] = (s[f] || []).slice();
      }
      if (Object.keys(changed).length) {
        const i = mem.titles.findIndex((t) => similarity(t.key, s.title) >= 0.92);
        const item = { ...(i >= 0 ? mem.titles[i] : {}), key: s.title, ...changed };
        if (i >= 0) mem.titles.splice(i, 1);
        mem.titles.unshift(item);
      }
      if (s.placeText && s.place && s.place !== auto.place) {
        const i = mem.places.findIndex((p) => similarity(p.key, s.placeText) >= 0.92);
        if (i >= 0) mem.places.splice(i, 1);
        mem.places.unshift({ key: s.placeText, place: s.place, languages: (s.languages || []).slice() });
      }
    }
    mem.titles = mem.titles.slice(0, 300);
    mem.places = mem.places.slice(0, 300);
    return mem;
  }

  return { COLUMNS, findDates, findTime, cleanTitle, similarity, readRows, classify,
           draftSessions, assignNumbers, masterId, sheetRows, fmtDuration, applyScan,
           learn, TITLE_RULES, PLACE_RULES };
});
