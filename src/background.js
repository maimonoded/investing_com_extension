// Portfolio Overlay Background Service Worker

// Default settings
const DEFAULT_SETTINGS = {
  cacheDurationMinutes: 10,
  monitoredPaths: ['/equities/', '/etfs/']
};

// Alarm name for periodic refresh
const REFRESH_ALARM_NAME = 'portfolioRefresh';

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
  // Set up periodic refresh alarm using saved settings (or defaults if none)
  const settings = data.settings || DEFAULT_SETTINGS;
  await setupRefreshAlarm(settings.cacheDurationMinutes);
});

// Set up or update the refresh alarm
async function setupRefreshAlarm(periodInMinutes) {
  if (!chrome.alarms) return; // Guard for missing alarms API
  // Clear existing alarm first
  await chrome.alarms.clear(REFRESH_ALARM_NAME);
  // Create new alarm with the specified period
  // delayInMinutes: first alarm fires after this delay (min 1 min in production)
  // periodInMinutes: subsequent alarms fire at this interval
  chrome.alarms.create(REFRESH_ALARM_NAME, {
    delayInMinutes: Math.max(1, periodInMinutes),
    periodInMinutes: periodInMinutes
  });
}

// Listen for alarm events (only if alarms API is available)
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === REFRESH_ALARM_NAME) {
      try {
        await fetchAndParsePortfolio();
      } catch (err) {
        // Silently fail - will retry on next alarm or user request
      }
    }
  });

  // Ensure alarm exists on service worker startup (in case it was cleared)
  (async () => {
    const alarm = await chrome.alarms.get(REFRESH_ALARM_NAME);
    if (!alarm) {
      const data = await chrome.storage.local.get(['settings']);
      const settings = data.settings || DEFAULT_SETTINGS;
      await setupRefreshAlarm(settings.cacheDurationMinutes);
    }
  })();
}

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PORTFOLIO_DATA') {
    handleGetPortfolioData(message.symbol, message.exchange, message.isin, message.pairId)
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
    chrome.storage.local.get(['portfolioData', 'debugInfo'], data => {
      const debugInfo = data.debugInfo || {};
      const result = {
        portfolioCount: (debugInfo.portfoliosFound || []).length,
        portfoliosFound: debugInfo.portfoliosFound || [],
        holdingsPerPortfolio: debugInfo.holdingsPerPortfolio || {},
        aggregatedHoldings: {}
      };
      for (const [key, holding] of Object.entries(data.portfolioData || {})) {
        result.aggregatedHoldings[key] = { symbol: holding.symbol, exchange: holding.exchange, qty: holding.qty, avgPrice: holding.avgPrice, currency: holding.currency };
      }
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ settings: message.settings })
      .then(() => setupRefreshAlarm(message.settings.cacheDurationMinutes))
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'CLEAR_ALL_DATA') {
    chrome.storage.local.clear()
      .then(() => chrome.storage.local.set({
        settings: DEFAULT_SETTINGS,
        lastSync: null,
        portfolioData: {},
        debugInfo: {}
      }))
      .then(() => setupRefreshAlarm(DEFAULT_SETTINGS.cacheDurationMinutes))
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
async function handleGetPortfolioData(symbol, exchange, isin, pairId) {
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
  const match = findMatch(portfolioData, symbol, exchange, isin, pairId);
  return { match, lastSync: data.lastSync };
}

// Find a matching holding by symbol+exchange, symbol, ISIN, or pairId
function findMatch(portfolioData, symbol, exchange, isin, pairId) {
  // Try exact symbol:exchange match first (preferred)
  if (symbol && exchange) {
    const key = `${symbol}:${exchange}`;
    if (portfolioData[key]) {
      return portfolioData[key];
    }
  }

  // Try symbol-only match (legacy/fallback for holdings without exchange)
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
    credentials: 'include',
    cache: 'no-store'
  });

  if (!mainResponse.ok) {
    throw new Error(`Failed to fetch portfolio: ${mainResponse.status}`);
  }

  const mainHtml = await mainResponse.text();

  // Extract all holdings portfolio tabs
  const holdingsPortfolios = extractHoldingsPortfolios(mainHtml);

  // Build new data in temporary variable, only overwrite storage when complete
  let newPortfolioData = {};
  let debugInfo = {
    portfoliosFound: holdingsPortfolios.map(p => ({ id: p.numericId, name: p.name, publicId: p.publicId || null })),
    holdingsPerPortfolio: {}
  };

  // First round: fetch all portfolios quickly with no retries
  const failedPortfolios = [];

  for (const portfolio of holdingsPortfolios) {
    // Only fetch portfolios that have a publicId - skip others to avoid double-counting from mainHtml
    if (!portfolio.publicId) {
      debugInfo.holdingsPerPortfolio[portfolio.name || portfolio.numericId] = { skipped: 'no publicId', holdings: [] };
      continue;
    }

    const portfolioUrl = `https://www.investing.com/portfolio/?portfolioID=${encodeURIComponent(portfolio.publicId)}`;
    const expectedId = portfolio.numericId;

    try {
      const response = await fetch(portfolioUrl, { credentials: 'include', cache: 'no-store' });

      if (!response.ok) {
        failedPortfolios.push(portfolio);
        continue;
      }

      const portfolioHtml = await response.text();
      const selectedPortfolioId = extractSelectedPortfolioId(portfolioHtml);
      const isCorrectPortfolio = selectedPortfolioId === expectedId;

      if (!isCorrectPortfolio) {
        console.info(`Portfolio "${portfolio.name}" mismatch on first try, will retry later`);
        failedPortfolios.push(portfolio);
        continue;
      }

      // Parse and merge holdings
      mergePortfolioData(newPortfolioData, debugInfo, portfolio, portfolioUrl, portfolioHtml, expectedId, selectedPortfolioId);
    } catch (err) {
      failedPortfolios.push(portfolio);
    }
  }

  // Save first round results immediately
  await chrome.storage.local.set({
    portfolioData: newPortfolioData,
    debugInfo: debugInfo,
    lastSync: Date.now()
  });

  // Second round: retry failed portfolios with 10s delay between each
  if (failedPortfolios.length > 0) {
    console.info(`Retrying ${failedPortfolios.length} failed portfolio(s) with delays...`);

    for (const portfolio of failedPortfolios) {
      await new Promise(resolve => setTimeout(resolve, 10000));

      const portfolioUrl = `https://www.investing.com/portfolio/?portfolioID=${encodeURIComponent(portfolio.publicId)}`;
      const expectedId = portfolio.numericId;

      try {
        const response = await fetch(portfolioUrl, { credentials: 'include', cache: 'no-store' });

        if (!response.ok) {
          console.warn(`Failed to fetch portfolio "${portfolio.name}" on retry: HTTP ${response.status}`);
          debugInfo.holdingsPerPortfolio[portfolio.name || portfolio.numericId] = {
            skipped: `HTTP error ${response.status}`,
            fetchedUrl: portfolioUrl,
            holdings: []
          };
          continue;
        }

        const portfolioHtml = await response.text();
        const selectedPortfolioId = extractSelectedPortfolioId(portfolioHtml);
        const isCorrectPortfolio = selectedPortfolioId === expectedId;

        if (!isCorrectPortfolio) {
          console.warn(`Failed to fetch portfolio "${portfolio.name}" on retry. Expected ID: ${expectedId}, Got: ${selectedPortfolioId}`);
          debugInfo.holdingsPerPortfolio[portfolio.name || portfolio.numericId] = {
            skipped: `mismatch on retry - expected ${expectedId}, got ${selectedPortfolioId}`,
            fetchedUrl: portfolioUrl,
            holdings: []
          };
          continue;
        }

        // Parse and merge holdings
        mergePortfolioData(newPortfolioData, debugInfo, portfolio, portfolioUrl, portfolioHtml, expectedId, selectedPortfolioId);

        // Save after each successful retry
        await chrome.storage.local.set({
          portfolioData: newPortfolioData,
          debugInfo: debugInfo,
          lastSync: Date.now()
        });
      } catch (err) {
        console.warn(`Error fetching portfolio "${portfolio.name}" on retry:`, err.message);
      }
    }
  }

  return newPortfolioData;
}

// Helper to parse and merge portfolio data
function mergePortfolioData(newPortfolioData, debugInfo, portfolio, portfolioUrl, portfolioHtml, expectedId, selectedPortfolioId) {
  const portfolioData = parsePortfolioHTML(portfolioHtml);

  // Store debug info for this portfolio
  const portfolioKey = portfolio.name || portfolio.numericId;
  debugInfo.holdingsPerPortfolio[portfolioKey] = {
    fetchedUrl: portfolioUrl,
    publicId: portfolio.publicId,
    expectedId: expectedId,
    selectedId: selectedPortfolioId,
    isCorrectPortfolio: true,
    holdingCount: Object.keys(portfolioData).length,
    holdings: Object.entries(portfolioData).map(([key, h]) => ({ symbol: h.symbol, exchange: h.exchange, qty: h.qty }))
  };

  // Merge into newPortfolioData (keys are already symbol:exchange format)
  for (const [key, holding] of Object.entries(portfolioData)) {
    if (newPortfolioData[key]) {
      // Aggregate quantities and calculate weighted average price
      const existing = newPortfolioData[key];
      const newQty = existing.qty + holding.qty;
      const newAvgPrice = (existing.avgPrice * existing.qty + holding.avgPrice * holding.qty) / newQty;
      const newTotalValue = existing.totalValue + holding.totalValue;

      newPortfolioData[key] = {
        ...existing,
        qty: newQty,
        avgPrice: newAvgPrice,
        totalValue: newTotalValue
      };
    } else {
      newPortfolioData[key] = holding;
    }
  }
}

// Extract the currently selected portfolio ID from the HTML
function extractSelectedPortfolioId(html) {
  // Look for the selected/active portfolio tab - it usually has "selected" or "active" class
  const selectedTabRegex = /<li[^>]+portfolioTab[^>]*(selected|active)[^>]*data-portfolio-id="(\d+)"/i;
  const match1 = html.match(selectedTabRegex);
  if (match1) {
    return match1[2];
  }

  // Alternative: class might come after data-portfolio-id
  const selectedTabRegex2 = /<li[^>]+data-portfolio-id="(\d+)"[^>]*(selected|active)/i;
  const match2 = html.match(selectedTabRegex2);
  if (match2) {
    return match2[1];
  }

  // Fallback: look for any indication of selected state
  const selectedTabRegex3 = /<li[^>]+portfolioTab\s+selected[^>]*data-portfolio-id="(\d+)"/i;
  const match3 = html.match(selectedTabRegex3);
  if (match3) {
    return match3[1];
  }

  return null;
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

      // Extract exchange from td with data-column-name="exchange"
      const exchangeMatch = trContent.match(/data-column-name="exchange"[^>]*title="([^"]*)"/i);
      const exchange = exchangeMatch ? exchangeMatch[1].trim() : '';

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
        // Use symbol:exchange as the key to distinguish same ticker on different exchanges
        const key = exchange ? `${symbol}:${exchange}` : symbol;

        if (portfolioData[key]) {
          // Same symbol on same exchange - aggregate quantities and calculate weighted average price
          const existing = portfolioData[key];
          const newQty = existing.qty + amount;
          const newAvgPrice = (existing.avgPrice * existing.qty + avgPrice * amount) / newQty;
          const newTotalValue = existing.totalValue + totalValue;

          portfolioData[key] = {
            ...existing,
            qty: newQty,
            avgPrice: newAvgPrice,
            totalValue: newTotalValue
          };
        } else {
          portfolioData[key] = {
            symbol,
            exchange,
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
