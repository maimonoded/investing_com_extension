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
        return;
      }

      if (response.match) {
        injectHoldingsPanel(response.match, assetInfo);
      }
    } catch (err) {
      // Silently handle errors
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

  // Inject the holdings panel into the page
  function injectHoldingsPanel(holding, assetInfo) {
    // Remove any existing panel first
    removeExistingPanel();

    // Create panel element
    const panel = document.createElement('div');
    panel.id = 'portfolio-overlay-panel';
    panel.className = 'portfolio-overlay-panel';

    // Get currency from holding data
    const currency = holding.currency || '$';

    // Format values
    const qty = holding.qty?.toLocaleString() || '0';
    const avgPriceFormatted = formatCurrency(holding.avgPrice, currency);

    // Get current price from page (live) or fall back to meta tag
    let currentPrice = getCurrentPriceFromPage();
    if (!currentPrice) {
      currentPrice = assetInfo.lastPrice ? parseFloat(assetInfo.lastPrice) : null;
    }

    // Calculate total value from current price if available, otherwise use stored value
    let totalValue = holding.totalValue;
    if (currentPrice && holding.qty) {
      totalValue = currentPrice * holding.qty;
    }
    const totalValueFormatted = formatCurrency(totalValue, currency);

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
          <span class="portfolio-overlay-value ${plClass}">${plSign}${formatCurrency(pl, currency)} (${plSign}${plPercent.toFixed(2)}%)</span>
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
          <span class="portfolio-overlay-value">${avgPriceFormatted}</span>
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

  // Get current price from page
  function getCurrentPriceFromPage() {
    // Try the data-test attribute first
    const priceEl = document.querySelector('[data-test="instrument-price-last"]');
    if (priceEl) {
      const priceText = priceEl.textContent.trim();
      return parsePrice(priceText);
    }

    // Fallback: look for price in other common selectors
    const altPriceEl = document.querySelector('.instrument-price_instrument-price__2w9MW [data-test="instrument-price-last"]');
    if (altPriceEl) {
      return parsePrice(altPriceEl.textContent.trim());
    }

    return null;
  }

  // Parse price string to number
  function parsePrice(priceStr) {
    if (!priceStr) return null;
    // Remove currency symbols, commas, spaces
    const cleaned = priceStr.replace(/[^0-9.-]/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? null : price;
  }

  // Decode HTML entities (in case storage has encoded values)
  function decodeHtmlEntities(str) {
    if (!str) return str;
    const entities = {
      '&#x20ac;': '€',
      '&euro;': '€',
      '&#x24;': '$',
      '&#36;': '$',
      '&#x00a3;': '£',
      '&pound;': '£',
      '&#x00a5;': '¥',
      '&yen;': '¥'
    };
    let result = str;
    for (const [entity, char] of Object.entries(entities)) {
      result = result.replace(new RegExp(entity, 'gi'), char);
    }
    // Handle remaining numeric entities
    result = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
    return result;
  }

  // Map currency symbols to ISO codes
  function getCurrencyCode(symbol) {
    // Decode HTML entities first
    const decoded = decodeHtmlEntities(symbol);
    const currencyMap = {
      '$': 'USD',
      'C$': 'CAD',
      '€': 'EUR',
      '£': 'GBP',
      '¥': 'JPY',
      'CHF': 'CHF',
      'A$': 'AUD',
      'NZ$': 'NZD',
      'HK$': 'HKD',
      'S$': 'SGD',
      '₹': 'INR',
      '₪': 'ILS',
      'kr': 'SEK',  // Could also be NOK/DKK
      'zł': 'PLN',
      'R$': 'BRL',
      '₩': 'KRW'
    };
    return currencyMap[decoded] || 'USD';
  }

  // Format number as currency
  function formatCurrency(value, currencySymbol = '$') {
    if (value === null || value === undefined || isNaN(value)) {
      return '-';
    }
    const currencyCode = getCurrencyCode(currencySymbol);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
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
