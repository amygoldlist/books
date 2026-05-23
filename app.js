/**
 * MyBookFinder — app.js
 *
 * Static-only: everything runs in the browser.
 * VPL and Kobo don't expose CORS-friendly APIs, so we build
 * deep-link URLs and open them in a new tab.
 *
 * Book metadata (cover, author, year) is pulled from the free,
 * CORS-enabled Open Library Search API.
 */

'use strict';

/* ══════════════════════════════════════════════
   SOURCE DEFINITIONS
   Each source describes one "place to find a book".
   getUrl(query, searchType) must return a full URL.
══════════════════════════════════════════════ */
const SOURCES = [
  {
    id:       'vpl-physical',
    source:   'Vancouver Public Library',
    title:    'Physical Copy',
    icon:     '🏛️',
    accent:   '#1A5EA8',       // library blue
    badge:    'Free',
    badgeCls: 'badge-free',
    desc:     'Borrow a physical book from any VPL branch. Check availability and place a hold.',
    ctaLabel: 'Search VPL',
    /**
     * BiblioCommons v2 search.
     * searchType values: title | contributor | keyword
     * formatSelect_facet: BOOK filters to physical items only.
     */
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
    accent:   '#0D8A7B',       // teal
    badge:    'Free',
    badgeCls: 'badge-free',
    desc:     'Borrow a free ebook with your VPL card through the Libby app (OverDrive).',
    ctaLabel: 'Search VPL eBooks',
    /**
     * formatSelect_facet: EBOOK restricts results to digital loans.
     */
    getUrl(query, searchType) {
      const q    = encodeURIComponent(query);
      const type = searchType === 'author' ? 'contributor' : 'title';
      return `https://vpl.bibliocommons.com/v2/search?query=${q}&searchType=${type}&formatSelect_facet=EBOOK`;
    },
  },

  {
    id:       'kobo-plus',
    source:   'Kobo Plus',
    title:    'Subscription',
    icon:     '♾️',
    accent:   '#7B3FA0',       // purple
    badge:    'Subscription',
    badgeCls: 'badge-sub',
    desc:     'Included in Kobo Plus (CA)? Look for the Kobo Plus badge on the search results page.',
    ctaLabel: 'Search Kobo Plus',
    /**
     * Kobo's search URL. The `fcis_kobo_plus=true` parameter
     * filters to Kobo Plus titles where supported.
     */
    getUrl(query /*, searchType */) {
      const q = encodeURIComponent(query);
      return `https://www.kobo.com/ca/en/search?Query=${q}&MediaType=ebook&fcis_kobo_plus=true`;
    },
  },

  {
    id:       'kobo-store',
    source:   'Kobo Store',
    title:    'Buy eBook',
    icon:     '🛒',
    accent:   '#C85A00',       // warm orange
    badge:    'Paid',
    badgeCls: 'badge-paid',
    desc:     'Purchase the ebook outright from the Kobo Store — own it forever.',
    ctaLabel: 'Search Kobo Store',
    getUrl(query /*, searchType */) {
      const q = encodeURIComponent(query);
      return `https://www.kobo.com/ca/en/search?Query=${q}&MediaType=ebook`;
    },
  },
];

/* ══════════════════════════════════════════════
   DOM REFS
══════════════════════════════════════════════ */
const form        = document.getElementById('search-form');
const input       = document.getElementById('search-input');
const resultsEl   = document.getElementById('results');
const bookMetaEl  = document.getElementById('book-meta');
const cardsGridEl = document.getElementById('cards-grid');
const queryDisplay = document.getElementById('query-display');

/* ══════════════════════════════════════════════
   INIT — restore state from URL query string
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
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

  if (!query) {
    input.focus();
    return;
  }

  // Reflect in URL so the page is bookmarkable / shareable
  const params = new URLSearchParams({ q: query, type: searchType });
  history.pushState(null, '', '?' + params.toString());

  runSearch(query, searchType);
});

/* ══════════════════════════════════════════════
   MAIN SEARCH ORCHESTRATOR
══════════════════════════════════════════════ */
function runSearch(query, searchType) {
  // 1. Reveal results area
  resultsEl.hidden = false;

  // 2. Update heading
  queryDisplay.textContent = `"${query}"`;

  // 3. Render source cards immediately — no waiting for metadata
  renderCards(query, searchType);

  // 4. Async: fetch book metadata from Open Library (best-effort)
  fetchBookMeta(query, searchType);

  // 5. Scroll smoothly past the hero
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════════════════════
   RENDER SOURCE CARDS
══════════════════════════════════════════════ */
function renderCards(query, searchType) {
  cardsGridEl.innerHTML = SOURCES.map(src => buildCard(src, query, searchType)).join('');
}

function buildCard(src, query, searchType) {
  const url = src.getUrl(query, searchType);

  return `
    <article class="card" role="listitem">
      <div class="card-stripe" style="--accent: ${src.accent}"></div>
      <div class="card-body">
        <div class="card-header-row">
          <div class="card-label">
            <span class="card-icon" aria-hidden="true">${src.icon}</span>
            <div class="card-names">
              <span class="card-source" style="--accent: ${src.accent}">${src.source}</span>
              <span class="card-title">${src.title}</span>
            </div>
          </div>
          <span class="card-badge ${src.badgeCls}">${src.badge}</span>
        </div>
        <p class="card-desc">${src.desc}</p>
      </div>
      <div class="card-footer">
        <a
          class="card-cta"
          href="${escapeAttr(url)}"
          target="_blank"
          rel="noopener noreferrer"
          style="--accent: ${src.accent}"
          aria-label="${src.ctaLabel} for ${escapeAttr(query)}"
        >
          ${src.ctaLabel}
          <span class="cta-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  `;
}

/* ══════════════════════════════════════════════
   OPEN LIBRARY METADATA (optional enhancement)
   Endpoint is CORS-friendly — no proxy needed.
══════════════════════════════════════════════ */
async function fetchBookMeta(query, searchType) {
  // Show spinner
  bookMetaEl.innerHTML = `<p class="meta-loading">Looking up book info…</p>`;

  try {
    const field = searchType === 'author' ? 'author' : 'title';
    const param = searchType === 'author'
      ? `author=${encodeURIComponent(query)}`
      : `title=${encodeURIComponent(query)}`;

    const resp = await fetch(
      `https://openlibrary.org/search.json?${param}&limit=5&fields=title,author_name,cover_i,first_publish_year,key`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();

    if (data.docs && data.docs.length > 0) {
      renderBookMeta(data.docs);
    } else {
      bookMetaEl.innerHTML = '';
    }
  } catch {
    // Silently clear — the link-out cards still work fine
    bookMetaEl.innerHTML = '';
  }
}

function renderBookMeta(docs) {
  const book      = docs[0];
  const coverSrc  = book.cover_i
    ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`
    : null;
  const title     = escapeHtml(book.title || 'Unknown title');
  const author    = book.author_name ? escapeHtml(book.author_name[0]) : null;
  const year      = book.first_publish_year || null;
  const olKey     = book.key || '';

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
           target="_blank"
           rel="noopener noreferrer">
          View on Open Library ↗
        </a>
      </div>
    </div>
  `;
}

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;');
}
