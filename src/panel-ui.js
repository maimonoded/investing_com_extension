// Panel UI - Rendering and DOM updates

// Remove existing panel and reset state
function removeExistingPanel() {
  const existingPanel = document.getElementById('portfolio-overlay-panel');
  if (existingPanel) {
    existingPanel.remove();
  }
  panelState.reset();
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
    '&#x20ac;': '\u20ac',
    '&euro;': '\u20ac',
    '&#x24;': '$',
    '&#36;': '$',
    '&#x00a3;': '\u00a3',
    '&pound;': '\u00a3',
    '&#x00a5;': '\u00a5',
    '&yen;': '\u00a5'
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
    '\u20ac': 'EUR',
    '\u00a3': 'GBP',
    '\u00a5': 'JPY',
    'CHF': 'CHF',
    'A$': 'AUD',
    'NZ$': 'NZD',
    'HK$': 'HKD',
    'S$': 'SGD',
    '\u20b9': 'INR',
    '\u20aa': 'ILS',
    'kr': 'SEK',
    'z\u0142': 'PLN',
    'R$': 'BRL',
    '\u20a9': 'KRW'
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

// Create the panel DOM element
function createPanelElement() {
  const panel = document.createElement('div');
  panel.id = 'portfolio-overlay-panel';
  panel.className = 'portfolio-overlay-panel';

  const currency = panelState.holding.currency || '$';
  const qty = panelState.holding.qty?.toLocaleString() || '0';
  const avgPriceFormatted = formatCurrency(panelState.holding.avgPrice, currency);
  const totalValueFormatted = formatCurrency(panelState.totalValue, currency);

  // Build P/L HTML
  let plHtml = '';
  if (panelState.pl !== null) {
    const plClass = panelState.pl >= 0 ? 'positive' : 'negative';
    const plSign = panelState.pl >= 0 ? '+' : '';
    plHtml = `
      <div class="portfolio-overlay-item">
        <span class="portfolio-overlay-label">P/L</span>
        <span id="panel-pl" class="portfolio-overlay-value ${plClass}">${plSign}${formatCurrency(panelState.pl, currency)} (${plSign}${panelState.plPercent.toFixed(2)}%)</span>
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
        <span id="panel-total-value" class="portfolio-overlay-value">${totalValueFormatted}</span>
      </div>
      ${plHtml}
    </div>
  `;

  return panel;
}

// Insert panel into page (try multiple locations)
function insertPanel(panel) {
  // Find insertion point - after the instrument header details (next to price/company name)
  const headerDetails = document.querySelector('[data-test="instrument-header-details"]');
  if (headerDetails) {
    headerDetails.appendChild(panel);
    return true;
  }

  // Fallback: after price section
  const priceContainer = document.querySelector('[data-test="instrument-price-last"]');
  if (priceContainer) {
    const parent = priceContainer.closest('div')?.parentElement;
    if (parent) {
      parent.appendChild(panel);
      return true;
    }
  }

  // Second fallback: find price class
  const priceClass = document.querySelector('.instrument-price_instrument-price__2w9MW');
  if (priceClass) {
    const parent = priceClass.closest('div')?.parentElement;
    if (parent) {
      parent.appendChild(panel);
      return true;
    }
  }

  // Last resort: insert after h1
  const h1 = document.querySelector('h1');
  if (h1) {
    const parent = h1.closest('div')?.parentElement;
    if (parent) {
      parent.appendChild(panel);
      return true;
    }
  }

  return false;
}

// Inject the holdings panel into the page
function injectHoldingsPanel(holding, assetInfo) {
  // Remove any existing panel first
  removeExistingPanel();

  // Update state with holding data
  panelState.setHolding(holding);

  // Get current price from page or assetInfo
  let currentPrice = getCurrentPriceFromPage();
  if (!currentPrice && assetInfo.lastPrice) {
    currentPrice = parseFloat(assetInfo.lastPrice);
  }
  panelState.setCurrentPrice(currentPrice);

  // Create and inject panel
  const panel = createPanelElement();
  insertPanel(panel);
}

// Update only dynamic values in existing panel (called on price change)
function updatePanelUI() {
  if (!panelState.holding) return;

  const currency = panelState.holding.currency || '$';

  // Update Total Value
  const totalValueEl = document.getElementById('panel-total-value');
  if (totalValueEl) {
    totalValueEl.textContent = formatCurrency(panelState.totalValue, currency);
  }

  // Update P/L
  const plEl = document.getElementById('panel-pl');
  if (plEl && panelState.pl !== null) {
    const plClass = panelState.pl >= 0 ? 'positive' : 'negative';
    const plSign = panelState.pl >= 0 ? '+' : '';
    plEl.textContent = `${plSign}${formatCurrency(panelState.pl, currency)} (${plSign}${panelState.plPercent.toFixed(2)}%)`;
    plEl.className = `portfolio-overlay-value ${plClass}`;
  }
}
