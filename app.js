/**
 * MyBookFinder — app.js
 *
 * Search flow (two steps):
 *   1. Query → Open Library search → picker list of matching books
 *   2. User clicks a book → availability checks fire for that exact title
 *
 * Availability checks:
 *   VPL physical / eBook  — deep-link URL, opens in new tab
 *   Kobo Plus             — auto-checked via allorigins.win CORS proxy;
 *                           detected by "free on kobo plus" phrase in HTML
 *   Kobo Store            — deep-link URL, opens in new tab
 *   Goodreads             — live shelf check via CORS proxy (user's public profile)
 */

'use strict';

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const ALLORIGINS  = 'https://api.allorigins.win/get?url=';
const GR_USER_KEY = 'mybookfinder_gr_userid';
const GR_ACCENT   = '#7B4B00';

/* ══════════════════════════════════════════════
   SOURCE DEFINITIONS
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
    getUrl(query) {
      return `https://vpl.bibliocommons.com/v2/search?query=${encodeURIComponent(query)}&searchType=title&formatSelect_facet=BOOK`;
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
    getUrl(query) {
      return `https://vpl.bibliocommons.com/v2/search?query=${encodeURIComponent(query)}&searchType=title&formatSelect_facet=EBOOK`;
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
    autoCheck: true,
    ctaLabel:  'Open Kobo Plus',
    getUrl(query) {
      return `https://www.kobo.com/ca/en/search?Query=${encodeURIComponent(query)}&MediaType=ebook&fcis_kobo_plus=true`;
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
      return `https://www.kobo.com/ca/en/search?Query=${encodeURIComponent(query)}&MediaType=ebook`;
    },
  },
];

/* ══════════════════════════════════════════════
   STATE
══════════════════════════════════════════════ */
let currentQuery      = '';
let currentSearchType = 'title';
let pickerDocs        = [];    // Open Library results for the current search
let selectedBook      = null;  // Book the user clicked in the picker
let grUserId          = null;
let olAbort           = null;  // AbortController for Open Library fetch
let koboAbort         = null;
let grAbort           = null;

/* ══════════════════════════════════════════════
   DOM REFS
══════════════════════════════════════════════ */
const form           = document.getElementById('search-form');
const input          = document.getElementById('search-input');
const resultsEl      = document.getElementById('results');
const pickerHeadEl   = document.getElementById('picker-heading');
const pickerListEl   = document.getElementById('picker-list');
const availabilityEl = document.getElementById('availability');
const bookMetaEl     = document.getElementById('book-meta');
const cardsGridEl    = document.getElementById('cards-grid');
const queryDisplay   = document.getElementById('query-display');

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  grUserId = loadGrUserId();

  // ── Picker click — delegated to the stable list container ──
  pickerListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.picker-item');
    if (!item) return;
    const idx = parseInt(item.dataset.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= pickerDocs.length) return;

    // Highlight selected item
    pickerListEl.querySelectorAll('.picker-item').forEach((el, i) => {
      el.classList.toggle('picker-item--selected', i === idx);
      el.setAttribute('aria-selected', String(i === idx));
    });

    selectBook(pickerDocs[idx]);
  });

  // ── Goodreads card interactions (delegated — card is rebuilt on each search) ──
  cardsGridEl.addEventListener('submit', (e) => {
    if (e.target.id === 'gr-connect-form') { e.preventDefault(); handleGrConnect(); }
  });
  cardsGridEl.addEventListener('click', (e) => {
    if (e.target.closest('#gr-disconnect-btn')) handleGrDisconnect();
  });

  // ── Restore from URL params ──
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

  history.pushState(null, '', '?' + new URLSearchParams({ q: query, type: searchType }));
  runSearch(query, searchType);
});

/* ══════════════════════════════════════════════
   STEP 1 — SEARCH → SHOW PICKER
══════════════════════════════════════════════ */
function runSearch(query, searchType) {
  currentQuery      = query;
  currentSearchType = searchType;
  selectedBook      = null;

  // Cancel any in-flight requests
  olAbort?.abort();   olAbort   = new AbortController();
  koboAbort?.abort(); koboAbort = null;
  grAbort?.abort();   grAbort   = null;

  // Show results area; hide availability until a book is selected
  resultsEl.hidden      = false;
  availabilityEl.hidden = true;

  // Show spinner in picker
  pickerHeadEl.textContent = '';
  pickerListEl.innerHTML   = `
    <div class="picker-loading">
      <span class="check-spinner" aria-hidden="true"></span>
      <span>Searching Open Library…</span>
    </div>`;

  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  fetchPickerResults(query, searchType, olAbort.signal);
}

async function fetchPickerResults(query, searchType, signal) {
  try {
    const param = searchType === 'author'
      ? `author=${encodeURIComponent(query)}`
      : `title=${encodeURIComponent(query)}`;

    const resp = await fetch(
      `https://openlibrary.org/search.json?${param}&limit=20`
       + `&fields=title,author_name,cover_i,first_publish_year,key`,
      { signal }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (!data.docs?.length) {
      pickerHeadEl.textContent = `No matches found for "${query}"`;
      pickerListEl.innerHTML = `
        <div class="picker-empty">
          <p>Open Library didn't find anything — try a different spelling or switch to Title/Author.</p>
          <button class="picker-fallback-btn" id="picker-fallback">
            Check anyway for "${escapeHtml(query)}"
          </button>
        </div>`;
      document.getElementById('picker-fallback')
        ?.addEventListener('click', () => runDirectCheck(query, searchType));
      return;
    }

    pickerDocs = data.docs;
    const total   = data.numFound ?? data.docs.length;
    const showing = data.docs.length;

    pickerHeadEl.textContent =
      `${showing}${total > showing ? ` of ${total.toLocaleString()}` : ''} results`
      + ` — click the right one to check availability`;

    pickerListEl.innerHTML = data.docs.map((book, i) => {
      const coverSrc = book.cover_i
        ? `https://covers.openlibrary.org/b/id/${book.cover_i}-S.jpg` : null;
      const title  = escapeHtml(book.title || 'Unknown title');
      const author = book.author_name?.length
        ? escapeHtml(book.author_name[0]) : 'Unknown author';
      const year   = book.first_publish_year ? ` · ${book.first_publish_year}` : '';

      return `
        <button class="picker-item" type="button" data-index="${i}"
                role="option" aria-selected="false">
          ${coverSrc
            ? `<img class="picker-cover" src="${escapeAttr(coverSrc)}" alt="" loading="lazy">`
            : `<div class="picker-no-cover" aria-hidden="true">📖</div>`}
          <div class="picker-info">
            <span class="picker-title">${title}</span>
            <span class="picker-byline">${author}${year}</span>
          </div>
          <span class="picker-check" aria-hidden="true">✓</span>
        </button>`;
    }).join('');

  } catch (err) {
    if (err.name === 'AbortError') return;
    pickerHeadEl.textContent = 'Search failed';
    pickerListEl.innerHTML = `
      <div class="picker-error">
        <p>Couldn't reach Open Library.</p>
        <button class="picker-fallback-btn" id="picker-fallback">
          Check anyway for "${escapeHtml(currentQuery)}"
        </button>
      </div>`;
    document.getElementById('picker-fallback')
      ?.addEventListener('click', () => runDirectCheck(currentQuery, currentSearchType));
  }
}

/* ══════════════════════════════════════════════
   STEP 2 — BOOK SELECTED → SHOW AVAILABILITY
══════════════════════════════════════════════ */
function selectBook(book) {
  selectedBook = book;

  // Reveal availability section
  availabilityEl.hidden = false;

  // Heading shows exact selected title
  queryDisplay.textContent = `"${book.title}"`;

  // Book metadata (cover, author, year) — we already have it from OL
  renderBookMeta(book);

  // Render cards + start async checks using the exact title
  const title = book.title;

  koboAbort?.abort(); koboAbort = new AbortController();
  grAbort?.abort();   grAbort   = new AbortController();

  renderCards(title);
  autoCheckKoboPlus(title, koboAbort.signal);
  if (grUserId) autoCheckGoodreads(title, grAbort.signal);

  availabilityEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Fallback: run checks with the raw typed query, skipping the picker. */
function runDirectCheck(query, searchType) {
  availabilityEl.hidden = false;
  queryDisplay.textContent = `"${escapeHtml(query)}"`;
  bookMetaEl.innerHTML = '';

  koboAbort?.abort(); koboAbort = new AbortController();
  grAbort?.abort();   grAbort   = new AbortController();

  renderCards(query);
  autoCheckKoboPlus(query, koboAbort.signal);
  if (grUserId) autoCheckGoodreads(query, grAbort.signal);

  availabilityEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════════════════════
   RENDER AVAILABILITY CARDS
══════════════════════════════════════════════ */
function renderCards(title) {
  const sourceHTML    = SOURCES.map(src => buildCard(src, title)).join('');
  const dividerHTML   = `<div class="cards-divider" role="separator"><span>Your Library</span></div>`;
  const goodreadsHTML = buildGoodreadsCard(title);
  cardsGridEl.innerHTML = sourceHTML + dividerHTML + goodreadsHTML;
}

function buildCard(src, title) {
  const url = src.getUrl(title);

  const body = src.autoCheck
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
        ${body}
      </div>
      <div class="card-footer">
        <a class="card-cta" href="${escapeAttr(url)}"
           target="_blank" rel="noopener noreferrer" style="--accent:${src.accent}">
          ${src.ctaLabel} <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </article>`;
}

/* ══════════════════════════════════════════════
   KOBO PLUS AUTO-CHECK
══════════════════════════════════════════════ */
async function autoCheckKoboPlus(title, signal) {
  try {
    const result = await fetchKoboData(title, signal);
    if (signal.aborted) return;

    if      (result.status === 'found')
      setKoboStatus('found',     '✅ Free on Kobo Plus!');
    else if (result.status === 'not-found')
      setKoboStatus('not-found', '❌ Not on Kobo Plus');
    else
      setKoboStatus('unknown',   '⚠️ Couldn\'t check — open to verify');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setKoboStatus('unknown', '⚠️ Couldn\'t check — open to verify');
  }
}

function setKoboStatus(cls, message) {
  const el = document.getElementById('kobo-plus-status');
  if (!el) return;
  el.className = `check-status ${cls}`;
  el.innerHTML = `<span class="check-icon" aria-hidden="true">${message.slice(0,2)}</span>`
               + `<span>${message.slice(2).trimStart()}</span>`;
}

async function fetchKoboData(title, signal) {
  const koboUrl  = `https://www.kobo.com/ca/en/search?Query=${encodeURIComponent(title)}&MediaType=ebook&fcis_kobo_plus=true`;
  const proxyUrl = ALLORIGINS + encodeURIComponent(koboUrl);

  const fetchSignal = (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.any([signal, AbortSignal.timeout(14000)])
    : signal;

  const resp = await fetch(proxyUrl, { signal: fetchSignal });
  if (!resp.ok) throw new Error(`proxy ${resp.status}`);

  const data = await resp.json();
  const html = data.contents || '';
  if ((data.status?.http_code ?? 200) >= 500) throw new Error('kobo error');

  // ── Pass 1: literal badge text (works when SSR includes it) ───────────────
  if (/free (?:with|on) kobo\s*plus/i.test(html)) return { status: 'found' };

  // ── Pass 2: __NEXT_DATA__ ─────────────────────────────────────────────────
  // Kobo is a Next.js app. Every SSR page contains a <script id="__NEXT_DATA__">
  // with the full data payload that React uses to hydrate the page.
  // If this tag is absent we got a bot-challenge page, not real Kobo content.
  const ndMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (!ndMatch) return { status: 'unknown' };   // blocked / not a real Kobo page

  const rawNd = ndMatch[1];

  // 2a. Search the raw JSON string for explicit Plus field names.
  //     Kobo's data model may use any of these.
  if (/koboPlus[^a-zA-Z]|"isKoboPlus"\s*:\s*true|isFreeWithSubscription|FREE_WITH_SUBSCRIPTION/i.test(rawNd)) {
    return { status: 'found' };
  }

  // 2b. We searched with fcis_kobo_plus=true, so ANY results = the book is on Plus.
  //     Parse the data and look for result counts / items arrays.
  try {
    const nd = JSON.parse(rawNd);
    const hit = findResultsInNextData(nd);
    if (hit === true)  return { status: 'found' };
    if (hit === false) return { status: 'not-found' };
  } catch { /* malformed JSON — fall through */ }

  // 2c. Fast string heuristics on the raw JSON if parsing failed
  if (/"items"\s*:\s*\[\s*\{/.test(rawNd))        return { status: 'found' };     // non-empty
  if (/"items"\s*:\s*\[\s*\]/.test(rawNd))         return { status: 'not-found' }; // empty
  if (/"totalCount"\s*:\s*0\b/.test(rawNd))        return { status: 'not-found' };
  if (/"totalCount"\s*:\s*[1-9]/.test(rawNd))      return { status: 'found' };

  // Have real Kobo HTML but genuinely can't determine
  return { status: 'unknown' };
}

/**
 * Walk the Next.js pageProps looking for search result arrays or total counts.
 * Returns true (results found), false (zero results), or null (can't tell).
 */
function findResultsInNextData(nd) {
  const pp = nd?.props?.pageProps;
  if (!pp) return null;

  // Try several common shapes Kobo might use
  for (const candidate of [
    pp.searchResults, pp.results,
    pp.data?.searchResults, pp.data,
    pp,
  ]) {
    if (!candidate || typeof candidate !== 'object') continue;

    const total = candidate.totalCount ?? candidate.ResultCount
               ?? candidate.total     ?? candidate.count;
    if (typeof total === 'number') return total > 0;

    const arr = candidate.items ?? candidate.books
             ?? candidate.Items ?? candidate.Books ?? candidate.results;
    if (Array.isArray(arr)) return arr.length > 0;
  }
  return null;
}

/* ══════════════════════════════════════════════
   GOODREADS CARD
══════════════════════════════════════════════ */
function buildGoodreadsCard(title) {
  const grSearchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(title)}`;
  const profileUrl  = grUserId ? `https://www.goodreads.com/review/list/${grUserId}` : null;

  const badge = profileUrl
    ? `<a href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener noreferrer"
          class="gr-profile-badge">My Goodreads ↗</a>`
    : `<span class="card-badge badge-personal">Personal</span>`;

  const statusArea = grUserId
    ? `<div id="gr-live-status" class="check-status checking" aria-live="polite">
         <span class="check-spinner" aria-hidden="true"></span>
         <span>Checking your Goodreads…</span>
       </div>`
    : `<div id="gr-live-status">
         <form class="gr-connect-form" id="gr-connect-form" novalidate>
           <p class="gr-connect-desc">
             Connect your Goodreads profile to automatically check whether you've read this.
           </p>
           <div class="gr-url-row">
             <input id="gr-url-input" class="gr-url-input" type="url"
                    placeholder="https://www.goodreads.com/user/show/12345"
                    value="https://www.goodreads.com/user/show/171156-amy"
                    autocomplete="url">
             <button type="submit" class="gr-connect-btn">Connect</button>
           </div>
         </form>
       </div>`;

  const footer = grUserId
    ? `<div class="card-footer-row">
         <a class="card-cta" href="${escapeAttr(grSearchUrl)}"
            target="_blank" rel="noopener noreferrer" style="--accent:${GR_ACCENT}">
           Search on Goodreads <span class="cta-arrow" aria-hidden="true">↗</span>
         </a>
         <button id="gr-disconnect-btn" class="card-cta-secondary">Disconnect</button>
       </div>`
    : `<a class="card-cta" href="${escapeAttr(grSearchUrl)}"
          target="_blank" rel="noopener noreferrer" style="--accent:${GR_ACCENT}">
         Search on Goodreads <span class="cta-arrow" aria-hidden="true">↗</span>
       </a>`;

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
          ${badge}
        </div>
        ${statusArea}
      </div>
      <div class="card-footer">${footer}</div>
    </article>`;
}

/* ══════════════════════════════════════════════
   GOODREADS LIVE CHECK
══════════════════════════════════════════════ */
async function autoCheckGoodreads(title, signal) {
  try {
    const result = await fetchGoodreadsShelf(title, grUserId, signal);
    if (signal.aborted) return;
    setGrStatus(result);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setGrStatus({ status: 'error' });
  }
}

async function fetchGoodreadsShelf(title, userId, signal) {
  const grUrl    = `https://www.goodreads.com/review/list/${userId}`
                 + `?search%5Bquery%5D=${encodeURIComponent(title)}&sort=title&order=a`;
  const proxyUrl = ALLORIGINS + encodeURIComponent(grUrl);

  const fetchSignal = (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
    : signal;

  const resp = await fetch(proxyUrl, { signal: fetchSignal });
  if (!resp.ok) throw new Error(`proxy ${resp.status}`);

  const data = await resp.json();
  const http = data.status?.http_code ?? 200;
  if (http === 401 || http === 403) return { status: 'private' };
  if (http >= 500) throw new Error(`GR ${http}`);

  return parseGoodreadsHtml(data.contents || '');
}

function parseGoodreadsHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const booksBody = doc.querySelector('#booksBody');
  if (!booksBody) return { status: 'error' };

  const rows = [...booksBody.querySelectorAll('tr.bookalike')];
  if (rows.length === 0) return { status: 'not-found' };

  const row = rows[0];

  const titleEl  = row.querySelector('.field.title .value a');
  const titleTxt = titleEl?.textContent?.trim() || '';

  const shelfLink = row.querySelector('.field.shelves .value a, .field.shelves a');
  let shelf = shelfLink?.textContent?.trim().toLowerCase()
           || (shelfLink?.href?.match(/shelf=([^&]+)/)?.[1] ?? 'read');
  if (shelf.includes('currently')) shelf = 'currently-reading';

  const starsEl = row.querySelector('.field.rating .staticStars');
  const rating  = ratingFromTitle(starsEl?.getAttribute('title') ?? '');

  const dateEl   = row.querySelector('.field.date_read .date_read_value');
  const dateText = dateEl?.textContent?.trim() || '';

  return { status: 'found', shelf, title: titleTxt, rating, dateRead: dateText };
}

function ratingFromTitle(text) {
  return { 'did not like it':1, 'it was ok':2, 'liked it':3,
           'really liked it':4, 'it was amazing':5 }[text.toLowerCase()] ?? 0;
}

function setGrStatus(result) {
  const el = document.getElementById('gr-live-status');
  if (!el) return;
  el.className = 'gr-status';

  if (result.status === 'not-found') {
    el.innerHTML = `<span class="gr-badge gr-not-found">➖ Not in your Goodreads library</span>`;
    return;
  }
  if (result.status === 'private') {
    el.innerHTML = `<span class="gr-badge gr-not-found">🔒 Profile may be private — <a href="https://www.goodreads.com/user/show/${grUserId}" target="_blank" rel="noopener">check on Goodreads</a></span>`;
    return;
  }
  if (result.status === 'error') {
    el.innerHTML = `<span class="gr-badge gr-not-found">⚠️ Couldn't check — open to verify</span>`;
    return;
  }

  const { shelf, title, rating, dateRead } = result;
  const { badgeCls, icon, label } = shelfStyle(shelf);
  const stars  = rating > 0 ? `<span class="gr-stars">${starStr(rating)}</span>` : '';
  const date   = dateRead ? `<span> · ${dateRead}</span>` : '';
  const meta   = stars || date ? `<p class="gr-meta">${stars}${date}</p>` : '';

  el.innerHTML = `
    <span class="gr-badge ${badgeCls}">${icon} ${label}</span>
    ${meta}
    ${title ? `<p class="gr-match-title">${escapeHtml(title)}</p>` : ''}`;
}

/* ══════════════════════════════════════════════
   GOODREADS CONNECT / DISCONNECT
══════════════════════════════════════════════ */
function handleGrConnect() {
  const urlInput = document.getElementById('gr-url-input');
  const raw      = urlInput?.value.trim() || '';
  const userId   = extractGrUserId(raw);

  if (!userId) {
    urlInput?.setCustomValidity('Enter a Goodreads URL, e.g. goodreads.com/user/show/12345');
    urlInput?.reportValidity();
    return;
  }
  urlInput?.setCustomValidity('');

  grUserId = userId;
  saveGrUserId(userId);

  // Swap form → spinner
  const statusEl = document.getElementById('gr-live-status');
  if (statusEl) {
    statusEl.className = 'check-status checking';
    statusEl.innerHTML = `<span class="check-spinner" aria-hidden="true"></span>
                          <span>Checking your Goodreads…</span>`;
  }

  // Swap footer → Search + Disconnect
  const footerEl = document.querySelector('#card-goodreads .card-footer');
  if (footerEl && selectedBook) {
    const grSearchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(selectedBook.title)}`;
    footerEl.innerHTML = `
      <div class="card-footer-row">
        <a class="card-cta" href="${escapeAttr(grSearchUrl)}"
           target="_blank" rel="noopener noreferrer" style="--accent:${GR_ACCENT}">
          Search on Goodreads <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
        <button id="gr-disconnect-btn" class="card-cta-secondary">Disconnect</button>
      </div>`;
  }

  // Swap badge → profile link
  const oldBadge = document.querySelector('#card-goodreads .card-badge, #card-goodreads .gr-profile-badge');
  if (oldBadge) {
    const link = document.createElement('a');
    link.href = `https://www.goodreads.com/review/list/${userId}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.className = 'gr-profile-badge'; link.textContent = 'My Goodreads ↗';
    oldBadge.replaceWith(link);
  }

  if (selectedBook) {
    grAbort?.abort();
    grAbort = new AbortController();
    autoCheckGoodreads(selectedBook.title, grAbort.signal);
  }
}

function handleGrDisconnect() {
  grUserId = null;
  clearGrUserId();
  grAbort?.abort();

  const oldCard = document.getElementById('card-goodreads');
  if (oldCard && selectedBook) {
    const tmp = document.createElement('div');
    tmp.innerHTML = buildGoodreadsCard(selectedBook.title);
    oldCard.replaceWith(tmp.firstElementChild);
  }
}

function extractGrUserId(url) {
  const m = url.match(/(?:user\/show|review\/list)\/(\d+)/) || url.match(/^(\d+)$/);
  return m ? m[1] : null;
}

function loadGrUserId()   { return localStorage.getItem(GR_USER_KEY) || null; }
function saveGrUserId(id) { try { localStorage.setItem(GR_USER_KEY, id); } catch {} }
function clearGrUserId()  { try { localStorage.removeItem(GR_USER_KEY); } catch {} }

/* ══════════════════════════════════════════════
   BOOK METADATA PANEL (for selected book)
══════════════════════════════════════════════ */
function renderBookMeta(book) {
  const coverSrc = book.cover_i
    ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg` : null;
  const title  = escapeHtml(book.title || '');
  const author = book.author_name?.length ? escapeHtml(book.author_name[0]) : null;
  const year   = book.first_publish_year || null;
  const olKey  = book.key || '';

  bookMetaEl.innerHTML = `
    <div class="book-preview">
      ${coverSrc
        ? `<img src="${escapeAttr(coverSrc)}" alt="Cover of ${title}" class="book-cover" loading="lazy" width="80">`
        : `<div class="book-cover-placeholder" aria-hidden="true">📖</div>`}
      <div class="book-details">
        <p class="book-title-meta">${title}</p>
        ${author ? `<p class="book-author-meta">by ${author}</p>` : ''}
        ${year   ? `<p class="book-year-meta">First published ${year}</p>` : ''}
        <a class="book-ol-link"
           href="https://openlibrary.org${escapeAttr(olKey)}"
           target="_blank" rel="noopener noreferrer">View on Open Library ↗</a>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */
function shelfStyle(shelf) {
  if (shelf === 'read')              return { badgeCls:'gr-read',    icon:'✅', label:'Read it!' };
  if (shelf === 'currently-reading') return { badgeCls:'gr-reading', icon:'📖', label:'Currently reading' };
  if (shelf === 'to-read')           return { badgeCls:'gr-want',    icon:'📌', label:'On your to-read list' };
  return                                    { badgeCls:'gr-want',    icon:'📚', label:'In your library' };
}

function starStr(rating) {
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
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
