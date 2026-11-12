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
    'Event Type (Event/Category)', 'Language Type (Language)', 'Geolocation'];

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
  const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

  function validDay(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /** '2026-10-17' -> '17/10/2026', the Indian way the page shows dates. */
  function toIndian(date) {
    const m = RE_ISO.exec(String(date || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(date || '');
  }

  /** '17/10/2026' (or 17-10-26, 17.10.2026, or ISO) -> '2026-10-17'; null if not a real day. */
  function fromIndian(text) {
    const t = String(text || '').trim();
    let m = RE_ISO.exec(t);
    if (m) return validDay(+m[1], +m[2], +m[3]) ? t : null;
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(t);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validDay(y, +m[2], +m[1]) ? iso(y, +m[2], +m[1]) : null;
  }

  /** The day before an ISO date. */
  function dayBefore(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
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

  // Gujarati or Hindi letters, not their digits: OCR leaves a stray "(૦)" beside
  // the LIVE badge even on an English poster.
  const nativeLetters = (s) => (String(s).match(/[\u0A80-\u0AE5\u0AF0-\u0AFF\u0900-\u0965\u0970-\u097F]/g) || []).length;
  const latinLetters = (s) => (String(s).match(/[A-Za-z]/g) || []).length;

  function cleanTitle(line) {
    let s = String(line || '')
      .replace(/\[[^\]]*\]?/g, ' ')                       // [LIVE] and friends
      .replace(/\(([^)]*)\)?/g, (all, inner) => (nativeLetters(inner) >= 2 ? all : ' '))
      .replace(/\b[A-Za-z]*IVE\b\)?/gi, ' ');               // LIVE, IVE, CVE)
    // A Gujarati or Hindi title; on a mostly English one the few other letters are the noise.
    if (nativeLetters(s) && nativeLetters(s) >= latinLetters(s)) {
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

  /** "Adalaj, DCC Hall" out of the poster's header line, after its year or, with none, its dates. */
  function placeFromHeader(text) {
    const lines = String(text || '').split('\n');
    const dated = lines.find((l) => RE_YEAR.test(l));
    const line = dated || lines.find((l) => findDates(l, 2000)) || '';
    const from = dated ? line.search(RE_YEAR) + 4
      : (() => { const m = findDates(line, 2000); return m ? line.indexOf(m.match) + m.match.length : line.length; })();
    const after = line.slice(from).replace(/^[\s,]+/, '');
    const words = after.replace(/indian\s*time.*$/i, '').split(/\s{2,}/)[0]
      .split(/\s+/).filter((w) => /[\p{L}]{2,}/u.test(w) && (GUJ.test(w) || /^[A-Z]/.test(w)));
    // OCR of the small "Indian Time" at the line's end leaves a scrap like "PE".
    while (words.length > 1 && /^[A-Z]{1,2}$/.test(words[words.length - 1])) words.pop();
    return words.join(' ').replace(/[,\s]+$/, '').trim();
  }

  // Words in a poster heading that are never its city ("Satsang Details").
  const RE_NOT_CITY = /^(satsang|schedule|program|programme|details|venue|shibir|pujya)$/i;

  /** A city written in English, from a heading's first word or a header's first part; else ''. */
  function englishCity(text) {
    const first = String(text || '').split(',')[0].trim();
    return /^[A-Z][A-Za-z .'-]{1,30}$/.test(first) && !RE_NOT_CITY.test(first) ? first : '';
  }

  // The poster's title line, for a header that has dates but no year.
  const RE_HEADER = /schedule|programme|કાર્યક્રમ|કાયક્રમ|કાયંક્રમ|कार्यक्रम/i;

  /** A section heading's city: "વલસાડ સત્સંગ કાર્યક્રમ" -> "વલસાડ". */
  function cityFromHeading(text) {
    const first = String(text || '').split('\n')
      .find((l) => GUJ.test(l) || DEVA.test(l) || /[A-Za-z]{3}/.test(l)) || '';
    const words = cleanTitle(first).split(/\s+/).filter(Boolean);
    return words.length && !RE_NOT_CITY.test(words[0]) ? words[0] : '';
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
    let lastRow = null;        // the session the row just before this one produced

    /** A venue line belongs to the session right above it, else to the sessions after it. */
    const setVenue = (place) => {
      if (lastRow && !lastRow.ownPlace) {
        lastRow.place = place;
        lastRow.city = '';
      } else {
        venue = place;
      }
    };

    all.forEach((cells, idx) => {
      const text = joined[idx];
      const filled = cells.filter((c) => c.trim());
      if (!filled.length) return;
      const dates = findDates(text, year);
      const time = findTime(text);
      // A heading or info line: no date in it, or a lone line that carries the
      // year — the poster header ("14 ઓક્ટોબર થી 5 નવેમ્બર 2026, Adalaj") names
      // dates but is not a session. So is a first line with a date range and the
      // poster's title or a place ("6 to 26 November, Adalaj, DCC Hall").
      const isHeader = filled.length === 1 && !time && (RE_YEAR.test(text)
        || (!header && !entries.length && !skipped.length && dates && dates.days.length > 1
          && (RE_HEADER.test(text) || text.slice(text.indexOf(dates.match) + dates.match.length).includes(','))));
      if (!dates || isHeader) {
        if (RE_PLACE_LINE.test(text)) {
          setVenue(cleanPlace(placeFromLine(text)));
        } else if (RE_CONTACT.test(text)) {
          // "સ્થળ" misread but the contact line is under it: the venue is after the colon.
          const first = text.split('\n')[0];
          if (!RE_CONTACT.test(first) && first.includes(':')) {
            setVenue(cleanPlace(first.slice(first.indexOf(':') + 1)));
          }
        } else if (!header && (isHeader || RE_YEAR.test(text))) {
          header = text;
          headerPlace = cleanPlace(placeFromHeader(text));
        } else if (!dates && filled.length === 1) {
          // A section heading is a line of its own; several cells with no date
          // is a row whose date was misread ('gt" Nov, Mon | Break').
          sectionPlace = cityFromHeading(text);
          venue = '';
        }
        lastRow = null;
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
        lastRow = null;
        return;
      }
      lastRow = {
        days: dates.days,
        start: time ? time.start : null,
        end: time ? time.end : null,
        title,
        subtitle,
        live,
        place: rowPlace || venue || sectionPlace || headerPlace,
        // A place that doesn't say its city: the section's, or the header's first part.
        city: rowPlace ? '' : englishCity(sectionPlace) || (venue ? '' : englishCity(headerPlace)),
        ownPlace: !!rowPlace,
        rowText,
      };
      entries.push(lastRow);
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

  function parayanTopic(e) {
    const n = /(?:આપ્તવાણી|aptavani|आप्तवाणी)\s*[-–]?\s*(\d{1,2})/i.exec(`${e.title} ${e.subtitle}`);
    return n ? `Aptavani-${n[1]} Parayan` : 'Parayan';
  }

  // Schedule wording -> master values, first match wins. `t` is tested against
  // the title and sub-line together; spellings allow for common OCR slips.
  const TITLE_RULES = [
    // From the master: a Bhakti on an occasion is the Formal evening session, and
    // New Year is a Formal celebration plus, with Darshan, an Informal darshan.
    { t: /(?=.*(?:ભક્તિ|bhakti|भक्ति))(?=.*(?:દિવાળી|diwali|दिवाली|જન્મ\s*જયંતી|જન્મજયંતી|janma\s*jayanti|પૂ\S*ણિમા|પુ\S*ણિમા|guru\s*purnima|પ્રાણ\s*પ્રતિષ્ઠા|pran\s*pratishtha|પુણ્યતિથિ|punyatithi|શિ[બખવ][િી]ર|shibir))/i,
      topic: 'Bhakti', events: ['Bhakti'], type: 'Formal' },
    { t: /નૂતન\s*વર્ષ|નવું\s*વર્ષ|બેસતું\s*વર્ષ|new\s*year|नव\s*वर्ष/i, topic: 'New Year Celebration', events: ['New Year'], type: 'Formal',
      parts: (e) => (/દર્શન|darshan|दर्शन/i.test(e.title)
        ? [{ type: 'Formal', hint: 'M', topic: 'New Year Celebration', events: ['New Year'] },
          { type: 'Informal', topic: 'New Year Darshan', events: ['New Year', 'Darshan'] }]
        : null) },
    { t: /દિવાળી|diwali|दिवाली/i, topic: 'Diwali Informal Recording', events: ['Diwali'], type: 'Informal' },
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
    { t: /શિ[બખવ][િી]ર|shibir|शिबिर/i,
      topic: (e) => (/ડ્રામા|નાટક|drama/i.test(e.title) ? 'Drama' : /દર્શન|darshan/i.test(e.title) ? 'Darshan'
        : /પારાયણ|parayan/i.test(e.title) ? parayanTopic(e) : 'General Satsang'),
      guessTopic: (e) => !/ડ્રામા|નાટક|drama|દર્શન|darshan|પારાયણ|parayan/i.test(e.title),
      events: (e) => (/હિન્દી|hindi/i.test(e.title) ? ['Hindi Shibir'] : ['Shibir']),
      activity: (e) => (/MBA/i.test(e.title)
        ? (/બહેન|behen|behn|sisters/i.test(e.title) ? 'MBA - Behno' : 'MBA - Bhaio') : null),
      type: 'Formal', allDay: true },
    { t: /પારાયણ|parayan|पारायण/i,
      topic: (e) => parayanTopic(e),
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

  // Every event a title names, in the master's usual order: the occasion first,
  // then what happened at it ("Diwali,Bhakti", "Shibir,Parayan", "Soneri Satsang,Parayan").
  const EVENT_WORDS = [
    [/દિવાળી|diwali|दिवाली/i, 'Diwali'],
    [/નૂતન\s*વર્ષ|નવું\s*વર્ષ|બેસતું\s*વર્ષ|new\s*year|नव\s*वर्ष/i, 'New Year'],
    [/જન્મ\s*જયંતી|જન્મજયંતી|janma\s*jayanti/i, 'Janma Jayanti'],
    [/પૂ\S*ણિમા|પુ\S*ણિમા|guru\s*purnima|गुरु\s*पूर्णिमा/i, 'Gurupurnima'],
    [/પ્રાણ\s*પ્રતિષ્ઠા|pran\s*pratishtha/i, 'Pranpratishtha'],
    [/પુણ્યતિથિ|punyatithi/i, 'Niruma Punyatithi'],
    [/નવરાત્ર|navratri/i, 'Navratri'],
    [/શિ[બખવ][િી]ર|shibir|शिबिर/i, 'Shibir'],
    [/સ[ાો]?નેરી\s*સત્સ|soneri\s*satsang/i, 'Soneri Satsang'],
    [/પારાયણ|parayan|पारायण/i, 'Parayan'],
    [/ભક્તિ|bhakti|भक्ति/i, 'Bhakti'],
    [/દર્શન|darshan|दर्शन/i, 'Darshan'],
    [/ગરબા|garba|गरबा/i, 'Garba'],
    [/ડ્રામા|નાટક|\bdrama\b/i, 'Drama'],
    [/દાદા\s*દરબાર|dada\s*darbar/i, 'Dada Darbar'],
    [/સેવાર્થી\s*સત્સંગ|sevarthi\s*satsang/i, 'Sevarthi Satsang'],
    [/જ્ઞાન\s*વિધિ|જ્ઞાનવિધી|gn?y?aa?n\s*vidhi|ज्ञान\s*विधि/i, 'Gnanvidhi'],
  ];
  const EVENT_ORDER = EVENT_WORDS.map(([, name]) => name);

  /** A rule's events plus any others the title names; 'General' only when nothing else fits. */
  function eventsFor(ruleEvents, title) {
    const all = new Set(ruleEvents);
    for (const [re, name] of EVENT_WORDS) if (re.test(title)) all.add(name);
    if (all.has('Hindi Shibir')) all.delete('Shibir');
    if (all.size > 1) all.delete('General');
    const rank = (e) => { const i = EVENT_ORDER.indexOf(e); return i < 0 ? -1 : i; };
    return [...all].sort((a, b) => rank(a) - rank(b));
  }

  // Venue wording -> master place, with the language the session is usually in
  // and the city that starts the session folder's name ("Adalaj Soneri …").
  const PLACE_RULES = [
    { t: /[ભમ]ાદરણ|bhadran/i, place: 'Trimandir, Bhadran', city: 'Bhadran' },
    { t: /dcc\s*hall|દાદાનગર|dada\s*nagar|dadanagar/i, place: 'Dadanagar Hall', city: 'Adalaj' },
    { t: /રુદ્રાક્ષ|rudraksh/i, place: 'Rudraksh International Cooperation and Convention Centre',
      city: 'Varanasi', languages: ['Hindi'] },
    { t: /વાત્સલ્ય|vatsalya/i, place: 'Vatsalya' },
    { t: /સીમંધર\s*સિટી|simandhar\s*city/i, place: 'Simandhar City', city: 'Adalaj' },
    { t: /અડાલજ|adalaj/i, place: 'Dadanagar Hall', city: 'Adalaj' },
    { t: /વારાણસી|varanasi|banaras/i, place: 'Varanasi', city: 'Varanasi', guess: true, languages: ['Hindi'] },
  ];

  // Trailing parts of an address that are not its city.
  const RE_NOT_ADDRESS_CITY = /^(india|usa|us|uk|canada|australia|andhra pradesh|assam|bihar|chhattisgarh|delhi|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|odisha|punjab|rajasthan|tamil nadu|telangana|uttar pradesh|uttarakhand|west bengal|\d[\d\s-]*)$/i;

  /** A city read off an English place ("Hotel Venue, Allentown" or "…, Anand, Gujarat" -> the city); '' if unsure. */
  function cityInPlace(place) {
    const parts = String(place || '').split(',').map((x) => x.trim()).filter(Boolean);
    while (parts.length > 1 && RE_NOT_ADDRESS_CITY.test(parts[parts.length - 1])) parts.pop();
    const last = parts.length ? parts[parts.length - 1] : '';
    return /^[A-Za-z][A-Za-z .'-]{1,30}$/.test(last) ? last : '';
  }

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
      place: '', city: '', languages: ['Gujarati'], allDay: false, flags };
    const text = `${entry.title} ${entry.subtitle}`;
    const rule = TITLE_RULES.find((r) => r.t.test(text));
    if (rule) {
      out.topic = pick(rule.topic, entry);
      out.events = eventsFor(pick(rule.events, entry), entry.title || '');
      out.parts = pick(rule.parts, entry) || null;
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
      out.city = place.city || '';
      if (place.languages && !(remembered && remembered.languages)) out.languages = place.languages.slice();
    } else if (prule) {
      out.place = prule.place;
      out.city = prule.city || '';
      if (prule.guess) flags.place = 'Only the city is known — add the venue.';
      if (prule.languages && !(remembered && remembered.languages)) out.languages = prule.languages.slice();
    } else {
      out.place = placeText;
      if (nativeLetters(placeText)) flags.place = 'Write the place in English.';
      else if (!placeText) flags.place = 'The schedule does not name a place.';
    }
    if (!out.city) out.city = (prule && prule.city) || entry.city || cityInPlace(out.place);
    if (!out.city) flags.city = 'Which city? It starts the session folder name.';
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
      // One poster row can be several sessions (New Year & Darshan).
      const pieces = c.parts || [{}];
      const slots = entry.start ? [{ start: entry.start, end: entry.end, hint: null }]
        : c.allDay ? [{ start: null, end: null, hint: 'M' }, { start: null, end: null, hint: 'E' }]
          : [{ start: null, end: null, hint: null }];
      for (const day of entry.days) {
        for (const slot of slots) for (const piece of pieces) {
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
            hint: piece.hint || slot.hint,
            type: piece.type || c.type,
            activity: c.activity,
            place: c.place,
            city: c.city,
            topic: piece.topic || c.topic,
            events: (piece.events || c.events).slice(),
            languages: c.languages.slice(),
            author: defaults.author || 'DD',
            format: defaults.format || 'HD',
            duration: '',
            clips: '',
            cameras: '',
            folder: null,          // null = numbered automatically
            session: null,         // null = numbered automatically
            camPlan: null,         // camera folders to create; null = the default for its type
            backedUp: null,        // when a backup started from this row finished
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

  // A session starting before this hour belongs to the night before: it is that
  // day's evening, filed in that day's folder ("till next day morning").
  const NIGHT_ENDS = 5;
  const afterMidnight = (s) => !!s.start && +s.start.slice(0, 2) < NIGHT_ENDS;

  /** Morning (before noon) or evening (noon until next morning) from a 'HH:MM' start, or the shibir hint. */
  function half(s) {
    if (s.start) return +s.start.slice(0, 2) < 12 && !afterMidnight(s) ? 'M' : 'E';
    return s.hint || 'E';
  }
  const HALF_RANK = { M: 0, E: 1 };

  /** The day a session is filed under: its date, or the day before for an after-midnight start. */
  function sessionDay(s) {
    return afterMidnight(s) && RE_ISO.test(s.date || '') ? dayBefore(s.date) : s.date;
  }
  /** Start time for ordering within a day; after midnight sorts after the evening. */
  const clock = (s) => (s.start ? (afterMidnight(s) ? `${+s.start.slice(0, 2) + 24}${s.start.slice(2)}` : s.start) : '');

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
   * 1, 2, 3 by time, then by their order on the page. A number the operator typed
   * is kept as typed, and the numbers around it move: the next day follows on
   * from a typed folder, and no automatic number repeats a typed one.
   * Returns a Map key -> {folder, session}.
   */
  function assignNumbers(sessions, starts = {}) {
    const out = new Map();
    const position = new Map(sessions.map((s, i) => [s.key, i]));
    const typedFolder = (s) => (s.folder != null && s.folder !== '' ? Number(s.folder) : null);
    const order = (a, b) => {
      const x = sessionDay(a), y = sessionDay(b);
      return (x < y ? -1 : x > y ? 1 : 0)
        || HALF_RANK[half(a)] - HALF_RANK[half(b)]
        || clock(a).localeCompare(clock(b))
        || position.get(a.key) - position.get(b.key);
    };
    // Sequence labels for rows of one group: a typed label holds its number and
    // the rest take the free ones. `label(n)` writes number n; bare M or E is 1.
    const labelGroup = (group, folderOf, label, numberOf) => {
      const used = new Set(group.filter((s) => s.session).map((s) => numberOf(s.session)));
      let n = 0;
      for (const s of group) {
        let text = s.session;
        if (!text) {
          do { n += 1; } while (used.has(n));
          text = label(n, group.length);
        }
        out.set(s.key, { folder: folderOf(s), session: text });
      }
    };
    for (const type of ['Formal', 'Informal']) {
      const list = sessions.filter((s) => s.include && s.type === type).sort(order);
      const start = Number(type === 'Formal' ? starts.formal : starts.informal);
      const days = [...new Set(list.map(sessionDay))];
      const taken = new Set(list.map(typedFolder).filter((v) => v != null));
      let next = Number.isFinite(start) && start > 0 ? start : null;
      for (const day of days) {
        const group = list.filter((s) => sessionDay(s) === day);
        const typedHere = group.map(typedFolder).filter((v) => v != null);
        // A row whose folder is already on the drive fixes the day's folder.
        const anchor = group.find((s) => typedFolder(s) != null && (s.backedUp || s.startedAt));
        let dayFolder = anchor ? typedFolder(anchor) : null;
        if (dayFolder == null && next != null && group.some((s) => typedFolder(s) == null)) {
          while (taken.has(next) && !typedHere.includes(next)) next += 1;
          dayFolder = next;
          next += 1;
        }
        for (const v of typedHere) if (next == null || v >= next) next = v + 1;
        const folder = (s) => typedFolder(s) ?? dayFolder;
        // Sessions are numbered inside their folder: one given a folder of its own starts over.
        for (const f of new Set(group.map(folder))) {
          const inFolder = group.filter((s) => folder(s) === f);
          if (type === 'Informal') {
            labelGroup(inFolder, folder, (n) => String(n), Number);
            continue;
          }
          // A typed M or E decides the row's half, whatever its start time.
          const halfOf = (s) => { const m = /^([ME])/i.exec(String(s.session || '')); return m ? m[1].toUpperCase() : half(s); };
          for (const h of ['M', 'E']) {
            labelGroup(inFolder.filter((s) => halfOf(s) === h), folder,
              (n, count) => (count > 1 ? `${h}${n}` : h),
              (text) => { const m = /^[ME]-?(\d*)$/i.exec(String(text)); return m ? +m[1] || 1 : NaN; });
          }
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

  /* ------------------------------------------------ session folders */

  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
  const safeName = (t) => String(t).replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim().replace(/[ .]+$/, '');
  const DEFAULT_CAMS = { Formal: 3, Informal: 1 };

  /** Camera folders a backup started from this row creates. */
  function camsFor(s, defaults = {}) {
    if (s.camPlan !== null && s.camPlan !== undefined && s.camPlan !== '') return Number(s.camPlan);
    const d = s.type === 'Informal' ? defaults.camsInformal : defaults.camsFormal;
    return d !== undefined && d !== '' && d !== null ? Number(d) : DEFAULT_CAMS[s.type] ?? 3;
  }

  /** '3058 Dt-17 Oct 2026', the job folder (one per folder number, one day each). */
  function jobFolderName(folder, date) {
    const [y, m, d] = String(date).split('-');
    return `${String(folder).padStart(4, '0')} Dt-${d} ${MON3[+m - 1]} ${y}`;
  }

  /**
   * The session folder a structure zip would carry for this row:
   * Formal   'NN City Activity Event Topic E2. Dt-17-Oct-26'
   * Informal 'NN City Topic Dt-17-Oct-26'
   * Activity and event are left out when 'General' or already in the topic. NN
   * numbers the session within its folder and is left off when the folder has
   * one session (a lone informal session is then session 1, as the drive scan reads it).
   */
  function sessionFolderName(s, session, lead) {
    const has = (big, small) => !!norm(small) && norm(big).includes(norm(small));
    const topic = String(s.topic || '').trim();
    const parts = [];
    if (s.city && !norm(topic).startsWith(norm(s.city))) parts.push(s.city);
    if (s.type === 'Formal') {
      if (s.activity && s.activity !== 'General' && !has(topic, s.activity)) parts.push(s.activity);
      const ev = (s.events || [])[0];
      if (ev && ev !== 'General' && !has(topic, ev)) parts.push(ev);
      if (topic) parts.push(topic);
      parts.push(`${session}.`);
    } else {
      parts.push(topic || (s.events || [])[0] || 'Informal');
    }
    const [y, m, d] = String(sessionDay(s)).split('-');
    const prefix = lead ? `${pad2(lead)} ` : '';
    return safeName(`${prefix}${parts.join(' ')} Dt-${d}-${MON3[+m - 1]}-${y.slice(2)}`);
  }

  /**
   * Everything a backup started from each included row needs: Map key ->
   * {id, type, folder, session, jobName, sessionName, cams}.
   */
  function folderPlan(sessions, starts = {}, defaults = {}) {
    const nums = assignNumbers(sessions, starts);
    const byFolder = new Map();
    for (const s of sessions) {
      const n = nums.get(s.key);
      if (!s.include || !n || n.folder == null) continue;
      const k = `${s.type}|${n.folder}`;
      if (!byFolder.has(k)) byFolder.set(k, []);
      byFolder.get(k).push(s);
    }
    const out = new Map();
    for (const group of byFolder.values()) {
      group.sort((a, b) => sessionRank(nums.get(a.key).session) - sessionRank(nums.get(b.key).session));
      group.forEach((s, i) => {
        const { folder, session } = nums.get(s.key);
        const lead = group.length < 2 ? 0 : s.type === 'Informal' ? Number(session) || i + 1 : i + 1;
        out.set(s.key, {
          id: masterId(s, folder, session),
          type: s.type,
          folder,
          session,
          jobName: jobFolderName(folder, sessionDay(s)),
          sessionName: sessionFolderName(s, session, lead),
          cams: camsFor(s, defaults),
        });
      });
    }
    return out;
  }

  /* --------------------------------------------------------- checks */

  const RE_DURATION = /^(?:\d+h )?(?:\d+m )?\d+s$|^\d+h(?: \d+m)?$|^\d+m$/;

  // The Raw Satsang Master fields Frappe's import requires (its red fields):
  // ID (from folder, session, type, format and author), Folder/DVCAM No.,
  // Session Time/No., Satsang Type, Full Date, Format, Author, Duration, and
  // an Event Type in the Event/Category table. Everything else — activity,
  // place, topic, language, clips, cameras — is optional there, so problems
  // with it are warnings.
  const FORMATS = ['HD', '4K', 'DV'];

  /**
   * What would make Frappe refuse a row, or keep its durations from finding
   * their folder after the backup. Map key -> {field: {msg, hard, after}}:
   * `hard` (red) is a required field missing or wrong — it blocks saving, and
   * starting a backup unless `after` (the duration, known only once backed up);
   * the rest (yellow) are warnings.
   */
  function check(sessions, starts = {}, vocab = {}, cities = []) {
    const nums = assignNumbers(sessions, starts);
    const out = new Map();
    const add = (s, field, msg, hard = true, after = false) => {
      if (!out.has(s.key)) out.set(s.key, {});
      const o = out.get(s.key);
      if (!o[field] || (hard && !o[field].hard)) o[field] = { msg, hard, after };
    };
    const known = (list) => new Set((list || []).map((v) => String(v).toLowerCase()));
    const vocabOf = { activity: known(vocab.activities), events: known(vocab.events), languages: known(vocab.languages) };
    const included = sessions.filter((s) => s.include);
    const folders = new Map();
    const ids = new Map();
    for (const s of included) {
      const n = nums.get(s.key) || {};
      const label = String(n.session || '');
      if (!RE_ISO.test(s.date || '') || !fromIndian(s.date)) add(s, 'date', 'Enter the date as dd/mm/yyyy.');
      else if (afterMidnight(s)) add(s, 'date', `Starts after midnight — filed with the evening of ${toIndian(sessionDay(s))}.`, false);
      if (n.folder == null || !Number.isFinite(Number(n.folder)) || Number(n.folder) <= 0) {
        add(s, 'folder', `Enter the first ${s.type} folder number above, or type one in this row.`);
      } else {
        const k = String(Number(n.folder));
        if (!folders.has(k)) folders.set(k, []);
        folders.get(k).push(s);
        const id = `${k}-${label.toUpperCase()}`;
        if (ids.has(id)) {
          add(s, 'session', 'Same folder and session as another row — Frappe refuses a duplicate ID.');
          add(ids.get(id), 'session', 'Same folder and session as another row — Frappe refuses a duplicate ID.');
        } else ids.set(id, s);
      }
      if (s.type === 'Formal' && !/^[ME]\d*$/.test(label)) {
        add(s, 'session', 'Formal sessions are M or E — M1, M2 / E1, E2 when a half has more than one.');
      } else if (s.type === 'Informal' && !/^[1-9]\d*$/.test(label)) {
        add(s, 'session', 'Informal sessions are numbered 1, 2, 3.');
      }
      if (!['Formal', 'Informal'].includes(s.type)) add(s, 'type', 'Satsang Type is required: Formal or Informal.');
      if (!FORMATS.includes(s.format)) add(s, 'format', 'Format is required: HD, 4K or DV.');
      if (!String(s.author || '').trim()) add(s, 'author', 'Author is required (e.g. DD).');
      const dur = String(s.duration || '').trim();
      if (!dur) add(s, 'duration', 'Duration is required — it fills in when this session\'s backup finishes.', true, true);
      else if (!RE_DURATION.test(dur)) add(s, 'duration', 'Write it like 1h 2m 3s, 54m 1s or 48s.');
      // Optional in Frappe: warnings only.
      if (!String(s.topic || '').trim()) add(s, 'topic', 'No topic — it also names the session folder.', false);
      if (!String(s.city || '').trim()) add(s, 'city', 'Which city? It starts the session folder name.', false);
      else if (cities.length && !cityOf(s, cities)) {
        add(s, 'city', citiesNamed(s.city, cities).length > 1
          ? `Several cities are called ${s.city} — pick the right one from the list.`
          : 'Not in the city list — Geolocation (City, State, Country) stays empty in Frappe.', false);
      }
      const notListed = 'Not in the master list — Frappe refuses it unless it is added there first.';
      if (vocabOf.activity.size && s.activity && !vocabOf.activity.has(String(s.activity).toLowerCase())) {
        add(s, 'activity', notListed, false);
      }
      for (const f of ['events', 'languages']) {
        const list = (s[f] || []).filter(Boolean);
        if (!list.length) {
          if (f === 'events') add(s, f, 'Event Type is required — pick at least one.');
          else add(s, f, 'No language.', false);
        }
        else if (vocabOf[f].size && list.some((v) => !vocabOf[f].has(String(v).toLowerCase()))) add(s, f, notListed, false);
      }
    }
    for (const [folder, group] of folders) {
      const days = new Set(group.map(sessionDay));
      if (days.size > 1) {
        group.forEach((s) => add(s, 'folder', `Folder ${folder} is on ${days.size} different days — each day has its own folder.`));
      }
      if (new Set(group.map((s) => s.type)).size > 1) {
        group.forEach((s) => add(s, 'folder', `Folder ${folder} is used for both Formal and Informal.`));
      }
      const labels = group.map((s) => String(nums.get(s.key).session).toUpperCase());
      if (group[0].type === 'Formal') {
        for (const h of ['M', 'E']) {
          const mine = group.filter((s, i) => labels[i].startsWith(h));
          const word = h === 'M' ? 'morning (before noon)' : 'evening (noon till next morning)';
          if (mine.length === 1 && String(nums.get(mine[0].key).session).toUpperCase() !== h) {
            add(mine[0], 'session', `The only ${word} session is just ${h}.`);
          } else if (mine.length > 1) {
            const want = mine.map((_, i) => `${h}${i + 1}`).join(', ');
            const got = mine.map((s) => String(nums.get(s.key).session).toUpperCase()).sort(
              (a, b) => sessionRank(a) - sessionRank(b));
            if (got.join(', ') !== want) mine.forEach((s) => add(s, 'session', `${mine.length} ${word} sessions are ${want}.`));
          }
        }
        group.forEach((s) => {
          const label = String(nums.get(s.key).session).toUpperCase();
          if (/^[ME]/.test(label) && label[0] !== half(s) && s.start) {
            add(s, 'session', `Starts at ${s.start}, so it is ${half(s) === 'M' ? 'a morning (M)' : 'an evening (E)'} session.`);
          }
        });
      } else {
        const sorted = labels.map(Number).sort((a, b) => a - b);
        if (sorted.some((v, i) => v !== i + 1)) {
          group.forEach((s) => add(s, 'session', `Informal sessions in folder ${folder} run 1, 2, 3 with no gaps.`, false));
        }
      }
    }
    return out;
  }

  /**
   * Sheet rows for the included sessions, newest first like the master. A
   * second event type or language goes on its own row underneath with every
   * other cell blank — the master's convention. Dates are ISO strings here.
   */
  function sheetRows(sessions, starts = {}, cities = []) {
    const nums = assignNumbers(sessions, starts);
    const included = sessions.filter((s) => s.include && nums.has(s.key));
    const rank = (s) => {
      const n = nums.get(s.key);
      return [sessionDay(s), n.folder || 0, sessionRank(n.session)];
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
        sessionDay(s), s.duration || '', s.activity, s.place, s.topic,
        s.clips === '' || s.clips == null ? '' : Number(s.clips),
        s.cameras === '' || s.cameras == null ? '' : Number(s.cameras),
        events[0] || '', langs[0] || '', geolocation(s, cities)]);
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
      if (s.placeText && s.place && (s.place !== auto.place || (s.city && s.city !== auto.city))) {
        const i = mem.places.findIndex((p) => similarity(p.key, s.placeText) >= 0.92);
        if (i >= 0) mem.places.splice(i, 1);
        mem.places.unshift({ key: s.placeText, place: s.place, city: s.city || '',
          languages: (s.languages || []).slice() });
      }
    }
    mem.titles = mem.titles.slice(0, 300);
    mem.places = mem.places.slice(0, 300);
    return mem;
  }

  /* ------------------------------------------------------- cities */

  /** "Gujarat-India" with country "India" -> "Gujarat". */
  function stateName(state, country) {
    let t = String(state || '');
    const tail = `-${country}`;
    while (country && t.toLowerCase().endsWith(tail.toLowerCase()) && t.length > tail.length) {
      t = t.slice(0, -tail.length);
    }
    return t;
  }

  /**
   * The city list — Frappe's City doctype export: ID, City Name, State, Country
   * — as [{name, city, state, country}]. `name` is the record ID
   * ("Bhadran-Gujarat-India"), which is what the Geolocation link holds.
   */
  function parseCities(rows) {
    const all = (rows || []).map((r) => (r || []).map((c) => String(c ?? '').trim()));
    const hi = all.findIndex((r) => r.some((c) => /^city/i.test(c)));
    if (hi < 0) return [];
    const head = all[hi].map((c) => c.toLowerCase());
    const col = (...tests) => head.findIndex((h) => tests.some((t) => t.test(h)));
    const iName = col(/^(id|name)$/);
    const iCity = col(/^city( name)?$/, /^city/);
    const iState = col(/^state/);
    const iCountry = col(/^country/);
    const out = [];
    const seen = new Set();
    for (const r of all.slice(hi + 1)) {
      const city = r[iCity] || '';
      if (!city) continue;
      const country = iCountry >= 0 ? r[iCountry] || '' : '';
      const rec = { name: (iName >= 0 && r[iName]) || city, city,
        state: stateName(iState >= 0 ? r[iState] : '', country), country };
      const k = rec.name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(rec); }
    }
    return out.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  }

  const citiesNamed = (city, cities) => {
    const k = String(city || '').trim().toLowerCase();
    return k ? (cities || []).filter((c) => c.city.toLowerCase() === k) : [];
  };

  /** A typed city or city ID -> its record: an ID always; a name only when one city has it. */
  function findCity(text, cities) {
    const k = String(text || '').trim().toLowerCase();
    if (!k) return null;
    const byId = (cities || []).find((c) => c.name.toLowerCase() === k);
    if (byId) return byId;
    const named = citiesNamed(text, cities);
    return named.length === 1 ? named[0] : null;
  }

  /** A row's city record: the one picked (`geo`, an ID) if it still matches, else by name. */
  function cityOf(s, cities) {
    if (s.geo) {
      const picked = findCity(s.geo, cities);
      if (picked && picked.city.toLowerCase() === String(s.city || '').trim().toLowerCase()) return picked;
    }
    return findCity(s.city, cities);
  }

  /** Geolocation for the sheet: the city record's ID; blank when it isn't in the
   * list, since Frappe refuses a link to a city it doesn't have. */
  function geolocation(s, cities) {
    const c = cityOf(s, cities);
    return c ? c.name : '';
  }

  /* ------------------------------------------------------- report */

  // The header words of the master / Frappe report exports, per field.
  const REPORT_FIELDS = {
    id: [/^(raw video )?id$/],
    folder: [/^folder/],
    format: [/^format$/],
    session: [/^session/],
    author: [/^author$/],
    type: [/^satsang type$/],
    date: [/^full date$/, /^date$/],
    year: [/^year$/], month: [/^(m|month)$/], day: [/^(d|day)$/],
    duration: [/^duration$/],
    activity: [/^activity$/],
    place: [/^place detail/],
    topic: [/^topic/],
    remarks: [/^remarks?$/],
    clips: [/^no\.? ?of clips$/, /^no o/],
    cameras: [/^no\.? ?of cameras$/],
    events: [/^event type/],
    languages: [/^language/],
    city: [/^city$/], state: [/^state$/], country: [/^country$/],
    geolocation: [/^geolocation$/],
  };

  /** An Excel serial (46312), dd-mm-yyyy, dd/mm/yyyy or ISO date -> ISO; '' if none. */
  function reportDate(v) {
    const t = String(v ?? '').trim();
    if (/^\d{5}(\.\d+)?$/.test(t)) {
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(+t) * 86400000).toISOString().slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    return fromIndian(t.split(' ')[0]) || '';
  }

  /** "00:56:23" or "56m 23s" -> the master's "56m 23s". */
  function reportDuration(v) {
    const t = String(v ?? '').trim();
    const m = /^(\d+):([0-5]?\d):([0-5]?\d)$/.exec(t);
    return m ? fmtDuration(+m[1] * 3600 + +m[2] * 60 + +m[3]) : t;
  }

  /**
   * Records from an existing-data export (the master .xlsx or a Frappe report
   * download): one per ID, with the continuation rows' extra event types and
   * languages folded in, and comma lists ("Shibir,Parayan") split.
   */
  function parseReport(rows, cities = []) {
    const all = (rows || []).map((r) => (r || []).map((c) => String(c ?? '').trim()));
    const hi = all.findIndex((r) => r.some((c) => REPORT_FIELDS.id.some((t) => t.test(c.toLowerCase()))));
    if (hi < 0) return [];
    const head = all[hi].map((c) => c.toLowerCase());
    const at = {};
    for (const [f, tests] of Object.entries(REPORT_FIELDS)) {
      at[f] = head.findIndex((h) => tests.some((t) => t.test(h)));
    }
    const get = (r, f) => (at[f] >= 0 ? r[at[f]] || '' : '');
    const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const out = [];
    let last = null;
    for (const r of all.slice(hi + 1)) {
      const id = get(r, 'id');
      if (!id) {
        if (last) {
          for (const f of ['events', 'languages']) {
            for (const v of split(get(r, f))) if (!last[f].includes(v)) last[f].push(v);
          }
        }
        continue;
      }
      let date = reportDate(get(r, 'date'));
      if (!date && get(r, 'year')) {
        const y = +get(r, 'year'), mo = +get(r, 'month'), d = +get(r, 'day');
        if (y && mo && d && validDay(y, mo, d)) date = iso(y, mo, d);
      }
      const geo = findCity(get(r, 'geolocation'), cities);
      last = {
        id, folder: Number(get(r, 'folder')) || null, format: get(r, 'format'), session: get(r, 'session'),
        author: get(r, 'author'), type: get(r, 'type'), date, duration: reportDuration(get(r, 'duration')),
        activity: get(r, 'activity'), place: get(r, 'place'), topic: get(r, 'topic'),
        clips: get(r, 'clips'), cameras: get(r, 'cameras'), ...(get(r, 'remarks') ? { remarks: get(r, 'remarks') } : {}),
        events: split(get(r, 'events')), languages: split(get(r, 'languages')),
        city: get(r, 'city') || (geo ? geo.city : ''), state: get(r, 'state') || (geo ? geo.state : ''),
        country: get(r, 'country') || (geo ? geo.country : ''), source: 'existing',
      };
      // The ID ("DD-I-DV-1498-1") names the parts a column may leave out.
      const m = /^([A-Z]+)(?:,\s*[A-Z]+)?-([FI])-([A-Z0-9]+)-0*(\d+)-(.+)$/i.exec(id);
      if (m) {
        if (!last.author) last.author = m[1];
        if (!last.type) last.type = m[2].toUpperCase() === 'F' ? 'Formal' : 'Informal';
        if (!last.format) last.format = m[3];
        if (!last.folder) last.folder = +m[4];
        if (!last.session) last.session = m[5];
      }
      out.push(last);
    }
    return out;
  }

  /** Records for one schedule's ticked rows, in the same shape as parseReport's. */
  function scheduleRecords(sessions, starts = {}, cities = [], label = '') {
    const nums = assignNumbers(sessions, starts);
    const out = [];
    for (const s of sessions) {
      const n = nums.get(s.key);
      if (!s.include || !n || n.folder == null || !Number.isFinite(Number(n.folder))) continue;
      const c = cityOf(s, cities);
      out.push({
        id: masterId(s, n.folder, n.session), folder: Number(n.folder), format: s.format,
        session: String(n.session), author: s.author, type: s.type, date: sessionDay(s),
        duration: s.duration || '', activity: s.activity, place: s.place, topic: s.topic,
        clips: s.clips ?? '', cameras: s.cameras ?? '', remarks: s.remarks || '', events: (s.events || []).slice(),
        languages: (s.languages || []).slice(), city: c ? c.city : s.city || '',
        state: c ? c.state : '', country: c ? c.country : '', source: 'schedule', schedule: label, uid: s.uid,
        backedUp: !!s.backedUp,
      });
    }
    return out;
  }

  /**
   * Which numbering a folder belongs to: Formal and Informal count separately,
   * DV tapes separately from HD/4K files, and NM's recordings separately from
   * DD's (DJM shares DD's). Each runs from 1 without holes.
   */
  function seriesOf(r) {
    const who = String(r.author || '').split(',')[0].trim().toUpperCase() === 'NM' ? 'NM' : 'DD';
    const fam = String(r.format || '').toUpperCase() === 'DV' ? 'DV' : 'HD/4K';
    return `${who} ${r.type || '?'} ${fam}`;
  }

  /**
   * Existing records plus the schedules', newest first (date, then folder, then
   * session). A schedule row replaces an existing one with the same ID.
   */
  function mergeReport(existing, scheduled) {
    const byId = new Map();
    for (const r of existing || []) byId.set(r.id.toUpperCase(), r);
    for (const r of scheduled || []) {
      const prev = byId.get(r.id.toUpperCase());
      byId.set(r.id.toUpperCase(), prev ? { ...r, alsoExisting: true } : r);
    }
    return [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
      || (b.folder || 0) - (a.folder || 0) || sessionRank(b.session) - sessionRank(a.session));
  }

  /**
   * Holes in the numbering: folder numbers missing inside each series, and
   * Informal session numbers missing inside a folder (1, 3 with no 2).
   * Returns [{series, kind, after, text}], highest folder first; `after` is the
   * folder the gap sits just below (or the folder with the missing session).
   */
  function findGaps(records) {
    const series = new Map();
    for (const r of records || []) {
      if (!r.folder) continue;
      const k = seriesOf(r);
      if (!series.has(k)) series.set(k, new Map());
      const folders = series.get(k);
      if (!folders.has(r.folder)) folders.set(r.folder, []);
      folders.get(r.folder).push(r);
    }
    const gaps = [];
    for (const [k, folders] of series) {
      const nums = [...folders.keys()].sort((a, b) => a - b);
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] - nums[i - 1] > 1) {
          const from = nums[i - 1] + 1, to = nums[i] - 1;
          gaps.push({ series: k, kind: 'folder', after: nums[i],
            text: `${k}: folder ${from === to ? from : `${from}–${to}`} missing` });
        }
      }
      if (!k.includes('Informal')) continue;
      for (const [folder, rows] of folders) {
        const have = new Set(rows.map((r) => Number(r.session)).filter((n) => n > 0));
        const top = Math.max(0, ...have);
        const missing = [];
        for (let n = 1; n < top; n++) if (!have.has(n)) missing.push(n);
        if (missing.length) {
          gaps.push({ series: k, kind: 'session', after: folder,
            text: `${k}: folder ${folder} has no session ${missing.join(', ')}` });
        }
      }
    }
    return gaps.sort((a, b) => b.after - a.after);
  }

  // The report's filters, as on Frappe's Raw Video Data Report. Text filters
  // match anywhere in the field, case-insensitive; Folder and Date are ranges.
  const REPORT_TEXT_FILTERS = ['year', 'activity', 'country', 'state', 'city', 'place', 'events',
    'topic', 'languages', 'type', 'author', 'format'];

  /** Records passing the report's filters ({field: text}, folderFrom/To, dateFrom/To ISO). */
  function filterReport(records, f = {}) {
    const has = (v, q) => String(Array.isArray(v) ? v.join(', ') : v ?? '').toLowerCase().includes(q);
    const tests = [];
    for (const k of REPORT_TEXT_FILTERS) {
      const q = String(f[k] || '').trim().toLowerCase();
      if (!q) continue;
      if (k === 'year') tests.push((r) => String(r.date || '').startsWith(q));
      else if (k === 'type' || k === 'format') tests.push((r) => String(r[k] || '').toLowerCase() === q);
      else tests.push((r) => has(r[k], q));
    }
    for (const [k, q] of Object.entries(f.columns || {})) {
      const t = String(q || '').trim().toLowerCase();
      if (t) tests.push((r) => has(k === 'date' ? toIndian(r.date) : r[k], t));
    }
    const lo = Number(f.folderFrom), hi = Number(f.folderTo);
    if (f.folderFrom !== '' && f.folderFrom != null && Number.isFinite(lo)) tests.push((r) => (r.folder || 0) >= lo);
    if (f.folderTo !== '' && f.folderTo != null && Number.isFinite(hi)) tests.push((r) => (r.folder || 0) <= hi);
    if (f.dateFrom) tests.push((r) => r.date && r.date >= f.dateFrom);
    if (f.dateTo) tests.push((r) => r.date && r.date <= f.dateTo);
    return tests.length ? (records || []).filter((r) => tests.every((t) => t(r))) : (records || []).slice();
  }

  // The report as a sheet: the headers parseReport reads back, so an export can
  // be chosen again later as the existing data.
  const REPORT_SHEET = [['Raw Video Id', 'id'], ['Folder', 'folder'], ['Year', 'year'], ['M', 'month'], ['D', 'day'],
    ['Activity', 'activity'], ['Author', 'author'], ['Format', 'format'], ['Satsang Type', 'type'], ['City', 'city'],
    ['State', 'state'], ['Country', 'country'], ['Place Detail', 'place'], ['Session', 'session'],
    ['Event Type', 'events'], ['Topic/Description', 'topic'], ['Language', 'languages'], ['Duration', 'duration'],
    ['No of clips', 'clips'], ['No of cameras', 'cameras'], ['Remarks', 'remarks']];

  /** How often each event was held with each other one: Map(lowercase event -> Map(event -> times)). */
  function eventPartners(records) {
    const out = new Map();
    for (const r of records || []) {
      for (const a of r.events || []) {
        for (const b of r.events || []) {
          if (a === b) continue;
          const k = String(a).toLowerCase();
          if (!out.has(k)) out.set(k, new Map());
          out.get(k).set(b, (out.get(k).get(b) || 0) + 1);
        }
      }
    }
    return out;
  }

  /** Report records -> {columns, rows} for an .xlsx; whole numbers stay numbers. */
  function reportSheet(records) {
    const value = (r, k) => {
      if (k === 'year') return r.date ? +r.date.slice(0, 4) : '';
      if (k === 'month') return r.date ? +r.date.slice(5, 7) : '';
      if (k === 'day') return r.date ? +r.date.slice(8, 10) : '';
      const v = r[k];
      if (Array.isArray(v)) return v.join(', ');
      if (['folder', 'clips', 'cameras'].includes(k) && /^\d+$/.test(String(v ?? ''))) return Number(v);
      return v ?? '';
    };
    return { columns: REPORT_SHEET.map(([h]) => h),
      rows: (records || []).map((r) => REPORT_SHEET.map(([, k]) => value(r, k))) };
  }

  /** Rows ordered by Raw (folder) number; rows without a number keep their order at the end. */
  function sortByRaw(rows, dir = 'asc') {
    const num = (r) => { const m = /\d+/.exec(r.folder == null ? '' : String(r.folder)); return m ? Number(m[0]) : null; };
    const sign = dir === 'desc' ? -1 : 1;
    return rows.map((r, i) => ({ r, i, n: num(r) })).sort((a, b) =>
      (a.n === null) - (b.n === null) || (a.n === null ? 0 : sign * (a.n - b.n)) || a.i - b.i).map((x) => x.r);
  }

  return { sortByRaw, COLUMNS, findDates, findTime, cleanTitle, similarity, readRows, classify,
           draftSessions, assignNumbers, masterId, sheetRows, fmtDuration, applyScan,
           learn, toIndian, fromIndian, sessionDay, half, camsFor, jobFolderName,
           sessionFolderName, folderPlan, check, parseCities, findCity, cityOf, geolocation,
           parseReport, reportSheet, eventPartners, scheduleRecords, seriesOf, mergeReport, findGaps, filterReport,
           reportDate, TITLE_RULES, PLACE_RULES };
});
