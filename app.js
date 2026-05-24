/**
 * MyBookFinder — app.js
 *
 * Kobo Plus:  auto-checked via api.allorigins.win CORS proxy.
 * Goodreads:  live check against the user's public shelf — no CSV needed.
 *             User enters their Goodreads profile URL once; the ID is saved
 *             to localStorage and re-used on every subsequent search.
 * Open Library: book cover / metadata (CORS-friendly, no proxy).
 * VPL + Kobo Store: deep-link URL, opens in new tab.
 */

'use strict';

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const ALLORIGINS   = 'https://api.allorigins.win/get?url=';
const GR_USER_KEY  = 'mybookfinder_gr_userid';
const GR_ACCENT    = '#7B4B00';   // warm book-brown

/* ══════════════════════════════════════════════
   SOURCE DEFINITIONS  (link-out cards)
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
let grUserId          = null;       // Goodreads numeric user ID (string)
let koboAbort         = null;       // AbortController for Kobo Plus check
let grAbort           = null;       // AbortController for Goodreads check

/* ══════════════════════════════════════════════
   DOM REFS
══════════════════════════════════════════════ */
const form         = document.getElementById('search-form');
const input        = document.getElementById('search-input');
const resultsEl    = document.getElementById('results');
const bookMetaEl   = document.getElementById('book-meta');
const cardsGridEl  = document.getElementById('cards-grid');
const queryDisplay = document.getElementById('query-display');

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  grUserId = loadGrUserId();

  // ── Event delegation for Goodreads card interactions ──
  // (card HTML is rebuilt on each search, so we delegate to the stable grid container)
  cardsGridEl.addEventListener('submit', (e) => {
    if (e.target.id === 'gr-connect-form') {
      e.preventDefault();
      handleGrConnect();
    }
  });

  cardsGridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('#gr-disconnect-btn');
    if (btn) handleGrDisconnect();
  });

  // ── Restore search from URL params ──
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
   MAIN SEARCH ORCHESTRATOR
══════════════════════════════════════════════ */
function runSearch(query, searchType) {
  currentQuery      = query;
  currentSearchType = searchType;

  // Cancel any in-flight async checks
  koboAbort?.abort();  koboAbort = new AbortController();
  grAbort?.abort();    grAbort   = new AbortController();

  resultsEl.hidden = false;
  queryDisplay.textContent = `"${query}"`;

  renderCards(query, searchType);
  fetchBookMeta(query, searchType);
  autoCheckKoboPlus(query, koboAbort.signal);
  if (grUserId) autoCheckGoodreads(query, searchType, grAbort.signal);

  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════════════════════
   RENDER CARDS
══════════════════════════════════════════════ */
function renderCards(query, searchType) {
  const sourceHTML    = SOURCES.map(src => buildCard(src, query, searchType)).join('');
  const dividerHTML   = `<div class="cards-divider" role="separator"><span>Your Library</span></div>`;
  const goodreadsHTML = buildGoodreadsCard(query);

  cardsGridEl.innerHTML = sourceHTML + dividerHTML + goodreadsHTML;
}

function buildCard(src, query, searchType) {
  const url = src.getUrl(query, searchType);

  const bodyContent = src.autoCheck
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
           target="_blank" rel="noopener noreferrer"
           style="--accent:${src.accent}">
          ${src.ctaLabel}
          <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </article>`;
}

/* ══════════════════════════════════════════════
   KOBO PLUS AUTO-CHECK
══════════════════════════════════════════════ */
async function autoCheckKoboPlus(query, signal) {
  try {
    const result = await fetchKoboData(query, signal);
    if (signal.aborted) return;

    if      (result.status === 'found')
      setKoboStatus('found',     '✅ Free on Kobo Plus!');
    else if (result.status === 'not-found')
      setKoboStatus('not-found', '❌ Not on Kobo Plus');
    else
      setKoboStatus('unknown',   '⚠️ Couldn\'t check — open to verify');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setKoboStatus('unknown', '⚠️ Couldn\'t auto-check — open to verify');
  }
}

function setKoboStatus(cls, message) {
  const el = document.getElementById('kobo-plus-status');
  if (!el) return;
  el.className = `check-status ${cls}`;
  el.innerHTML = `<span class="check-icon" aria-hidden="true">${message.slice(0, 2)}</span>`
               + `<span>${message.slice(2).trimStart()}</span>`;
}

async function fetchKoboData(query, signal) {
  const koboUrl  = `https://www.kobo.com/ca/en/search?Query=${encodeURIComponent(query)}&MediaType=ebook&fcis_kobo_plus=true`;
  const proxyUrl = ALLORIGINS + encodeURIComponent(koboUrl);

  const fetchSignal = (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.any([signal, AbortSignal.timeout(14000)])
    : signal;

  const resp = await fetch(proxyUrl, { signal: fetchSignal });
  if (!resp.ok) throw new Error(`proxy ${resp.status}`);

  const data = await resp.json();
  const html = data.contents || '';
  if ((data.status?.http_code ?? 200) >= 500) throw new Error('kobo server error');

  // Kobo renders "or free on Kobo Plus" / "FREE with Kobo Plus" on every Plus title card.
  // That phrase is the definitive signal — if it's in the page, the book is on Plus.
  if (/free (?:on|with) kobo plus/i.test(html)) {
    return { status: 'found' };
  }

  // Got a real page back but no Plus phrase → not in the subscription.
  if (html.length > 5000) {
    return { status: 'not-found' };
  }

  // Very short / empty response — proxy may have failed.
  return { status: 'unknown' };
}

/* ══════════════════════════════════════════════
   GOODREADS CARD
══════════════════════════════════════════════ */
function buildGoodreadsCard(query) {
  const grSearchUrl  = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}`;
  const profileUrl   = grUserId ? `https://www.goodreads.com/review/list/${grUserId}` : null;

  const badge = profileUrl
    ? `<a href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener noreferrer"
          class="gr-profile-badge" title="Your Goodreads shelf">My Goodreads ↗</a>`
    : `<span class="card-badge badge-personal">Personal</span>`;

  // Status area — spinner if connected (live check will update it), form if not
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

  const footerContent = grUserId
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
      <div class="card-footer">${footerContent}</div>
    </article>`;
}

/* ══════════════════════════════════════════════
   GOODREADS LIVE CHECK
   Fetches the user's shelf filtered by search query via CORS proxy.
   Goodreads shelf list is server-rendered (Rails app) — no JS needed.
══════════════════════════════════════════════ */
async function autoCheckGoodreads(query, searchType, signal) {
  try {
    const result = await fetchGoodreadsShelf(query, grUserId, signal);
    if (signal.aborted) return;
    setGrStatus(result);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setGrStatus({ status: 'error', message: err.message });
  }
}

/**
 * Fetch the user's Goodreads shelf searched by query, parse the result.
 * URL format: /review/list/USER_ID?search%5Bquery%5D=QUERY
 * Returns {status:'found'|'not-found'|'error'|'private', shelf?, title?, rating?, dateRead?}
 */
async function fetchGoodreadsShelf(query, userId, signal) {
  const grUrl    = `https://www.goodreads.com/review/list/${userId}`
                 + `?search%5Bquery%5D=${encodeURIComponent(query)}&sort=title&order=a`;
  const proxyUrl = ALLORIGINS + encodeURIComponent(grUrl);

  const fetchSignal = (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
    : signal;

  const resp = await fetch(proxyUrl, { signal: fetchSignal });
  if (!resp.ok) throw new Error(`proxy ${resp.status}`);

  const data = await resp.json();
  const http  = data.status?.http_code ?? 200;
  const html  = data.contents || '';

  if (http === 401 || http === 403) return { status: 'private' };
  if (http >= 500) throw new Error(`Goodreads ${http}`);

  return parseGoodreadsHtml(html);
}

function parseGoodreadsHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // The reading list table
  const booksBody = doc.querySelector('#booksBody');
  if (!booksBody) {
    // Could be a login redirect or a profile that has the list hidden
    return { status: 'error', message: 'Could not read shelf — profile may be private' };
  }

  const rows = [...booksBody.querySelectorAll('tr.bookalike')];
  if (rows.length === 0) return { status: 'not-found' };

  // Take the first (best-ranked by Goodreads search) result
  const row = rows[0];

  // Title
  const titleEl  = row.querySelector('.field.title .value a');
  const titleText = titleEl?.textContent?.trim() || '';

  // Shelf — look for a link like /review/list/xxx?shelf=read
  const shelfLink = row.querySelector('.field.shelves .value a, .field.shelves a');
  let shelf = shelfLink?.textContent?.trim().toLowerCase()
           || (shelfLink?.href?.match(/shelf=([^&]+)/)?.[1] ?? 'read');
  if (shelf.includes('currently')) shelf = 'currently-reading';

  // Rating — staticStars title attribute → numeric
  const starsEl = row.querySelector('.field.rating .staticStars');
  const rating  = ratingFromTitle(starsEl?.getAttribute('title') ?? '');

  // Date read
  const dateEl   = row.querySelector('.field.date_read .date_read_value');
  const dateText = dateEl?.textContent?.trim() || '';

  return { status: 'found', shelf, title: titleText, rating, dateRead: dateText };
}

/** Maps Goodreads star-title strings to 1–5, or 0 if unrated. */
function ratingFromTitle(text) {
  return { 'did not like it': 1, 'it was ok': 2, 'liked it': 3,
           'really liked it': 4, 'it was amazing': 5 }[text.toLowerCase()] ?? 0;
}

/** Update the #gr-live-status element in place (no full card rebuild). */
function setGrStatus(result) {
  const el = document.getElementById('gr-live-status');
  if (!el) return;

  el.className = 'gr-status';  // clear spinner classes

  if (result.status === 'not-found') {
    el.innerHTML = `<span class="gr-badge gr-not-found">➖ Not in your Goodreads library</span>`;
    return;
  }

  if (result.status === 'private') {
    el.innerHTML = `<span class="gr-badge gr-not-found">🔒 Profile appears private — <a href="https://www.goodreads.com/user/show/${grUserId}" target="_blank" rel="noopener">check on Goodreads</a></span>`;
    return;
  }

  if (result.status === 'error') {
    el.innerHTML = `<span class="gr-badge gr-not-found">⚠️ Couldn't check — open to verify</span>`;
    return;
  }

  // Found!
  const { shelf, title, rating, dateRead } = result;
  const { badgeCls, icon, label } = shelfStyle(shelf);

  const stars   = rating > 0 ? `<span class="gr-stars">${starStr(rating)}</span>` : '';
  const dateTxt = dateRead ? ` · ${dateRead}` : '';
  const meta    = stars || dateTxt ? `<p class="gr-meta">${stars}${dateTxt}</p>` : '';

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
  const raw = urlInput?.value.trim() || '';

  const userId = extractGrUserId(raw);
  if (!userId) {
    urlInput?.focus();
    urlInput?.select();
    // Show a brief shake / validation hint
    urlInput?.setCustomValidity('Enter a Goodreads profile URL, e.g. goodreads.com/user/show/12345');
    urlInput?.reportValidity();
    return;
  }
  urlInput?.setCustomValidity('');

  grUserId = userId;
  saveGrUserId(userId);

  // Swap the form for a spinner immediately
  const statusEl = document.getElementById('gr-live-status');
  if (statusEl) {
    statusEl.className = 'check-status checking';
    statusEl.innerHTML = `<span class="check-spinner" aria-hidden="true"></span>
                          <span>Checking your Goodreads…</span>`;
  }

  // Swap footer to show Search + Disconnect buttons
  const footerEl = document.querySelector('#card-goodreads .card-footer');
  if (footerEl && currentQuery) {
    const grSearchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(currentQuery)}`;
    footerEl.innerHTML = `
      <div class="card-footer-row">
        <a class="card-cta" href="${escapeAttr(grSearchUrl)}"
           target="_blank" rel="noopener noreferrer" style="--accent:${GR_ACCENT}">
          Search on Goodreads <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
        <button id="gr-disconnect-btn" class="card-cta-secondary">Disconnect</button>
      </div>`;
  }

  // Update the badge to a profile link
  const oldBadge = document.querySelector('#card-goodreads .card-badge, #card-goodreads .gr-profile-badge');
  if (oldBadge) {
    const profileUrl = `https://www.goodreads.com/review/list/${userId}`;
    const link = document.createElement('a');
    link.href = profileUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.className = 'gr-profile-badge'; link.textContent = 'My Goodreads ↗';
    oldBadge.replaceWith(link);
  }

  // Kick off the live check
  if (currentQuery) {
    grAbort?.abort();
    grAbort = new AbortController();
    autoCheckGoodreads(currentQuery, currentSearchType, grAbort.signal);
  }
}

function handleGrDisconnect() {
  grUserId = null;
  clearGrUserId();
  grAbort?.abort();

  // Rebuild just the Goodreads card
  const oldCard = document.getElementById('card-goodreads');
  if (oldCard && currentQuery) {
    const tmp = document.createElement('div');
    tmp.innerHTML = buildGoodreadsCard(currentQuery);
    oldCard.replaceWith(tmp.firstElementChild);
    // Event delegation handles the reconnect form automatically
  }
}

/** Extract numeric user ID from any Goodreads URL format. */
function extractGrUserId(url) {
  // https://www.goodreads.com/user/show/171156-amy
  // https://www.goodreads.com/review/list/171156
  // 171156  (bare ID)
  const m = url.match(/(?:user\/show|review\/list)\/(\d+)/) || url.match(/^(\d+)$/);
  return m ? m[1] : null;
}

function loadGrUserId()      { return localStorage.getItem(GR_USER_KEY) || null; }
function saveGrUserId(id)    { try { localStorage.setItem(GR_USER_KEY, id); } catch {} }
function clearGrUserId()     { try { localStorage.removeItem(GR_USER_KEY); } catch {} }

/* ══════════════════════════════════════════════
   OPEN LIBRARY METADATA
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
    if (!resp.ok) throw new Error();
    const data = await resp.json();
    if (data.docs?.length > 0) renderBookMeta(data.docs[0]);
    else bookMetaEl.innerHTML = '';
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
  if (shelf === 'read')              return { badgeCls: 'gr-read',    icon: '✅', label: 'Read it!' };
  if (shelf === 'currently-reading') return { badgeCls: 'gr-reading', icon: '📖', label: 'Currently reading' };
  if (shelf === 'to-read')           return { badgeCls: 'gr-want',    icon: '📌', label: 'On your to-read list' };
  return                                    { badgeCls: 'gr-want',    icon: '📚', label: 'In your library' };
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
