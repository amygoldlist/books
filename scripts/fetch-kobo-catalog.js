#!/usr/bin/env node
'use strict';
/**
 * scripts/fetch-kobo-catalog.js
 *
 * Builds kobo-plus.json — a catalog of books confirmed to be on Kobo Plus
 * (Canada, English). Uses curl directly, which bypasses Cloudflare's bot
 * protection that blocks Node.js fetch and the allorigins CORS proxy.
 *
 * How it works:
 *   Kobo's search stores data in a <script id="__NEXT_DATA__"> tag.
 *   Each result item has a Book.ApplicableSubscriptions array that is
 *   non-empty if and only if the book is available on a Kobo Plus plan.
 *   We search letter-by-letter (a-z), check that field, and save confirmed
 *   Plus titles to kobo-plus.json.
 *
 * Usage:
 *   node scripts/fetch-kobo-catalog.js
 *
 * Requirements:
 *   Node.js 18+  +  curl (comes with macOS/Linux; Windows 10+ has it too)
 *
 * Output:
 *   kobo-plus.json in the project root
 *   Commit + push → GitHub Pages serves it → app uses it for instant lookups
 *
 * Re-run every few weeks to pick up newly added Plus titles.
 */

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

const OUT_FILE       = path.resolve(__dirname, '..', 'kobo-plus.json');
const ITEMS_PER_PAGE = 12;
const DELAY_MS       = 1100;  // between requests — be polite
const MAX_PAGES      = 200;   // per letter (covers 2 400 books/letter)
const STOP_AFTER     = 5;     // consecutive pages with 0 Plus books → move on

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Normalise title — must match app.js normTitle() exactly. */
function normalize(title) {
  return title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fetch one Kobo search page via curl (bypasses Cloudflare TLS fingerprinting).
 * Returns the parsed __NEXT_DATA__ pageProps, or null on failure.
 */
function curlPage(query, pageNum) {
  const params = new URLSearchParams({
    Query:       query,
    MediaType:   'ebook',
    AccessType:  'Subscription',   // most reliable filter for Plus books
    PageNumber:  String(pageNum),
  });
  const url = `https://www.kobo.com/ca/en/search?${params}`;

  // Build curl command. -s = silent, --compressed = accept gzip,
  // --max-time 20 = timeout, -L = follow redirects.
  const cmd = [
    'curl', '-s', '--compressed', '--max-time', '20', '-L',
    '-H', `"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"`,
    '-H', `"Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"`,
    '-H', `"Accept-Language: en-CA,en;q=0.9"`,
    `"${url}"`,
  ].join(' ');

  try {
    const html = execSync(cmd, { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

    // Cloudflare challenge? (JS challenge, not real page)
    if (html.includes('Just a moment') || html.includes('cf-browser-verification')) {
      return { blocked: true };
    }

    const ndMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!ndMatch) return { error: 'no __NEXT_DATA__' };

    const nd  = JSON.parse(ndMatch[1]);
    const ssr = nd?.props?.pageProps?.searchResultSSR;
    if (!ssr) return { error: 'no searchResultSSR' };

    return {
      items:      ssr.Items || [],
      totalItems: ssr.TotalItemCount  || 0,
      totalPages: ssr.TotalPageCount  || 0,
    };
  } catch (err) {
    return { error: err.message.slice(0, 80) };
  }
}

/**
 * Extract books that are confirmed on Kobo Plus from a page result.
 * Book.ApplicableSubscriptions is non-null/non-empty iff on Plus.
 */
function extractPlusBooks(items) {
  const plus = [];
  for (const it of items) {
    const book = it.Book;
    if (!book?.Title) continue;
    const subs = book.ApplicableSubscriptions;
    if (Array.isArray(subs) && subs.length > 0) {
      plus.push(book.Title.trim());
    }
  }
  return plus;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify curl exists
  try {
    execSync('curl --version', { stdio: 'ignore' });
  } catch {
    console.error('❌  curl not found. Please install curl and re-run.');
    process.exit(1);
  }

  console.log('📚  Building Kobo Plus catalog (Canada / English)\n');
  console.log('    Detection: Book.ApplicableSubscriptions (non-empty = Plus)');
  console.log(`    Strategy:  A–Z letter sweep, up to ${MAX_PAGES} pages/letter\n`);

  const catalog = new Map();   // normalizedTitle → displayTitle

  for (const letter of 'abcdefghijklmnopqrstuvwxyz0123456789') {
    let page        = 1;
    let emptyRun    = 0;    // consecutive pages with 0 Plus books
    let addedLetter = 0;

    while (page <= MAX_PAGES) {
      process.stdout.write(`  "${letter}" p${page} … `);
      const result = curlPage(letter, page);

      if (result.blocked) {
        process.stdout.write('⛔ Cloudflare blocked — pausing 30 s\n');
        await sleep(30_000);
        // retry once
        const retry = curlPage(letter, page);
        if (retry.blocked) {
          console.error('\n⛔  Still blocked after retry. Stopping.');
          console.error('    Workaround: export Kobo cookies and set KOBO_COOKIE env var,');
          console.error('    or run from a different network/IP.\n');
          writeCatalog(catalog);
          return;
        }
        Object.assign(result, retry);
      }

      if (result.error) {
        process.stdout.write(`error: ${result.error}\n`);
        emptyRun++;
        if (emptyRun >= STOP_AFTER) break;
        await sleep(DELAY_MS);
        page++;
        continue;
      }

      const plusBooks = extractPlusBooks(result.items);

      let added = 0;
      for (const title of plusBooks) {
        const norm = normalize(title);
        if (!catalog.has(norm)) { catalog.set(norm, title); added++; addedLetter++; }
      }

      const nonPlus = result.items.length - plusBooks.length;
      process.stdout.write(
        `${result.items.length} items → +${added} Plus, ${nonPlus} paid`
        + `  (catalog: ${catalog.size})\n`
      );

      emptyRun = (plusBooks.length === 0) ? emptyRun + 1 : 0;

      if (emptyRun >= STOP_AFTER) {
        process.stdout.write(`    (${STOP_AFTER} consecutive pages with no Plus books → next letter)\n`);
        break;
      }

      // Stop if we've scanned all pages for this letter
      if (page >= (result.totalPages || MAX_PAGES)) break;

      page++;
      await sleep(DELAY_MS + Math.random() * 400);
    }

    console.log(`  ✓  "${letter}" done: +${addedLetter} new Plus titles\n`);
    await sleep(2000 + Math.random() * 1000);
  }

  writeCatalog(catalog);
}

function writeCatalog(catalog) {
  if (catalog.size === 0) {
    console.error('\n⚠️  No Plus books found — nothing written.');
    console.error('    Kobo may have blocked all requests, or the structure changed.');
    process.exit(1);
  }

  const output = {
    updated: new Date().toISOString().slice(0, 10),
    count:   catalog.size,
    // Sorted array of [normalizedTitle, displayTitle]
    // App loads normalizedTitle into a Set for O(1) lookups.
    titles: [...catalog.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([norm]) => norm),    // store only normalized form; display title used only in script logs
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);

  console.log(`\n✅  Wrote ${catalog.size} confirmed Kobo Plus titles → kobo-plus.json (${kb} KB raw)`);
  console.log('    git add kobo-plus.json && git commit -m "chore: refresh Kobo Plus catalog" && git push');
  console.log('    GitHub Pages will serve the updated file automatically.\n');
  console.log('    Tip: re-run every 2–4 weeks to pick up new Plus titles.');
}

main().catch(err => { console.error('\n💥', err.message); process.exit(1); });
