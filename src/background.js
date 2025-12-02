// Portfolio Overlay Background Service Worker

// Default settings
const DEFAULT_SETTINGS = {
  cacheDurationMinutes: 10,
  monitoredPaths: ['/equities/', '/etfs/']
};

// Initialize storage with defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['settings']);
  if (!data.settings) {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      lastSync: null,
      portfolioData: {}
    });
  }
});

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PORTFOLIO_DATA') {
    handleGetPortfolioData(message.symbol, message.isin, message.pairId)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'FORCE_REFRESH') {
    fetchAndParsePortfolio()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'GET_STATUS') {
    getStatus()
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'DEBUG_STORAGE') {
    chrome.storage.local.get(['portfolioData'], data => {
      const summary = {};
      for (const [symbol, holding] of Object.entries(data.portfolioData || {})) {
        summary[symbol] = { qty: holding.qty, portfolios: holding.portfolios };
      }
      sendResponse(summary);
    });
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ settings: message.settings })
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// Get current status for popup
async function getStatus() {
  const data = await chrome.storage.local.get(['settings', 'lastSync', 'portfolioData']);
  return {
    settings: data.settings || DEFAULT_SETTINGS,
    lastSync: data.lastSync,
    holdingsCount: Object.keys(data.portfolioData || {}).length
  };
}

// Handle portfolio data request from content script
async function handleGetPortfolioData(symbol, isin, pairId) {
  const data = await chrome.storage.local.get(['settings', 'lastSync', 'portfolioData']);
  const settings = data.settings || DEFAULT_SETTINGS;
  const lastSync = data.lastSync;
  let portfolioData = data.portfolioData || {};

  // Check if cache is stale
  const cacheAge = lastSync ? (Date.now() - lastSync) / 1000 / 60 : Infinity;
  if (cacheAge > settings.cacheDurationMinutes) {
    try {
      portfolioData = await fetchAndParsePortfolio();
    } catch (err) {
      // Continue with stale cache if available
    }
  }

  // Find matching holding
  const match = findMatch(portfolioData, symbol, isin, pairId);
  return { match, lastSync: data.lastSync };
}

// Find a matching holding by symbol, ISIN, or pairId
function findMatch(portfolioData, symbol, isin, pairId) {
  // Try exact symbol match first
  if (symbol && portfolioData[symbol]) {
    return portfolioData[symbol];
  }

  // Try matching by pairId or ISIN
  for (const key of Object.keys(portfolioData)) {
    const holding = portfolioData[key];
    if (pairId && holding.pairId === pairId) {
      return holding;
    }
    if (isin && holding.isin === isin) {
      return holding;
    }
  }

  return null;
}

// Fetch and parse all holdings portfolios
async function fetchAndParsePortfolio() {
  // First, fetch the main portfolio page to get all tabs
  const mainResponse = await fetch('https://www.investing.com/portfolio/', {
    credentials: 'include'
  });

  if (!mainResponse.ok) {
    throw new Error(`Failed to fetch portfolio: ${mainResponse.status}`);
  }

  const mainHtml = await mainResponse.text();

  // Extract all holdings portfolio tabs
  const holdingsPortfolios = extractHoldingsPortfolios(mainHtml);

  let allPortfolioData = {};

  // Fetch each portfolio using its publicId
  for (const portfolio of holdingsPortfolios) {
    try {
      let portfolioHtml = mainHtml;

      // If this portfolio has a publicId, fetch it specifically
      if (portfolio.publicId) {
        const portfolioUrl = `https://www.investing.com/portfolio/?portfolioID=${encodeURIComponent(portfolio.publicId)}`;
        const response = await fetch(portfolioUrl, { credentials: 'include' });
        if (response.ok) {
          portfolioHtml = await response.text();
        } else {
          continue;
        }
      }

      // Parse holdings from this portfolio's HTML
      const portfolioData = parsePortfolioHTML(portfolioHtml);

      // Merge into allPortfolioData
      for (const [symbol, holding] of Object.entries(portfolioData)) {
        if (allPortfolioData[symbol]) {
          // Aggregate quantities and calculate weighted average price
          const existing = allPortfolioData[symbol];
          const newQty = existing.qty + holding.qty;
          const newAvgPrice = (existing.avgPrice * existing.qty + holding.avgPrice * holding.qty) / newQty;
          const newTotalValue = existing.totalValue + holding.totalValue;

          allPortfolioData[symbol] = {
            ...existing,
            qty: newQty,
            avgPrice: newAvgPrice,
            totalValue: newTotalValue
          };
        } else {
          allPortfolioData[symbol] = holding;
        }
      }
    } catch (err) {
      // Continue with next portfolio
    }
  }

  await chrome.storage.local.set({
    portfolioData: allPortfolioData,
    lastSync: Date.now()
  });

  return allPortfolioData;
}

// Extract holdings portfolio tabs from the main page HTML
function extractHoldingsPortfolios(html) {
  const portfolios = [];

  // Find <li> tags with portfolioTab class and capture content until closing </li>
  const liRegex = /<li[^>]+portfolioTab[^>]*>([\s\S]*?)<\/li>/gi;

  let match;
  while ((match = liRegex.exec(html)) !== null) {
    const liTag = match[0];
    const liContent = match[1];

    // Extract numeric ID and title from the <li> tag
    const numericId = extractAttr(liTag, 'data-portfolio-id');
    const title = extractAttr(liTag, 'title');

    // Look for data-publicid anywhere in the <li> content (it's URL-encoded)
    const publicIdMatch = liContent.match(/data-publicid="([^"]+)"/i);
    let publicId = publicIdMatch ? decodeURIComponent(publicIdMatch[1]) : '';

    // Get content after this <li> tag to check for positionIcon
    const afterMatch = html.substring(match.index, match.index + 500);

    // Only include if it has positionIcon (holdings), not watchlistIcon
    if (afterMatch.includes('positionIcon') && !afterMatch.includes('watchlistIcon')) {
      // Avoid duplicates
      if (numericId && !portfolios.find(p => p.numericId === numericId)) {
        portfolios.push({
          id: publicId || numericId,
          numericId: numericId,
          publicId: publicId,
          name: title
        });
      }
    }
  }

  return portfolios;
}

// Parse portfolio HTML to extract holdings using regex (DOMParser not available in service workers)
function parsePortfolioHTML(html) {
  const portfolioData = {};

  // Alternative regex that's more flexible with attribute order
  const trRegex = /<tr[^>]*class="openPositionTR[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;
  while ((match = trRegex.exec(html)) !== null) {
    try {
      const trTag = match[0];
      const trContent = match[1];

      // Extract data attributes from the tr tag
      const pairId = extractAttr(trTag, 'data-pair-id');
      const amount = parseFloat(extractAttr(trTag, 'data-amount')) || 0;
      const avgPrice = parseFloat(extractAttr(trTag, 'data-open-price')) || 0;
      const name = extractAttr(trTag, 'data-pair-name') || '';
      const fullName = extractAttr(trTag, 'data-fullname') || '';
      const openTime = extractAttr(trTag, 'data-open-time') || '';
      const currencySymbol = extractAttr(trTag, 'data-commission-cur') || '$';

      // Extract symbol from td with data-column-name="sum_pos_fpb_symbols"
      const symbolMatch = trContent.match(/data-column-name="sum_pos_fpb_symbols"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
      const symbol = symbolMatch ? symbolMatch[1].trim() : '';

      // Extract market value from td with data-column-name="sum_pos_market_value"
      const valueMatch = trContent.match(/data-column-name="sum_pos_market_value"[^>]*?title="([^"]*)"/i);
      const totalValueStr = valueMatch ? valueMatch[1] : '';
      let totalValue = parseMoneyValue(totalValueStr);

      // If no market value found, calculate from current price if available
      if (!totalValue && amount > 0) {
        const curPrice = parseFloat(extractAttr(trTag, 'data-curprice')) || 0;
        if (curPrice > 0) {
          totalValue = amount * curPrice;
        }
      }

      // Extract URL
      const urlMatch = trContent.match(/href="(\/(?:equities|etfs)\/[^"]+)"/i);
      const url = urlMatch ? urlMatch[1] : '';

      if (symbol) {
        if (portfolioData[symbol]) {
          // Same symbol - aggregate quantities and calculate weighted average price
          const existing = portfolioData[symbol];
          const newQty = existing.qty + amount;
          const newAvgPrice = (existing.avgPrice * existing.qty + avgPrice * amount) / newQty;
          const newTotalValue = existing.totalValue + totalValue;

          portfolioData[symbol] = {
            ...existing,
            qty: newQty,
            avgPrice: newAvgPrice,
            totalValue: newTotalValue
          };
        } else {
          portfolioData[symbol] = {
            symbol,
            name,
            fullName,
            pairId,
            qty: amount,
            avgPrice,
            totalValue,
            openTime,
            url,
            currency: currencySymbol
          };
        }
      }
    } catch (err) {
      // Skip malformed rows
    }
  }

  return portfolioData;
}

// Helper to extract an attribute value from an HTML tag string
function extractAttr(tag, attrName) {
  const regex = new RegExp(`${attrName}="([^"]*)"`, 'i');
  const match = tag.match(regex);
  return match ? decodeHtmlEntities(match[1]) : '';
}

// Decode HTML entities
function decodeHtmlEntities(str) {
  if (!str) return str;
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&#x20ac;': '€',
    '&euro;': '€',
    '&#x24;': '$',
    '&#36;': '$',
    '&#x00a3;': '£',
    '&pound;': '£',
    '&#x00a5;': '¥',
    '&yen;': '¥',
    '&#x20a3;': '₣',
    '&#x20b9;': '₹',
    '&#x20aa;': '₪'
  };

  // Replace named/numeric entities
  let result = str;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'gi'), char);
  }

  // Handle any remaining numeric entities (&#xNNNN; or &#NNNN;)
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));

  return result;
}

// Parse money value like "$173,982.64" or "$51.17K" to number
function parseMoneyValue(str) {
  if (!str) return 0;

  // Remove currency symbol and spaces
  let clean = str.replace(/[$€£¥,\s]/g, '');

  // Handle K/M/B suffixes
  const multipliers = { K: 1000, M: 1000000, B: 1000000000 };
  const suffix = clean.slice(-1).toUpperCase();

  if (multipliers[suffix]) {
    clean = clean.slice(0, -1);
    return parseFloat(clean) * multipliers[suffix];
  }

  return parseFloat(clean) || 0;
}
