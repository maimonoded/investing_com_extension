// Portfolio Overlay Content Script
(function() {
  'use strict';

  let currentSymbol = null;
  let isInitialized = false;

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
        console.error('Portfolio Overlay Error:', response.error);
        return;
      }

      if (response.match) {
        injectHoldingsPanel(response.match, assetInfo);
      }
    } catch (err) {
      console.error('Portfolio Overlay Error:', err);
    }
  }

  // Remove existing panel
  function removeExistingPanel() {
    const existingPanel = document.getElementById('portfolio-overlay-panel');
    if (existingPanel) {
      existingPanel.remove();
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
        console.error('Failed to parse asset meta:', err);
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

  // Inject the holdings panel into the page
  function injectHoldingsPanel(holding, assetInfo) {
    // Remove any existing panel first
    removeExistingPanel();

    // Create panel element
    const panel = document.createElement('div');
    panel.id = 'portfolio-overlay-panel';
    panel.className = 'portfolio-overlay-panel';

    // Format values
    const qty = holding.qty?.toLocaleString() || '0';
    const avgPrice = formatCurrency(holding.avgPrice);
    const currentPrice = assetInfo.lastPrice ? parseFloat(assetInfo.lastPrice) : null;

    // Calculate total value from current price if available, otherwise use stored value
    let totalValue = holding.totalValue;
    if (currentPrice && holding.qty) {
      totalValue = currentPrice * holding.qty;
    }
    const totalValueFormatted = formatCurrency(totalValue);

    // Calculate P/L if we have current price
    let plHtml = '';
    if (currentPrice && holding.avgPrice) {
      const pl = (currentPrice - holding.avgPrice) * holding.qty;
      const plPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
      const plClass = pl >= 0 ? 'positive' : 'negative';
      const plSign = pl >= 0 ? '+' : '';
      plHtml = `
        <div class="portfolio-overlay-item">
          <span class="portfolio-overlay-label">P/L</span>
          <span class="portfolio-overlay-value ${plClass}">${plSign}${formatCurrency(pl)} (${plSign}${plPercent.toFixed(2)}%)</span>
        </div>
      `;
    }

    panel.innerHTML = `
      <div class="portfolio-overlay-header">
        <span class="portfolio-overlay-title">Your Position</span>
      </div>
      <div class="portfolio-overlay-content">
        <div class="portfolio-overlay-item">
          <span class="portfolio-overlay-label">Quantity</span>
          <span class="portfolio-overlay-value">${qty}</span>
        </div>
        <div class="portfolio-overlay-item">
          <span class="portfolio-overlay-label">Avg. Buy Price</span>
          <span class="portfolio-overlay-value">${avgPrice}</span>
        </div>
        <div class="portfolio-overlay-item">
          <span class="portfolio-overlay-label">Total Value</span>
          <span class="portfolio-overlay-value">${totalValueFormatted}</span>
        </div>
        ${plHtml}
      </div>
    `;

    // Find insertion point - after the instrument header details (next to price/company name)
    const headerDetails = document.querySelector('[data-test="instrument-header-details"]');
    if (headerDetails) {
      headerDetails.appendChild(panel);
      return;
    }

    // Fallback: after price section
    const priceContainer = document.querySelector('[data-test="instrument-price-last"]');
    if (priceContainer) {
      const parent = priceContainer.closest('div')?.parentElement;
      if (parent) {
        parent.appendChild(panel);
        return;
      }
    }

    // Second fallback: find price class
    const priceClass = document.querySelector('.instrument-price_instrument-price__2w9MW');
    if (priceClass) {
      const parent = priceClass.closest('div')?.parentElement;
      if (parent) {
        parent.appendChild(panel);
        return;
      }
    }

    // Last resort: insert after h1
    const h1 = document.querySelector('h1');
    if (h1) {
      const parent = h1.closest('div')?.parentElement;
      if (parent) {
        parent.appendChild(panel);
        return;
      }
    }
  }

  // Format number as currency
  function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) {
      return '-';
    }
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
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
})();
