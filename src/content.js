// Portfolio Overlay Content Script - Orchestration
// Dependencies: panel-state.js, panel-ui.js (loaded before this file)

let currentSymbol = null;
let isInitialized = false;
let priceObserver = null;

// Main initialization
async function init() {
  const settings = await getSettings();
  const pathname = window.location.pathname;

  const isMonitored = settings.monitoredPaths.some(path => pathname.startsWith(path));

  // Remove existing panel if navigating away from monitored page or to different stock
  removeExistingPanel();

  if (!isMonitored) {
    currentSymbol = null;
    return;
  }

  // Extract asset info from page
  const assetInfo = extractAssetInfo();
  if (!assetInfo || !assetInfo.symbol) {
    currentSymbol = null;
    return;
  }

  // Skip if same symbol (already showing)
  if (assetInfo.symbol === currentSymbol && document.getElementById('portfolio-overlay-panel')) {
    return;
  }

  currentSymbol = assetInfo.symbol;

  // Request portfolio data from background
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_PORTFOLIO_DATA',
      symbol: assetInfo.symbol,
      isin: assetInfo.isin,
      pairId: assetInfo.pairId
    });

    if (response.error) {
      return;
    }

    if (response.match) {
      injectHoldingsPanel(response.match, assetInfo);
      setupPriceObserver();
    }
  } catch (err) {
    // Silently handle errors
  }
}

// Helper: Get settings from storage
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['settings'], data => {
      resolve(data.settings || {
        cacheDurationMinutes: 10,
        monitoredPaths: ['/equities/', '/etfs/']
      });
    });
  });
}

// Extract asset information from the page
function extractAssetInfo() {
  // Try to get data from global-translation-variables meta tag
  const meta = document.querySelector('meta[name="global-translation-variables"]');
  if (meta) {
    try {
      // The content is a JSON string wrapped in quotes
      let content = meta.getAttribute('content');
      // Remove outer quotes if present
      if (content.startsWith('"') && content.endsWith('"')) {
        content = content.slice(1, -1);
      }
      // Unescape the JSON string
      content = content.replace(/\\"/g, '"');
      const data = JSON.parse(content);

      return {
        symbol: data.SYMBOL || null,
        isin: data.ISIN || null,
        fullName: data.FULL_NAME || data.SHORT_NAME || null,
        lastPrice: data.LAST_PRICE || null,
        pairId: null
      };
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Fallback: try to extract from structured data
  const structuredData = document.querySelector('script[type="application/ld+json"]#structured_data');
  if (structuredData) {
    try {
      const data = JSON.parse(structuredData.textContent);
      if (data.tickersymbol) {
        return {
          symbol: data.tickersymbol,
          isin: null,
          fullName: data.legalname || null,
          lastPrice: null,
          pairId: null
        };
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  return null;
}

// Set up observer for real-time price changes
function setupPriceObserver() {
  // Disconnect existing observer if any
  if (priceObserver) {
    priceObserver.disconnect();
    priceObserver = null;
  }

  const priceElement = document.querySelector('[data-test="instrument-price-last"]');
  if (!priceElement) {
    console.log('[Portfolio Overlay] Price element not found');
    return;
  }

  priceObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData' || mutation.type === 'childList') {
        const newPrice = parsePrice(priceElement.textContent.trim());
        if (newPrice && newPrice !== panelState.currentPrice) {
          panelState.setCurrentPrice(newPrice);
          updatePanelUI();
        }
      }
    }
  });

  // Observe text content changes
  priceObserver.observe(priceElement, {
    characterData: true,
    childList: true,
    subtree: true
  });
}

// Listen for URL changes (client-side navigation)
function setupNavigationListener() {
  // Watch for URL changes using History API
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    setTimeout(init, 100); // Small delay to let page update
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    setTimeout(init, 100);
  };

  // Listen for popstate (back/forward navigation)
  window.addEventListener('popstate', () => {
    setTimeout(init, 100);
  });

  // Also observe DOM changes for SPA navigation
  const observer = new MutationObserver((mutations) => {
    // Check if the meta tag changed (indicates new page data)
    const meta = document.querySelector('meta[name="global-translation-variables"]');
    if (meta) {
      const newSymbol = extractSymbolFromMeta(meta);
      if (newSymbol && newSymbol !== currentSymbol) {
        setTimeout(init, 100);
      }
    }
  });

  // Observe head for meta tag changes
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['content']
  });
}

// Quick extract symbol from meta without full parsing
function extractSymbolFromMeta(meta) {
  try {
    let content = meta.getAttribute('content');
    const symbolMatch = content.match(/SYMBOL[^:]*:\s*\\?"([^"\\]+)/i);
    return symbolMatch ? symbolMatch[1] : null;
  } catch {
    return null;
  }
}

// Initialize
if (!isInitialized) {
  isInitialized = true;
  setupNavigationListener();
  init();
}
