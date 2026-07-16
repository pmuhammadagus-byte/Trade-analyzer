/**
 * Header Component — Symbol selector, timeframe selector, live price, loss counter
 */
import { SYMBOL_CONFIG, TIMEFRAME_MAP } from '../data/dataManager.js';

export class Header {
  constructor({ onSymbolChange, onTimeframeChange }) {
    this.onSymbolChange = onSymbolChange;
    this.onTimeframeChange = onTimeframeChange;
    this.activeSymbol = 'BTCUSDT';
    this.activeTimeframe = '15m';
    this.lastPrice = null;
    this.dailyLosses = 0;
    this._init();
  }

  _init() {
    this._renderSymbols();
    this._renderTimeframes();
    this._setupTabListener();
  }

  _renderSymbols() {
    const container = document.getElementById('symbol-selector');
    if (!container) return;

    const symbols = Object.entries(SYMBOL_CONFIG);
    container.innerHTML = symbols.map(([key, config]) => {
      const isActive = key === this.activeSymbol;
      const icon = this._getSymbolIcon(config.type);
      return `<button class="symbol-btn ${isActive ? 'active' : ''}" data-symbol="${key}" id="symbol-btn-${key}">
        ${icon} ${config.displayName}
      </button>`;
    }).join('');

    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.symbol-btn');
      if (!btn) return;
      const symbol = btn.dataset.symbol;
      this.setActiveSymbol(symbol);
    });
  }

  _renderTimeframes() {
    const container = document.getElementById('timeframe-selector');
    if (!container) return;

    const timeframes = Object.keys(TIMEFRAME_MAP);
    container.innerHTML = timeframes.map(tf => {
      const isActive = tf === this.activeTimeframe;
      return `<button class="tf-btn ${isActive ? 'active' : ''}" data-tf="${tf}" id="tf-btn-${tf}">${tf}</button>`;
    }).join('');

    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.tf-btn');
      if (!btn) return;
      const tf = btn.dataset.tf;
      this.setActiveTimeframe(tf);
    });
  }

  _setupTabListener() {
    // Analysis tabs
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        const target = document.getElementById(`tab-${btn.dataset.tab}`);
        if (target) target.classList.add('active');
      });
    });
  }

  _getSymbolIcon(type) {
    switch (type) {
      case 'crypto': return '₿';
      case 'commodity': return '🥇';
      case 'forex': return '💱';
      default: return '📈';
    }
  }

  setActiveSymbol(symbol) {
    this.activeSymbol = symbol;
    document.querySelectorAll('.symbol-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.symbol === symbol);
    });
    const config = SYMBOL_CONFIG[symbol];
    if (config) {
      document.getElementById('overlay-symbol').textContent = config.displayName;
    }
    this.onSymbolChange(symbol);
  }

  setActiveTimeframe(tf) {
    this.activeTimeframe = tf;
    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tf === tf);
    });
    document.getElementById('overlay-timeframe').textContent = tf;
    this.onTimeframeChange(tf);
  }

  updatePrice(price, prevPrice) {
    const el = document.getElementById('current-price');
    if (!el) return;

    const config = SYMBOL_CONFIG[this.activeSymbol];
    const decimals = this._getDecimals(this.activeSymbol);
    el.textContent = price.toFixed(decimals);

    // Tick animation
    el.classList.remove('tick-up', 'tick-down');
    if (prevPrice !== null && prevPrice !== undefined) {
      if (price > prevPrice) {
        el.classList.add('tick-up');
      } else if (price < prevPrice) {
        el.classList.add('tick-down');
      }
      setTimeout(() => el.classList.remove('tick-up', 'tick-down'), 500);
    }

    // Price change
    if (this.lastPrice === null) this.lastPrice = price;
    const changeEl = document.getElementById('price-change');
    if (changeEl && this.openPrice) {
      const change = ((price - this.openPrice) / this.openPrice) * 100;
      changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      changeEl.className = `price-change ${change >= 0 ? 'positive' : 'negative'}`;
    }
  }

  setOpenPrice(price) {
    this.openPrice = price;
  }

  _getDecimals(symbol) {
    if (symbol === 'XAUUSD') return 2;
    if (symbol === 'BTCUSDT') return 2;
    return 5; // forex pairs
  }

  updateDailyLosses(count) {
    this.dailyLosses = count;
    const el = document.getElementById('loss-count');
    if (!el) return;
    el.textContent = count.toString();
    el.className = 'loss-count';
  }

  updateAccountSummary(balance, equity) {
    const balEl = document.getElementById('account-balance');
    const eqEl = document.getElementById('account-equity');
    if (!balEl || !eqEl) return;

    balEl.textContent = `$${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    eqEl.textContent = `$${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    eqEl.className = 'account-value';
    if (equity > balance + 0.01) {
      eqEl.classList.add('equity-up');
    } else if (equity < balance - 0.01) {
      eqEl.classList.add('equity-down');
    }
  }

  setConnectionStatus(status) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (!dot || !text) return;

    dot.className = 'status-dot';
    switch (status) {
      case 'connected':
        dot.classList.add('connected');
        text.textContent = 'Live';
        break;
      case 'connecting':
        dot.classList.add('connecting');
        text.textContent = 'Connecting...';
        break;
      case 'disconnected':
        dot.classList.add('disconnected');
        text.textContent = 'Offline';
        break;
    }
  }
}

export default Header;
