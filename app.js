/**
 * MyBookFinder — app.js
 *
 * Static-only: everything runs in the browser.
 *
 * VPL / Kobo don't expose CORS-friendly APIs, so we:
 *   • Build deep-link URLs for VPL (physical + ebook) and Kobo Store → open in new tab.
 *   • Auto-check Kobo Plus via the api.allorigins.win CORS proxy, trying three
 *     parse strategies on the returned HTML (Next.js __NEXT_DATA__, text patterns,
 *     DOM element count).
 *   • Goodreads: one-time import of the user's exported CSV → stored in localStorage.
 *     Every search matches the query against the imported library client-side.
 *
 * Book metadata (cover, author, year) is pulled from Open Library (CORS-friendly).
 */

'use strict';

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const ALLORIGINS     = 'https://api.allorigins.win/get?url=';
const GR_STORAGE_KEY = 'mybookfinder_gr_library';
const GR_ACCENT      = '#7B4B00';   // warm book-brown for Goodreads

/* ══════════════════════════════════════════════
   SOURCE DEFINITIONS
   Every source except Goodreads lives here.
   getUrl(query, searchType) → full URL string.
══════════════════════════════════════════════ */
const SOURCES = [
  {
    id:       'vpl-physical',
    source:   'Vancouver Public Library',
    title:    'Physical Copy',
    icon:     '🏛️',
    accent:   '#1A5EA8',
    badge:    'Free',
    badgeCls: 'badge-free',
    desc:     'Borrow a physical book from any VPL branch. Check availability and place a hold.',
    ctaLabel: 'Search VPL',
    getUrl(query, searchType) {
      const q    = encodeURIComponent(query);
      const type = searchType === 'author' ? 'contributor' : 'title';
      return `https://vpl.bibliocommons.com/v2/search?query=${q}&searchType=${type}&formatSelect_facet=BOOK`;
    },
  },

  {
    id:       'vpl-ebook',
    source:   'Vancouver Public Library',
    title:    'eBook via Libby',
    icon:     '📱',
    accent:   '#0D8A7B',
    badge:    'Free',
    badgeCls: 'badge-free',
    desc:     'Borrow a free ebook with your VPL card through the Libby app (OverDrive).',
    ctaLabel: 'Search VPL eBooks',
    getUrl(query, searchType) {
      const q    = encodeURIComponent(query);
      const type = searchType === 'author' ? 'contributor' : 'title';
      return `https://vpl.bibliocommons.com/v2/search?query=${q}&searchType=${type}&formatSelect_facet=EBOOK`;
    },
  },

  {
    id:        'kobo-plus',
    source:    'Kobo Plus',
    title:     'Subscription',
    icon:      '♾️',
    accent:    '#7B3FA0',
    badge:     'Subscription',
    badgeCls:  'badge-sub',
    autoCheck: true,                // signals buildCard to render a loading state
    ctaLabel:  'Open Kobo Plus',
    getUrl(query) {
      const q = encodeURIComponent(query);
      return `https://www.kobo.com/ca/en/search?Query=${q}&MediaType=ebook&fcis_kobo_plus=true`;
    },
  },

  {
    id:       'kobo-store',
    source:   'Kobo Store',
    title:    'Buy eBook',
    icon:     '🛒',
    accent:   '#C85A00',
    badge:    'Paid',
    badgeCls: 'badge-paid',
    desc:     'Purchase the ebook outright from the Kobo Store — own it forever.',
    ctaLabel: 'Search Kobo Store',
    getUrl(query) {
      const q = encodeURIComponent(query);
      return `https://www.kobo.com/ca/en/search?Query=${q}&MediaType=ebook`;
    },
  },
];

/* ══════════════════════════════════════════════
   STATE
══════════════════════════════════════════════ */
let currentQuery      = '';
let currentSearchType = 'title';
let grBooks           = [];          // Goodreads library loaded from localStorage
let koboPlusAbort     = null;        // AbortController for the in-flight Kobo check

/* ══════════════════════════════════════════════
   DOM REFS
══════════════════════════════════════════════ */
const form         = document.getElementById('search-form');
const input        = document.getElementById('search-input');
const resultsEl    = document.getElementById('results');
const bookMetaEl   = document.getElementById('book-meta');
const cardsGridEl  = document.getElementById('cards-grid');
const queryDisplay = document.getElementById('query-display');
const grFileInput  = document.getElementById('gr-file-input');

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Load persisted Goodreads library
  grBooks = loadGrLibrary();

  // File input → parse CSV when a file is chosen
  grFileInput.addEventListener('change', handleGrFileChange);

  // Restore from URL query string (bookmarkable links)
  const params = new URLSearchParams(window.location.search);
  const q      = params.get('q');
  const type   = params.get('type') || 'title';

  if (q) {
    input.value = q;
    const radio = form.querySelector(`input[name="searchType"][value="${type}"]`);
    if (radio) radio.checked = true;
    runSearch(q, type);
  }
});

/* ══════════════════════════════════════════════
   FORM SUBMIT
══════════════════════════════════════════════ */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const query      = input.value.trim();
  const searchType = form.querySelector('input[name="searchType"]:checked').value;
  if (!query) { input.focus(); return; }

  // Reflect in URL so results are shareable / bookmarkable
  history.pushState(null, '', '?' + new URLSearchParams({ q: query, type: searchType }));
  runSearch(query, searchType);
});

/* ══════════════════════════════════════════════
   MAIN SEARCH ORCHESTRATOR
══════════════════════════════════════════════ */
function runSearch(query, searchType) {
  currentQuery      = query;
  currentSearchType = searchType;

  resultsEl.hidden = false;
  queryDisplay.textContent = `"${query}"`;

  // Cancel any in-flight Kobo Plus check from a previous search
  koboPlusAbort?.abort();
  koboPlusAbort = new AbortController();

  // Render all cards synchronously (Kobo Plus gets a spinner)
  renderCards(query, searchType);

  // Parallel async work
  fetchBookMeta(query, searchType);
  autoCheckKoboPlus(query, searchType, koboPlusAbort.signal);

  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════════════════════
   RENDER CARDS
══════════════════════════════════════════════ */
function renderCards(query, searchType) {
  const sourceHTML   = SOURCES.map(src => buildCard(src, query, searchType)).join('');
  const dividerHTML  = `<div class="cards-divider" role="separator"><span>Your Library</span></div>`;
  const goodreadsHTML = buildGoodreadsCard(query, searchType);

  cardsGridEl.innerHTML = sourceHTML + dividerHTML + goodreadsHTML;

  // Wire up Goodreads import/update buttons (rendered inside cardsGridEl)
  cardsGridEl.querySelector('#gr-import-btn')?.addEventListener('click', () => grFileInput.click());
  cardsGridEl.querySelector('#gr-update-btn')?.addEventListener('click', () => grFileInput.click());
}

/* ── Standard source card ── */
function buildCard(src, query, searchType) {
  const url          = src.getUrl(query, searchType);
  const isAutoCheck  = !!src.autoCheck;

  // Kobo Plus: show spinner while checking; others: static description
  const bodyContent = isAutoCheck
    ? `<div id="kobo-plus-status" class="check-status checking" aria-live="polite">
         <span class="check-spinner" aria-hidden="true"></span>
         <span>Checking availability…</span>
       </div>`
    : `<p class="card-desc">${src.desc}</p>`;

  return `
    <article class="card" id="card-${src.id}" role="listitem">
      <div class="card-stripe" style="--accent:${src.accent}"></div>
      <div class="card-body">
        <div class="card-header-row">
          <div class="card-label">
            <span class="card-icon" aria-hidden="true">${src.icon}</span>
            <div class="card-names">
              <span class="card-source" style="--accent:${src.accent}">${src.source}</span>
              <span class="card-title">${src.title}</span>
            </div>
          </div>
          <span class="card-badge ${src.badgeCls}">${src.badge}</span>
        </div>
        ${bodyContent}
      </div>
      <div class="card-footer">
        <a class="card-cta"
           href="${escapeAttr(url)}"
           target="_blank"
           rel="noopener noreferrer"
           style="--accent:${src.accent}"
           aria-label="${src.ctaLabel} for ${escapeAttr(query)}">
          ${src.ctaLabel}
          <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </article>`;
}

/* ══════════════════════════════════════════════
   KOBO PLUS AUTO-CHECK
   Strategy order:
     1. Parse Next.js __NEXT_DATA__ JSON blob (most reliable if Kobo uses Next.js)
     2. Look for text patterns: "X results", "no results found"
     3. Count DOM elements that look like book cards
══════════════════════════════════════════════ */
async function autoCheckKoboPlus(query, searchType, signal) {
  const statusEl = document.getElementById('kobo-plus-status');
  if (!statusEl) return;

  try {
    const result = await fetchKoboData(query, signal);
    if (signal.aborted) return;

    if (result.status === 'found') {
      const countNote = result.count ? ` (${result.count} result${result.count !== 1 ? 's' : ''})` : '';
      updateKoboStatus('found',     `✅ Available on Kobo Plus${countNote}`);
    } else if (result.status === 'not-found') {
      updateKoboStatus('not-found', '❌ Not found on Kobo Plus');
    } else {
      updateKoboStatus('unknown',   '⚠️ Couldn\'t auto-check — open to verify');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    updateKoboStatus('unknown', '⚠️ Couldn\'t auto-check — open to verify');
  }
}

function updateKoboStatus(cssClass, message) {
  const el = document.getElementById('kobo-plus-status');
  if (!el) return;
  el.className = `check-status ${cssClass}`;
  el.innerHTML = `<span class="check-icon" aria-hidden="true">${message.slice(0, 2)}</span><span>${message.slice(2).trimStart()}</span>`;
}

async function fetchKoboData(query, signal) {
  const koboUrl  = `https://www.kobo.com/ca/en/search?Query=${encodeURIComponent(query)}&MediaType=ebook&fcis_kobo_plus=true`;
  const proxyUrl = ALLORIGINS + encodeURIComponent(koboUrl);

  // Combine the cancel signal with a hard 14-second timeout if the browser supports it
  const fetchSignal =
    (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.any([signal, AbortSignal.timeout(14000)])
      : signal;

  const resp = await fetch(proxyUrl, { signal: fetchSignal });

  if (!resp.ok) throw new Error(`proxy ${resp.status}`);
  const data = await resp.json();

  const html     = data.contents || '';
  const httpCode = data.status?.http_code ?? 200;

  if (httpCode === 429 || httpCode >= 500) throw new Error(`kobo ${httpCode}`);

  // ── Strategy 1: Next.js __NEXT_DATA__ ──────────────────────
  const nd = extractNextData(html);
  if (nd !== null) return nd;

  // ── Strategy 2: Text patterns ──────────────────────────────
  const parser   = new DOMParser();
  const doc      = parser.parseFromString(html, 'text/html');
  const bodyText = (doc.body?.textContent ?? '').toLowerCase();

  // "no results" language
  if (/no results found|no results for|0 results/.test(bodyText)) {
    return { status: 'not-found' };
  }

  // "42 results" / "42 books" / "42 titles"
  const m = bodyText.match(/(\d[\d,]*)\s+(?:result|book|title)/);
  if (m) {
    const n = parseInt(m[1].replace(/,/g, ''));
    return { status: n > 0 ? 'found' : 'not-found', count: n };
  }

  // ── Strategy 3: Count plausible book-card DOM elements ──────
  const items = [...doc.querySelectorAll('article, [class*="result"], [class*="product"], [class*="item"]')]
    .filter(el => el.textContent.trim().length > 40 && el.tagName !== 'BODY');

  if (items.length > 0) return { status: 'found', count: items.length };

  // Got HTML but couldn't determine result count
  return { status: 'unknown' };
}

/**
 * Try to extract search result info from a Next.js __NEXT_DATA__ script tag.
 * Returns {status, count} or null if the tag isn't present / unrecognisable.
 */
function extractNextData(html) {
  const m = html.match(/<script\s[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (!m) return null;

  let nd;
  try { nd = JSON.parse(m[1]); } catch { return null; }

  const pp = nd?.props?.pageProps;
  if (!pp) return null;

  // Try common Kobo result shapes
  const candidates = [
    pp.searchResults, pp.results, pp.data?.searchResults,
    pp.initialData?.searchResults, pp.searchData, pp.data,
  ];

  for (const c of candidates) {
    if (!c) continue;

    // totalCount field
    const total = c.totalCount ?? c.ResultCount ?? c.total ?? c.count;
    if (typeof total === 'number') {
      return { status: total > 0 ? 'found' : 'not-found', count: total };
    }

    // items / books array
    const arr = c.items ?? c.books ?? c.Items ?? c.Books ?? c.results;
    if (Array.isArray(arr)) {
      return { status: arr.length > 0 ? 'found' : 'not-found', count: arr.length };
    }
  }

  return null;
}

/* ══════════════════════════════════════════════
   GOODREADS CARD
══════════════════════════════════════════════ */
function buildGoodreadsCard(query, searchType) {
  const grSearchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}`;
  const hasData     = grBooks.length > 0;

  const bookCount = hasData ? grBooks.length.toLocaleString() : '';
  const badge     = hasData ? `${bookCount} books` : 'Personal';

  let bodySection, footerSection;

  if (!hasData) {
    // ── No library imported yet ──────────────────────────────
    bodySection = `
      <div class="import-area">
        <p class="import-area-title">📥 Check your reading history</p>
        <button class="import-btn" id="gr-import-btn" type="button">
          Import Goodreads CSV
        </button>
        <p class="import-hint">
          In Goodreads: <em>My Books → Import and Export → Export Library</em>.
          Your data stays in your browser — nothing is uploaded anywhere.
        </p>
      </div>`;

    footerSection = `
      <a class="card-cta"
         href="${escapeAttr(grSearchUrl)}"
         target="_blank" rel="noopener noreferrer"
         style="--accent:${GR_ACCENT}">
        Search on Goodreads
        <span class="cta-arrow" aria-hidden="true">↗</span>
      </a>`;
  } else {
    // ── Library loaded — look up the query ───────────────────
    const statusHtml = buildGrStatusHtml(query, searchType);

    bodySection = statusHtml;

    footerSection = `
      <div class="card-footer-row">
        <a class="card-cta"
           href="${escapeAttr(grSearchUrl)}"
           target="_blank" rel="noopener noreferrer"
           style="--accent:${GR_ACCENT}">
          Search on Goodreads
          <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
        <button class="card-cta-secondary" id="gr-update-btn" type="button">
          Update Library
        </button>
      </div>`;
  }

  return `
    <article class="card card--full" id="card-goodreads" role="listitem">
      <div class="card-stripe" style="--accent:${GR_ACCENT}"></div>
      <div class="card-body">
        <div class="card-header-row">
          <div class="card-label">
            <span class="card-icon" aria-hidden="true">📗</span>
            <div class="card-names">
              <span class="card-source" style="--accent:${GR_ACCENT}">Goodreads</span>
              <span class="card-title">Your Library</span>
            </div>
          </div>
          <span class="card-badge badge-personal">${badge}</span>
        </div>
        ${bodySection}
      </div>
      <div class="card-footer">${footerSection}</div>
    </article>`;
}

/** Build the status section inside the Goodreads card based on search type. */
function buildGrStatusHtml(query, searchType) {
  if (searchType === 'author') {
    return buildGrAuthorStatus(query);
  }
  return buildGrTitleStatus(query, searchType);
}

function buildGrTitleStatus(query, searchType) {
  const match = findBestGrMatch(query, searchType);

  if (!match) {
    return `
      <div class="gr-status">
        <span class="gr-badge gr-not-found">➖ Not in your library</span>
        <p class="gr-meta">Checked ${grBooks.length.toLocaleString()} books</p>
      </div>`;
  }

  const { badgeCls, icon, label } = shelfStyle(match.shelf);
  const stars   = starStr(match.rating);
  const dateStr = match.dateRead ? ` · Read ${fmtDate(match.dateRead)}` : '';
  const ratingStr = match.rating > 0 ? `Rated ${match.rating}/5 ${stars}${dateStr}` : '';
  const authorStr = match.author ? `by ${escapeHtml(match.author)}` : '';

  const metaParts = [ratingStr, authorStr].filter(Boolean).join(' — ');

  return `
    <div class="gr-status">
      <span class="gr-badge ${badgeCls}">${icon} ${label}</span>
      ${metaParts ? `<p class="gr-meta">${metaParts}</p>` : ''}
      <p class="gr-match-title">${escapeHtml(match.title)}</p>
    </div>`;
}

function buildGrAuthorStatus(query) {
  const norm = normalise(query);
  const matches = grBooks.filter(b => {
    const na = normalise(b.author);
    return na.includes(norm) || norm.includes(na);
  });

  if (matches.length === 0) {
    return `
      <div class="gr-status">
        <span class="gr-badge gr-not-found">➖ No books by this author in your library</span>
        <p class="gr-meta">Checked ${grBooks.length.toLocaleString()} books</p>
      </div>`;
  }

  const readCount    = matches.filter(b => b.shelf === 'read').length;
  const readingCount = matches.filter(b => b.shelf === 'currently-reading').length;
  const wantCount    = matches.filter(b => b.shelf === 'to-read').length;

  const summaryParts = [
    readCount    ? `${readCount} read`    : '',
    readingCount ? `${readingCount} reading` : '',
    wantCount    ? `${wantCount} to-read` : '',
  ].filter(Boolean).join(', ');

  const { badgeCls, icon } = readCount > 0
    ? shelfStyle('read')
    : readingCount > 0 ? shelfStyle('currently-reading') : shelfStyle('to-read');

  const listItems = matches.slice(0, 4).map(b => {
    const s = b.rating > 0 ? ` <span class="gr-stars">${starStr(b.rating)}</span>` : '';
    return `<li class="gr-book-item">${escapeHtml(b.title)}${s}</li>`;
  }).join('');

  const moreItem = matches.length > 4
    ? `<li class="gr-book-item gr-more">…and ${matches.length - 4} more</li>`
    : '';

  return `
    <div class="gr-status">
      <span class="gr-badge ${badgeCls}">
        ${icon} ${matches.length} book${matches.length !== 1 ? 's' : ''} by this author — ${summaryParts}
      </span>
      <ul class="gr-book-list">${listItems}${moreItem}</ul>
    </div>`;
}

function shelfStyle(shelf) {
  if (shelf === 'read')              return { badgeCls: 'gr-read',      icon: '✅', label: 'Read it!' };
  if (shelf === 'currently-reading') return { badgeCls: 'gr-reading',   icon: '📖', label: 'Currently reading' };
  if (shelf === 'to-read')           return { badgeCls: 'gr-want',      icon: '📌', label: 'On your to-read list' };
  return                                    { badgeCls: 'gr-want',      icon: '📚', label: 'In your library' };
}

/* ══════════════════════════════════════════════
   GOODREADS MATCHING
══════════════════════════════════════════════ */
function findBestGrMatch(query, searchType) {
  if (grBooks.length === 0) return null;

  const nq = normalise(query);
  let best  = null;
  let top   = 0;

  for (const book of grBooks) {
    const nt = normalise(book.title);
    const na = normalise(book.author);
    let score = 0;

    // Title matching (always tried)
    if      (nt === nq)                               score = 100;
    else if (nt.startsWith(nq + ' '))                 score =  88;
    else if (nt.includes(nq))                         score =  72;
    else if (nq.includes(nt) && nt.length > 5)       score =  55;

    // Author matching (boosted when searchType === 'author')
    if (na.includes(nq) || nq.includes(na)) {
      score = searchType === 'author' ? Math.max(score, 85) : Math.max(score, 30);
    }

    if (score > top) { top = score; best = book; }
  }

  return top >= 50 ? best : null;
}

function normalise(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ══════════════════════════════════════════════
   GOODREADS CSV IMPORT
══════════════════════════════════════════════ */
function handleGrFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const books = parseGrCSV(evt.target.result);
      if (books.length === 0) {
        alert("No books found. Make sure this is a Goodreads export CSV.");
        return;
      }

      grBooks = books;
      saveGrLibrary(books);

      // Re-render the Goodreads card in place (search may or may not be active)
      if (currentQuery) {
        const oldCard = document.getElementById('card-goodreads');
        if (oldCard) {
          const tmp = document.createElement('div');
          tmp.innerHTML = buildGoodreadsCard(currentQuery, currentSearchType);
          const newCard = tmp.firstElementChild;
          oldCard.replaceWith(newCard);
          // Re-attach update button
          newCard.querySelector('#gr-update-btn')?.addEventListener('click', () => grFileInput.click());
        }
      }
    } catch (err) {
      alert(`Couldn't read the file: ${err.message}`);
    }

    // Reset so the same file can be selected again if needed
    e.target.value = '';
  };

  reader.readAsText(file, 'UTF-8');
}

/**
 * Parse a Goodreads export CSV.
 * Goodreads wraps all fields in double quotes and uses standard RFC 4180.
 * Returns [{title, author, rating, shelf, dateRead}, …]
 */
function parseGrCSV(text) {
  const rows    = splitCSVRows(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  if (rows.length < 2) throw new Error('File appears empty');

  const headers = rows[0];
  const col     = name => headers.findIndex(h => h.trim() === name);

  const titleI    = col('Title');
  const authorI   = col('Author');
  const ratingI   = col('My Rating');
  const shelfI    = col('Exclusive Shelf');
  const dateReadI = col('Date Read');

  if (titleI === -1 || shelfI === -1) {
    throw new Error('Doesn\'t look like a Goodreads export. Expected columns: Title, Exclusive Shelf');
  }

  return rows.slice(1)
    .filter(r => r.length > Math.max(titleI, shelfI) && r[titleI]?.trim())
    .map(r => ({
      title:    r[titleI].trim(),
      author:   (r[authorI]   ?? '').trim(),
      rating:   parseInt(r[ratingI]) || 0,
      shelf:    (r[shelfI]    ?? '').trim(),
      dateRead: (r[dateReadI] ?? '').trim(),
    }));
}

/** RFC 4180 CSV parser — handles quoted fields containing commas and escaped quotes. */
function splitCSVRows(csv) {
  const rows   = [];
  let fields   = [];
  let field    = '';
  let inQuotes = false;
  let i        = 0;

  while (i < csv.length) {
    const ch = csv[i];

    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { field += '"'; i += 2; continue; }  // "" → "
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if      (ch === '"')  { inQuotes = true; }
      else if (ch === ',')  { fields.push(field); field = ''; }
      else if (ch === '\n') {
        fields.push(field);
        rows.push(fields);
        fields = []; field = '';
        i++; continue;
      } else {
        field += ch;
      }
    }
    i++;
  }

  // Trailing row (no final newline)
  fields.push(field);
  if (fields.some(f => f.trim())) rows.push(fields);

  return rows;
}

/* ══════════════════════════════════════════════
   GOODREADS PERSISTENCE
══════════════════════════════════════════════ */
function saveGrLibrary(books) {
  try { localStorage.setItem(GR_STORAGE_KEY, JSON.stringify(books)); } catch {}
}

function loadGrLibrary() {
  try {
    const raw = localStorage.getItem(GR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/* ══════════════════════════════════════════════
   OPEN LIBRARY METADATA (unchanged)
══════════════════════════════════════════════ */
async function fetchBookMeta(query, searchType) {
  bookMetaEl.innerHTML = `<p class="meta-loading">Looking up book info…</p>`;

  try {
    const param = searchType === 'author'
      ? `author=${encodeURIComponent(query)}`
      : `title=${encodeURIComponent(query)}`;

    const resp = await fetch(
      `https://openlibrary.org/search.json?${param}&limit=5&fields=title,author_name,cover_i,first_publish_year,key`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.docs?.length > 0) {
      renderBookMeta(data.docs[0]);
    } else {
      bookMetaEl.innerHTML = '';
    }
  } catch {
    bookMetaEl.innerHTML = '';
  }
}

function renderBookMeta(book) {
  const coverSrc = book.cover_i
    ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg` : null;
  const title  = escapeHtml(book.title || 'Unknown title');
  const author = book.author_name ? escapeHtml(book.author_name[0]) : null;
  const year   = book.first_publish_year || null;
  const olKey  = book.key || '';

  const coverHtml = coverSrc
    ? `<img src="${escapeAttr(coverSrc)}" alt="Cover of ${title}" class="book-cover" loading="lazy" width="80">`
    : `<div class="book-cover-placeholder" aria-hidden="true">📖</div>`;

  bookMetaEl.innerHTML = `
    <div class="book-preview">
      ${coverHtml}
      <div class="book-details">
        <p class="book-title-meta">${title}</p>
        ${author ? `<p class="book-author-meta">by ${author}</p>` : ''}
        ${year   ? `<p class="book-year-meta">First published ${year}</p>` : ''}
        <a class="book-ol-link"
           href="https://openlibrary.org${escapeAttr(olKey)}"
           target="_blank" rel="noopener noreferrer">
          View on Open Library ↗
        </a>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */

/** "YYYY/MM/DD" → "May 2024"  (Goodreads date format) */
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const m = parseInt(parts[1]) - 1;
    if (m >= 0 && m < 12) return `${months[m]} ${parts[0]}`;
  }
  return dateStr;
}

/** rating 1-5 → filled + empty stars */
function starStr(rating) {
  if (!rating || rating < 1) return '';
  const r = Math.min(5, Math.max(1, rating));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
