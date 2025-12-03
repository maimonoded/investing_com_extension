// Panel State Management
// Holds the current panel data and provides computed values

const panelState = {
  // Holding data (from portfolio)
  holding: null, // { qty, avgPrice, currency, symbol, name, fullName }

  // Current price from page
  currentPrice: null,

  // Computed getters
  get totalValue() {
    if (!this.holding || !this.currentPrice) return null;
    return this.currentPrice * this.holding.qty;
  },

  get pl() {
    if (!this.holding || !this.currentPrice || !this.holding.avgPrice) return null;
    return (this.currentPrice - this.holding.avgPrice) * this.holding.qty;
  },

  get plPercent() {
    if (!this.holding || !this.currentPrice || !this.holding.avgPrice) return null;
    return ((this.currentPrice - this.holding.avgPrice) / this.holding.avgPrice) * 100;
  },

  // Reset state (on navigation)
  reset() {
    this.holding = null;
    this.currentPrice = null;
  },

  // Set holding data
  setHolding(holding) {
    this.holding = holding;
  },

  // Set current price
  setCurrentPrice(price) {
    this.currentPrice = price;
  }
};
