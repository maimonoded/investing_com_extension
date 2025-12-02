# CLAUDE.md

## Project Overview

Chrome Extension (Manifest V3) that displays investing.com portfolio holdings on asset pages.

## Architecture

- **Service Worker** (`src/background.js`): Fetches and caches portfolio data from investing.com
- **Content Script** (`src/content.js`): Injects holdings panel on asset pages
- **Popup** (`src/popup.html`, `src/popup.js`): Settings and manual refresh

## Key Technical Details

### Portfolio Fetching
- Portfolio tabs have `data-publicid` attribute (URL-encoded base64) inside `<li class="portfolioTab">`
- Holdings portfolios identified by `positionIcon` class (vs `watchlistIcon` for watchlists)
- Each portfolio fetched via `https://www.investing.com/portfolio/?portfolioID={publicId}`
- Holdings parsed from `<tr class="openPositionTR">` rows using regex (no DOMParser in service workers)

### Data Attributes on Holdings Rows
- `data-amount`: quantity
- `data-open-price`: average buy price
- `data-commission-cur`: currency symbol (HTML entity encoded)
- `data-pair-id`: asset identifier
- `data-portfolio`: numeric portfolio ID

### Asset Page Detection
- Symbol extracted from `<meta name="global-translation-variables">` JSON content
- Falls back to structured data `<script type="application/ld+json">`

## File Structure

```
manifest.json          # Extension manifest (v3)
src/
  background.js        # Service worker - portfolio fetching/caching
  content.js           # Content script - panel injection
  content.css          # Panel styling
  popup.html/js/css    # Extension popup UI
```

## Conventions

- No build system - vanilla JavaScript
- Holdings aggregated by symbol across all portfolios
- Cache duration configurable (default 10 minutes)
- Currency symbols decoded from HTML entities (€, £, ¥, etc.)
