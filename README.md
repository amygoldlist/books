# MyBookFinder

A personal static web app that lets you search for any book and instantly check its availability across three sources.

**Live:** https://amygoldlist.github.io/books

## What it checks

| Source | What it checks | How |
|--------|---------------|-----|
| **Vancouver Public Library** | Physical copy | Deep-links to BiblioCommons (physical filter) |
| **VPL via Libby** | Free ebook borrow | Deep-links to BiblioCommons (ebook filter) |
| **Kobo Plus** | Included in subscription? | Deep-links to Kobo search (Plus filter) |
| **Kobo Store** | Price / buy ebook | Deep-links to Kobo Store search |

Because everything is static (no backend), results open in a new tab on the relevant platform. Book metadata (cover, author, year) is fetched client-side from the free [Open Library API](https://openlibrary.org/developers).

## Tech stack

- Plain HTML + CSS + vanilla JavaScript — no frameworks, no build step
- Deployed via **GitHub Pages** (repo root, `main` branch)

## File structure

```
books/
├── index.html   – markup & layout
├── style.css    – olive-green book theme, responsive grid
├── app.js       – search logic, URL builders, Open Library fetch
└── README.md
```

## Local development

Open `index.html` directly in a browser — no install or server required.

## GitHub Pages setup

**Settings → Pages → Source:** `Deploy from a branch` → `main` / `/ (root)`
