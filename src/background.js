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
    return true; // Keep channel open for async response
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
      console.error('Failed to refresh portfolio:', err);
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

  // Extract all holdings portfolio tabs (those with positionIcon, not watchlistIcon)
  const holdingsPortfolios = extractHoldingsPortfolios(mainHtml);

  // Parse the current page's holdings (the default/first one)
  let allPortfolioData = parsePortfolioHTML(mainHtml);

  // Add portfolio name to first portfolio's holdings
  if (holdingsPortfolios.length > 0) {
    const firstPortfolioName = holdingsPortfolios[0].name;
    for (const symbol of Object.keys(allPortfolioData)) {
      allPortfolioData[symbol].portfolios = [firstPortfolioName];
    }
  }

  // Fetch each additional holdings portfolio
  for (const portfolio of holdingsPortfolios.slice(1)) { // Skip first, already parsed
    try {
      const response = await fetch(`https://www.investing.com/portfolio/?portfolioID=${portfolio.publicId}`, {
        credentials: 'include'
      });

      if (response.ok) {
        const html = await response.text();
        const portfolioData = parsePortfolioHTML(html);

        // Merge holdings - if same symbol exists, combine quantities
        for (const [symbol, holding] of Object.entries(portfolioData)) {
          if (allPortfolioData[symbol]) {
            // Same symbol in multiple portfolios - combine
            const existing = allPortfolioData[symbol];
            const combinedQty = existing.qty + holding.qty;
            const combinedValue = existing.totalValue + holding.totalValue;
            // Weighted average price
            const combinedAvgPrice = (existing.avgPrice * existing.qty + holding.avgPrice * holding.qty) / combinedQty;

            allPortfolioData[symbol] = {
              ...existing,
              qty: combinedQty,
              avgPrice: combinedAvgPrice,
              totalValue: combinedValue,
              portfolios: [...(existing.portfolios || [portfolio.name]), portfolio.name]
            };
          } else {
            allPortfolioData[symbol] = {
              ...holding,
              portfolios: [portfolio.name]
            };
          }
        }
      }
    } catch (err) {
      console.error(`Failed to fetch portfolio ${portfolio.name}:`, err);
      // Continue with other portfolios
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

  // Match portfolio tabs - look for li elements with portfolioTab class
  // Holdings have positionIcon, watchlists have watchlistIcon
  const tabRegex = /<li[^>]*class="[^"]*portfolioTab[^"]*"[^>]*>[\s\S]*?<span class="positionIcon[^"]*"><\/span>[\s\S]*?data-publicid="([^"]*)"[\s\S]*?value="([^"]*)"[\s\S]*?<\/li>/gi;

  let match;
  while ((match = tabRegex.exec(html)) !== null) {
    const publicId = match[1];
    const name = match[2];
    if (publicId && name) {
      portfolios.push({ publicId, name });
    }
  }

  // If no tabs found with the complex regex, try a simpler approach
  if (portfolios.length === 0) {
    // Look for tabs that have positionIcon (not watchlistIcon)
    const simpleRegex = /<li[^>]*class="[^"]*portfolioTab[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;

    while ((match = simpleRegex.exec(html)) !== null) {
      const tabContent = match[1];

      // Only process if it has positionIcon (holdings), not watchlistIcon
      if (tabContent.includes('positionIcon') && !tabContent.includes('watchlistIcon')) {
        const publicIdMatch = tabContent.match(/data-publicid="([^"]*)"/);
        const nameMatch = tabContent.match(/value="([^"]*)"/);

        if (publicIdMatch && nameMatch) {
          portfolios.push({
            publicId: publicIdMatch[1],
            name: nameMatch[1]
          });
        }
      }
    }
  }

  return portfolios;
}

// Parse portfolio HTML to extract holdings using regex (DOMParser not available in service workers)
function parsePortfolioHTML(html) {
  const portfolioData = {};

  // Match all <tr class="openPositionTR" ...> elements with their attributes
  const rowRegex = /<tr[^>]*class="openPositionTR[^"]*"[^>]*data-pair-id="([^"]*)"[^>]*data-amount="([^"]*)"[^>]*data-pair-name="([^"]*)"[^>]*data-open-price="([^"]*)"[^>]*data-fullname="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/gi;

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
      // The title attribute may come after class, so we need a more flexible regex
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
    } catch (err) {
      console.error('Error parsing portfolio row:', err);
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
