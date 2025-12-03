# CLAUDE.md

## Project Overview

Chrome Extension (Manifest V3) that displays investing.com portfolio holdings on asset pages.

## Architecture

- **Service Worker** (`src/background.js`): Fetches and caches portfolio data from investing.com
- **Content Scripts**:
  - `src/panel-state.js`: State management with computed getters (totalValue, P/L)
  - `src/panel-ui.js`: Panel rendering and real-time DOM updates
  - `src/content.js`: Orchestration, navigation detection, price observer
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
  panel-state.js       # Panel state object with computed values
  panel-ui.js          # Panel rendering and DOM updates
  content.js           # Content script - orchestration
  content.css          # Panel styling
  popup.html/js/css    # Extension popup UI
```

### Content Script Load Order
Files load in manifest order (dependencies first):
1. `panel-state.js` - State object (no dependencies)
2. `panel-ui.js` - UI functions (depends on panelState)
3. `content.js` - Orchestration (depends on both)

### Real-Time Price Updates
- MutationObserver watches `[data-test="instrument-price-last"]` element
- On price change: `panelState.setCurrentPrice()` → `updatePanelUI()`
- Only Total Value and P/L update (Quantity and Avg Price are static)

## Conventions

- No build system - vanilla JavaScript
- Holdings aggregated by symbol across all portfolios
- Cache duration configurable (default 10 minutes)
- Currency symbols decoded from HTML entities (€, £, ¥, etc.)
