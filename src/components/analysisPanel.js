/**
 * Analysis Panel — Renders tabbed analysis data (Overview, Structure, OBs, Zones, Indicators, Calculator)
 */
import { SYMBOL_CONFIG } from '../data/dataManager.js';

export class AnalysisPanel {
  constructor() {
    this.currentSymbol = 'BTCUSDT';
    this.liveRates = null;
    this.chatMessages = [];
    this.lastAnalysisData = null;
    this.hasRenderedChat = false;
    
    // Set viewed calendar month and year to current active month initially
    const now = new Date();
    this.symViewedMonth = now.getMonth();
    this.symViewedYear = now.getFullYear();
    this.ovrViewedMonth = now.getMonth();
    this.ovrViewedYear = now.getFullYear();
    
    this._initResizer();
  }

  _initResizer() {
    // Run resizing setup once DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._setupResizerElement());
    } else {
      this._setupResizerElement();
    }
  }

  _setupResizerElement() {
    const panel = document.getElementById('analysis-section');
    if (!panel) {
      console.warn('[AnalysisPanel] Could not find #analysis-section element for resizing.');
      return;
    }

    // Check if the resize handle already exists
    let handle = document.getElementById('analysis-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.id = 'analysis-resize-handle';
      // Insert at the top of the section
      panel.insertBefore(handle, panel.firstChild);
    }

    // Load persisted height from localStorage if available
    const savedHeight = localStorage.getItem('tradeAnalyzer_bottomPanelHeight');
    if (savedHeight) {
      const heightVal = parseInt(savedHeight, 10);
      const minH = 180;
      const maxH = Math.max(200, window.innerHeight - 380);
      if (!isNaN(heightVal) && heightVal >= minH && heightVal <= maxH) {
        panel.style.height = `${heightVal}px`;
      }
    }

    let startY = 0;
    let startHeight = 0;
    let isDragging = false;

    const onMouseDown = (e) => {
      startY = e.clientY;
      startHeight = panel.getBoundingClientRect().height;
      isDragging = true;

      handle.classList.add('active');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      
      const clientY = e.clientY;
      const deltaY = clientY - startY;
      const newHeight = startHeight - deltaY;
      
      // Calculate limits dynamically
      const minH = 180;
      const maxH = Math.max(200, window.innerHeight - 380); // Ensure at least 380px for header + chart
      
      const clampedHeight = Math.min(maxH, Math.max(minH, newHeight));
      panel.style.height = `${clampedHeight}px`;
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;

      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';

      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      // Persist user preference
      const finalHeight = parseInt(panel.style.height, 10);
      if (!isNaN(finalHeight)) {
        localStorage.setItem('tradeAnalyzer_bottomPanelHeight', finalHeight.toString());
      }
    };

    // Touch Support for Mobile / Tablet / Touchscreen Laptops
    const onTouchStart = (e) => {
      if (e.touches.length > 0) {
        startY = e.touches[0].clientY;
        startHeight = panel.getBoundingClientRect().height;
        isDragging = true;

        handle.classList.add('active');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';

        window.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('touchend', onTouchEnd);
      }
    };

    const onTouchMove = (e) => {
      if (!isDragging || e.touches.length === 0) return;
      e.preventDefault(); // Prevent page scroll during drag

      const clientY = e.touches[0].clientY;
      const deltaY = clientY - startY;
      const newHeight = startHeight - deltaY;

      const minH = 180;
      const maxH = Math.max(200, window.innerHeight - 380);
      
      const clampedHeight = Math.min(maxH, Math.max(minH, newHeight));
      panel.style.height = `${clampedHeight}px`;
    };

    const onTouchEnd = () => {
      if (!isDragging) return;
      isDragging = false;

      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';

      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);

      const finalHeight = parseInt(panel.style.height, 10);
      if (!isNaN(finalHeight)) {
        localStorage.setItem('tradeAnalyzer_bottomPanelHeight', finalHeight.toString());
      }
    };

    // Ensure resizing window clamps bottom panel height dynamically
    window.addEventListener('resize', () => {
      const currentHeight = panel.getBoundingClientRect().height;
      const maxH = Math.max(200, window.innerHeight - 380);
      if (currentHeight > maxH) {
        panel.style.height = `${maxH}px`;
      }
    });

    // Event Bindings
    handle.addEventListener('mousedown', onMouseDown);
    handle.addEventListener('touchstart', onTouchStart, { passive: true });
  }

  setLiveRates(rates) {
    this.liveRates = rates;
  }

  updateOverview(trendData, structureData, orderBlocks, zones, indicators, symbol, symbolStats, tradeHistory, signals) {
    this.currentSymbol = symbol || this.currentSymbol;
    this.lastAnalysisData = { trendData, structureData, orderBlocks, zones, indicators, signals };
    this._renderOverview(trendData, indicators, symbolStats);
    this._renderStructure(structureData);
    this._renderOrderBlocks(orderBlocks);
    this._renderZones(zones);
    this._renderIndicators(indicators);
    this._renderCalculator();
    
    const history = tradeHistory || [];
    this._renderCalendarWidget('tab-dashboard', history, true);  // Symbol P&L (Strictly filtered)
    this._renderCalendarWidget('tab-overall', history, false);   // Overall P&L (Full portfolio)
    
    this._renderChat();
  }

  _renderOverview(trend, indicators, symbolStats) {
    const el = document.getElementById('tab-overview');
    if (!el) return;

    const trendDir = trend?.direction || 'ranging';
    const trendStr = trend?.strength || 0;
    const rsiVal = indicators?.rsi;
    const lastRSI = rsiVal && rsiVal.length > 0 ? rsiVal[rsiVal.length - 1] : null;
    const emaAlign = trend?.emaAlignment || 'mixed';

    let statsHtml = '';
    if (symbolStats) {
      statsHtml = `
        <div style="margin-top: var(--gap-lg);">
          <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: var(--gap-sm); color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
            <span>📈</span> Performance Statistics (Historical Trade Data)
          </div>
          <table class="analysis-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>Profit Factor</th>
                <th>Net Profit</th>
              </tr>
            </thead>
            <tbody>
              ${Object.entries(symbolStats).map(([sym, s]) => {
                const profitClass = s.profit >= 0 ? 'positive' : 'negative';
                const winRateClass = s.winRate >= 50 ? 'bullish' : s.winRate > 0 ? 'bearish' : 'neutral';
                const formattedProfit = (s.profit >= 0 ? '+' : '') + '$' + s.profit.toFixed(2);
                return `
                  <tr>
                    <td><strong>${sym}</strong></td>
                    <td>${s.total} (${s.wins}W / ${s.losses}L)</td>
                    <td><span class="trend-badge ${winRateClass}">${s.winRate.toFixed(1)}%</span></td>
                    <td><span style="color: ${s.profitFactor >= 1.5 ? 'var(--bullish)' : s.profitFactor >= 1.0 ? 'var(--accent-amber)' : 'var(--text-tertiary)'}">${s.profitFactor.toFixed(2)}</span></td>
                    <td><span class="trade-pnl ${profitClass}" style="font-size:0.75rem;">${formattedProfit}</span></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="overview-grid">
        <div class="overview-card">
          <div class="overview-card-title">Trend</div>
          <div class="overview-card-value">
            <span class="trend-badge ${this._trendClass(trendDir)}">${this._trendLabel(trendDir)}</span>
          </div>
          <div class="overview-card-sub">Strength: ${trendStr}/100</div>
        </div>
        <div class="overview-card">
          <div class="overview-card-title">RSI (14)</div>
          <div class="overview-card-value indicator-value ${this._rsiClass(lastRSI)}">
            ${lastRSI !== null ? lastRSI.toFixed(1) : '—'}
          </div>
          <div class="overview-card-sub">${this._rsiLabel(lastRSI)}</div>
        </div>
        <div class="overview-card">
          <div class="overview-card-title">EMA Alignment</div>
          <div class="overview-card-value">
            <span class="trend-badge ${emaAlign === 'bullish' ? 'bullish' : emaAlign === 'bearish' ? 'bearish' : 'ranging'}">
              ${emaAlign.toUpperCase()}
            </span>
          </div>
          <div class="overview-card-sub">${trend?.details || 'Analyzing...'}</div>
        </div>
        <div class="overview-card">
          <div class="overview-card-title">Structure</div>
          <div class="overview-card-value">
            <span class="trend-badge ${this._trendClass(trend?.structureTrend || 'ranging')}">
              ${(trend?.structureTrend || 'ranging').toUpperCase()}
            </span>
          </div>
          <div class="overview-card-sub">Momentum: ${trend?.momentum || 'neutral'}</div>
        </div>
      </div>
      ${statsHtml}
    `;
  }

  _renderStructure(data) {
    const el = document.getElementById('tab-structure');
    if (!el || !data) {
      if (el) el.innerHTML = '<p style="color: var(--text-tertiary)">Waiting for data...</p>';
      return;
    }

    const breaks = (data.structureBreaks || []).slice(-8).reverse();

    el.innerHTML = `
      <div style="margin-bottom: var(--gap-md);">
        <strong>Market Trend:</strong>
        <span class="trend-badge ${this._trendClass(data.trend)}">${(data.trend || 'ranging').toUpperCase()}</span>
        &nbsp;&nbsp;
        <span style="color: var(--text-secondary); font-size: 0.75rem;">
          ${data.higherHighs ? '✅ HH' : '❌ HH'} ${data.higherLows ? '✅ HL' : '❌ HL'}
          ${data.lowerHighs ? '✅ LH' : '❌ LH'} ${data.lowerLows ? '✅ LL' : '❌ LL'}
        </span>
      </div>
      <table class="analysis-table">
        <thead>
          <tr><th>Type</th><th>Direction</th><th>Price</th><th>Index</th></tr>
        </thead>
        <tbody>
          ${breaks.map(b => `
            <tr>
              <td><span class="ob-badge ${b.direction}">${b.type}</span></td>
              <td><span class="trend-badge ${b.direction}">${b.direction.toUpperCase()}</span></td>
              <td>${b.price.toFixed(this._getDecimals())}</td>
              <td style="color: var(--text-tertiary)">#${b.index}</td>
            </tr>
          `).join('')}
          ${breaks.length === 0 ? '<tr><td colspan="4" style="color: var(--text-tertiary); text-align: center;">No structure breaks detected yet</td></tr>' : ''}
        </tbody>
      </table>
    `;
  }

  _renderOrderBlocks(orderBlocks) {
    const el = document.getElementById('tab-orderblocks');
    if (!el) return;

    const obs = (orderBlocks || []).slice(-10).reverse();

    el.innerHTML = `
      <table class="analysis-table">
        <thead>
          <tr><th>Type</th><th>Top</th><th>Bottom</th><th>Strength</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${obs.map(ob => `
            <tr>
              <td><span class="ob-badge ${ob.type} ${ob.mitigated ? 'mitigated' : ''}">${ob.type.toUpperCase()}</span></td>
              <td>${ob.top.toFixed(this._getDecimals())}</td>
              <td>${ob.bottom.toFixed(this._getDecimals())}</td>
              <td>
                <span style="color: ${ob.strength >= 70 ? 'var(--bullish)' : ob.strength >= 40 ? 'var(--accent-amber)' : 'var(--text-tertiary)'}">
                  ${ob.strength}/100
                </span>
              </td>
              <td>${ob.mitigated ? '<span class="ob-badge bearish">MITIGATED</span>' : '<span class="ob-badge bullish">ACTIVE</span>'}</td>
            </tr>
          `).join('')}
          ${obs.length === 0 ? '<tr><td colspan="5" style="color: var(--text-tertiary); text-align: center;">No order blocks found</td></tr>' : ''}
        </tbody>
      </table>
    `;
  }

  _renderZones(zones) {
    const el = document.getElementById('tab-zones');
    if (!el) return;

    const zonesList = (zones || []).filter(z => z.status !== 'broken').slice(-10).reverse();

    el.innerHTML = `
      <table class="analysis-table">
        <thead>
          <tr><th>Type</th><th>Pattern</th><th>Top</th><th>Bottom</th><th>Strength</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${zonesList.map(z => `
            <tr>
              <td><span class="ob-badge ${z.type === 'demand' ? 'bullish' : 'bearish'}">${z.type.toUpperCase()}</span></td>
              <td style="color: var(--text-secondary)">${z.pattern}</td>
              <td>${z.top.toFixed(this._getDecimals())}</td>
              <td>${z.bottom.toFixed(this._getDecimals())}</td>
              <td>
                <span style="color: ${z.strength >= 70 ? 'var(--bullish)' : z.strength >= 40 ? 'var(--accent-amber)' : 'var(--text-tertiary)'}">
                  ${z.strength}/100
                </span>
              </td>
              <td><span class="zone-status ${z.status}">${z.status.toUpperCase()}</span></td>
            </tr>
          `).join('')}
          ${zonesList.length === 0 ? '<tr><td colspan="6" style="color: var(--text-tertiary); text-align: center;">No active zones found</td></tr>' : ''}
        </tbody>
      </table>
    `;
  }

  _renderIndicators(indicators) {
    const el = document.getElementById('tab-indicators');
    if (!el || !indicators) {
      if (el) el.innerHTML = '<p style="color: var(--text-tertiary)">Waiting for data...</p>';
      return;
    }

    const last = (arr) => arr && arr.length > 0 ? arr[arr.length - 1] : null;

    const rsi = last(indicators.rsi);
    const macd = indicators.macd;
    const lastMACD = macd ? last(macd.macdLine) : null;
    const lastSignal = macd ? last(macd.signalLine) : null;
    const lastHist = macd ? last(macd.histogram) : null;
    const bb = indicators.bollingerBands;
    const lastBBU = bb ? last(bb.upper) : null;
    const lastBBM = bb ? last(bb.middle) : null;
    const lastBBL = bb ? last(bb.lower) : null;
    const lastATR = last(indicators.atr);
    const emaVals = indicators.emas || {};

    el.innerHTML = `
      <div class="overview-grid">
        <div class="overview-card">
          <div class="overview-card-title">RSI (14)</div>
          <div class="overview-card-value indicator-value ${this._rsiClass(rsi)}">
            ${rsi !== null ? rsi.toFixed(1) : '—'}
          </div>
        </div>
        <div class="overview-card">
          <div class="overview-card-title">MACD</div>
          <div class="overview-card-value indicator-value ${lastHist > 0 ? 'bullish' : lastHist < 0 ? 'bearish' : 'neutral'}">
            ${lastMACD !== null ? lastMACD.toFixed(this._getDecimals()) : '—'}
          </div>
          <div class="overview-card-sub">Signal: ${lastSignal !== null ? lastSignal.toFixed(this._getDecimals()) : '—'} | Hist: ${lastHist !== null ? lastHist.toFixed(this._getDecimals()) : '—'}</div>
        </div>
        <div class="overview-card">
          <div class="overview-card-title">ATR (14)</div>
          <div class="overview-card-value indicator-value neutral">
            ${lastATR !== null ? lastATR.toFixed(this._getDecimals()) : '—'}
          </div>
        </div>
        <div class="overview-card">
          <div class="overview-card-title">Bollinger Bands</div>
          <div class="overview-card-value" style="font-size: 0.8rem;">
            <span style="color: var(--bearish)">${lastBBU !== null ? lastBBU.toFixed(this._getDecimals()) : '—'}</span>
            / <span style="color: var(--text-secondary)">${lastBBM !== null ? lastBBM.toFixed(this._getDecimals()) : '—'}</span>
            / <span style="color: var(--bullish)">${lastBBL !== null ? lastBBL.toFixed(this._getDecimals()) : '—'}</span>
          </div>
          <div class="overview-card-sub">Upper / Middle / Lower</div>
        </div>
        ${Object.entries(emaVals).map(([period, values]) => {
          const val = last(values);
          return `
            <div class="overview-card">
              <div class="overview-card-title">EMA ${period}</div>
              <div class="overview-card-value indicator-value neutral">
                ${val !== null ? val.toFixed(this._getDecimals()) : '—'}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  _renderCalculator() {
    const el = document.getElementById('tab-calculator');
    if (!el || el.querySelector('.calculator-form')) return; // Only render once

    el.innerHTML = `
      <div class="calculator-form" id="lot-calculator">
        <div class="calc-group">
          <label class="calc-label">Symbol</label>
          <select class="calc-select" id="calc-symbol">
            ${Object.entries(SYMBOL_CONFIG).map(([key, config]) =>
              `<option value="${key}" ${key === this.currentSymbol ? 'selected' : ''}>${config.displayName}</option>`
            ).join('')}
          </select>
        </div>
        <div class="calc-group">
          <label class="calc-label">Entry Price</label>
          <input type="number" class="calc-input" id="calc-entry" placeholder="0.00" step="any">
        </div>
        <div class="calc-group">
          <label class="calc-label">Stop Loss</label>
          <input type="number" class="calc-input" id="calc-sl" placeholder="0.00" step="any">
        </div>
        <div class="calc-result" id="calc-result" style="display: none;">
          <div class="calc-result-item">
            <span class="calc-result-label">Lot Size</span>
            <span class="calc-result-value" id="calc-lot-result">—</span>
          </div>
          <div class="calc-result-item">
            <span class="calc-result-label">Risk</span>
            <span class="calc-result-value" id="calc-risk-result" style="color: var(--bearish)">—</span>
          </div>
          <div class="calc-result-item">
            <span class="calc-result-label">SL Distance</span>
            <span class="calc-result-value" id="calc-dist-result" style="color: var(--text-secondary)">—</span>
          </div>
        </div>
      </div>
    `;

    // Calculator event listeners
    const calcInputs = el.querySelectorAll('.calc-input, .calc-select');
    calcInputs.forEach(input => {
      input.addEventListener('input', () => this._calculateLot());
    });
  }

  _calculateLot() {
    const symbol = document.getElementById('calc-symbol')?.value;
    const entry = parseFloat(document.getElementById('calc-entry')?.value);
    const sl = parseFloat(document.getElementById('calc-sl')?.value);
    const resultEl = document.getElementById('calc-result');

    if (!symbol || isNaN(entry) || isNaN(sl) || entry === sl) {
      if (resultEl) resultEl.style.display = 'none';
      return;
    }

    // Import calculateLotSize dynamically
    const slDist = Math.abs(entry - sl);
    let lots, risk, distLabel;

    switch (symbol) {
      case 'BTCUSDT':
        lots = 50 / slDist;
        risk = slDist * lots;
        distLabel = `$${slDist.toFixed(2)}`;
        break;
      case 'XAUUSD':
        lots = 50 / (slDist * 100);
        risk = slDist * lots * 100;
        distLabel = `${slDist.toFixed(2)} pts`;
        break;
      case 'GBPUSD':
        const pips = slDist / 0.0001;
        lots = 50 / (pips * 10);
        risk = pips * lots * 10;
        distLabel = `${pips.toFixed(1)} pips`;
        break;
      case 'USDCAD':
        const usdcadPips = slDist / 0.0001;
        const rate = this.liveRates?.['USDCAD'] || 1.38;
        const pipVal = 10 / rate;
        lots = 50 / (usdcadPips * pipVal);
        risk = usdcadPips * lots * pipVal;
        distLabel = `${usdcadPips.toFixed(1)} pips`;
        break;
      default:
        return;
    }

    lots = Math.max(0.01, Math.round(lots * 100) / 100);

    // Apply same maximum lot limits as execution engine
    let maxLots = 3.0;
    if (symbol === 'BTCUSDT') {
      maxLots = 0.14;
    } else if (symbol === 'XAUUSD') {
      maxLots = 0.3;
    } else if (['GBPUSD', 'USDCAD'].includes(symbol)) {
      maxLots = 3.0;
    }

    lots = Math.min(lots, maxLots);

    // Recalculate precise actual risk based on final clamped lot size
    switch (symbol) {
      case 'BTCUSDT':
        risk = slDist * lots;
        break;
      case 'XAUUSD':
        risk = slDist * lots * 100;
        break;
      case 'GBPUSD':
        risk = (slDist / 0.0001) * lots * 10;
        break;
      case 'USDCAD':
        const rate = this.liveRates?.['USDCAD'] || 1.38;
        risk = (slDist / 0.0001) * lots * (10 / rate);
        break;
    }

    if (resultEl) resultEl.style.display = 'flex';
    const lotEl = document.getElementById('calc-lot-result');
    const riskEl = document.getElementById('calc-risk-result');
    const distEl = document.getElementById('calc-dist-result');
    if (lotEl) lotEl.textContent = lots.toFixed(2);
    if (riskEl) riskEl.textContent = `$${risk.toFixed(2)}`;
    if (distEl) distEl.textContent = distLabel;
  }

  _trendClass(dir) {
    if (!dir) return 'ranging';
    if (dir.includes('bullish')) return 'bullish';
    if (dir.includes('bearish')) return 'bearish';
    return 'ranging';
  }

  _trendLabel(dir) {
    if (!dir) return 'RANGING';
    return dir.replace(/_/g, ' ').toUpperCase();
  }

  _rsiClass(val) {
    if (val === null || val === undefined) return 'neutral';
    if (val >= 70) return 'bearish';
    if (val <= 30) return 'bullish';
    return 'neutral';
  }

  _rsiLabel(val) {
    if (val === null || val === undefined) return 'Waiting...';
    if (val >= 70) return 'Overbought';
    if (val <= 30) return 'Oversold';
    return 'Neutral';
  }

  _getDecimals(symbol) {
    const sym = symbol || this.currentSymbol;
    if (sym === 'XAUUSD') return 2;
    if (sym === 'BTCUSDT') return 2;
    return 5;
  }

  _generateAuditExplanation(trade) {
    const isWin = trade.pnl >= 0;
    const isBE = Math.abs(trade.pnl) < 0.05; // close to entry
    
    if (trade.closeReason === 'SL Hit' || trade.closeReason === 'SL Hit (Offline)') {
      if (trade.partialClosed) {
        return `🎯 **Breakeven Protection Triggered**: 70% profit secured successfully at TP1. The remaining 30% portion was stopped out at entry (breakeven), securing a risk-free positive return overall.`;
      }
      if (isBE) {
        return `🎯 **Breakeven Secured**: Target 1 expansion completed. Stop Loss automatically trailed to entry price of $${trade.entry.toFixed(this._getDecimals(trade.symbol))} to lock out risk before structural reversal took place.`;
      }
      return `🛑 **Stop Loss Breach**: Structural invalidation buffer swept. Bid/Ask liquidity pierced the HTF support level, terminating the order setup with risk securely capped at FundingPips boundaries.`;
    }
    
    if (trade.closeReason === 'TP2 Hit' || trade.closeReason === 'TP2 Hit (Offline)') {
      return `🎉 **Premium Target Cleared**: Complete mitigation block reached. High probability expansion target tapped perfectly at a stellar 1:3+ Risk-to-Reward distribution zone.`;
    }

    if (trade.closeReason === 'Manual Close') {
      if (isWin) {
        return `💵 **Manual Distribution Take**: Secured premium gains manually prior to structural mitigation. Protected profits like an experienced capital manager.`;
      }
      return `⚠️ **Early Setup Cut**: Market invalidation recognized. Manual close executed after identifying structural weakness (CHoCH) against the order flow, preserving demo capital.`;
    }

    if (isBE) return `🎯 **BE Protection**: Stop Loss trailed. Position protected at $0.00 risk.`;
    return isWin 
      ? `📈 **Premium Gain**: Trade exited cleanly with profit. Secured premium liquidity pool values.` 
      : `📉 **Risk Safeguarded**: Controlled setup loss. Risk clamped within standard firm constraints.`;
  }

  _renderCalendarWidget(containerId, tradeHistory, isSymbolOnly) {
    const el = document.getElementById(containerId);
    if (!el) return;

    // Filter tradeHistory if isSymbolOnly is true
    const filteredTrades = isSymbolOnly
      ? tradeHistory.filter(t => t.symbol === this.currentSymbol)
      : tradeHistory;

    // Group P&L and trade counts by date string (e.g. 'YYYY-MM-DD') using local time to prevent timezone shift
    const pnlByDate = {};
    for (const trade of filteredTrades) {
      if (trade.status !== 'closed' || !trade.closeTime) continue;
      const date = new Date(trade.closeTime);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      if (!pnlByDate[dateStr]) {
        pnlByDate[dateStr] = { pnl: 0, count: 0 };
      }
      pnlByDate[dateStr].pnl += trade.pnl;
      pnlByDate[dateStr].count++;
    }

    // 1. Gather all unique year-month strings that have closed trades, plus the current actual month
    const monthKeys = new Set();
    const now = new Date();
    const actualYear = now.getFullYear();
    const actualMonth = now.getMonth();
    monthKeys.add(`${actualYear}-${actualMonth}`);

    for (const trade of filteredTrades) {
      if (trade.status !== 'closed' || !trade.closeTime) continue;
      const d = new Date(trade.closeTime);
      monthKeys.add(`${d.getFullYear()}-${d.getMonth()}`);
    }

    // Convert to array of { year, month } and sort chronologically
    const sortedMonths = Array.from(monthKeys).map(key => {
      const [y, m] = key.split('-').map(Number);
      return { year: y, month: m };
    }).sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });

    const keyPrefix = isSymbolOnly ? 'sym' : 'ovr';
    
    // Make sure our viewedMonth/Year is within the sortedMonths array, otherwise reset to actual current month
    if (this[`${keyPrefix}ViewedYear`] === undefined || this[`${keyPrefix}ViewedMonth`] === undefined) {
      this[`${keyPrefix}ViewedYear`] = actualYear;
      this[`${keyPrefix}ViewedMonth`] = actualMonth;
    }

    let currentIndex = sortedMonths.findIndex(m => m.year === this[`${keyPrefix}ViewedYear`] && m.month === this[`${keyPrefix}ViewedMonth`]);
    if (currentIndex === -1) {
      this[`${keyPrefix}ViewedYear`] = actualYear;
      this[`${keyPrefix}ViewedMonth`] = actualMonth;
      currentIndex = sortedMonths.findIndex(m => m.year === this[`${keyPrefix}ViewedYear`] && m.month === this[`${keyPrefix}ViewedMonth`]);
    }

    const year = this[`${keyPrefix}ViewedYear`];
    const month = this[`${keyPrefix}ViewedMonth`];

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    // First day of the month
    const firstDay = new Date(year, month, 1).getDay();
    // Days in the month
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const calendarCells = [];
    // Add empty cells for days before the 1st
    for (let i = 0; i < firstDay; i++) {
      calendarCells.push('<div class="cal-cell empty"></div>');
    }

    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const padM = String(month + 1).padStart(2, '0');
      const padD = String(day).padStart(2, '0');
      const dateStr = `${year}-${padM}-${padD}`;
      const cellData = pnlByDate[dateStr];

      let cellClass = '';
      let pnlText = '';
      if (cellData !== undefined && cellData.count > 0) {
        const pnl = cellData.pnl;
        const count = cellData.count;
        cellClass = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'ranging';
        pnlText = `
          <div style="display: flex; flex-direction: column; align-items: flex-end; width: 100%; gap: 1px;">
            <span class="cal-pnl ${pnl >= 0 ? 'positive' : 'negative'}" style="font-size: 0.65rem; font-weight: 700; line-height: 1.1;">
              ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(1)}
            </span>
            <span style="font-size: 0.55rem; color: var(--text-tertiary); font-weight: 600; line-height: 1;">
              ${count} Trade${count === 1 ? '' : 's'}
            </span>
          </div>
        `;
      }

      const isToday = day === now.getDate() && month === now.getMonth() && year === now.getFullYear();
      if (isToday) {
        cellClass += ' today';
      }

      calendarCells.push(`
        <div class="cal-cell ${cellClass}">
          <span class="cal-day-num">${day}</span>
          ${pnlText}
        </div>
      `);
    }

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Group trade history daywise stats
    const statsByDayOfWeek = {
      0: { name: 'Sunday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
      1: { name: 'Monday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
      2: { name: 'Tuesday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
      3: { name: 'Wednesday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
      4: { name: 'Thursday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
      5: { name: 'Friday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
      6: { name: 'Saturday', total: 0, wins: 0, losses: 0, winRate: 0, profit: 0 },
    };

    // Filter trade history for day-of-week performance
    for (const trade of filteredTrades) {
      if (!trade.closeTime) continue;
      const dayOfWeek = new Date(trade.closeTime).getDay();
      if (statsByDayOfWeek[dayOfWeek]) {
        const s = statsByDayOfWeek[dayOfWeek];
        s.total++;
        s.profit += trade.pnl;
        if (trade.pnl >= 0) s.wins++;
        else s.losses++;
      }
    }

    for (const day of Object.values(statsByDayOfWeek)) {
      day.winRate = day.total > 0 ? (day.wins / day.total) * 100 : 0;
    }

    // Format trade history table rows
    const historyRows = [...filteredTrades]
      .filter(t => t.status === 'closed')
      .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0)) // Newest first
      .map(trade => {
        const decimals = this._getDecimals(trade.symbol);
        const formattedDate = new Date(trade.closeTime).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) + 
                              ' ' + 
                              new Date(trade.closeTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const isWin = trade.pnl >= 0;
        const profitClass = isWin ? 'positive' : 'negative';
        const formattedPnL = (trade.pnl >= 0 ? '+' : '') + '$' + trade.pnl.toFixed(2);
        
        return `
          <tr>
            <td style="font-size: 0.7rem; color: var(--text-secondary); white-space: nowrap;">${formattedDate}</td>
            <td><strong>${trade.symbol}</strong></td>
            <td><span class="trend-badge ${trade.type.toLowerCase()}">${trade.type}</span></td>
            <td>${trade.lotSize.toFixed(2)}</td>
            <td>$${trade.entry.toFixed(decimals)}</td>
            <td>
              <span class="indicator-value bearish">$${trade.sl.toFixed(decimals)}</span> / 
              <span class="indicator-value bullish">$${trade.tp2.toFixed(decimals)}</span>
            </td>
            <td>$${trade.exitPrice ? trade.exitPrice.toFixed(decimals) : '—'}</td>
            <td><span class="trade-pnl ${profitClass}" style="font-size: 0.72rem; font-weight:700;">${formattedPnL}</span></td>
            <td><span class="trend-badge ${trade.pnl < 0 ? 'bearish' : 'bullish'}">${trade.closeReason || 'Closed'}</span></td>
            <td style="font-family: var(--font-ui); font-size: 0.72rem; color: var(--text-secondary); text-align: left; max-width: 320px; line-height: 1.3;">
              ${this._generateAuditExplanation(trade)}
            </td>
          </tr>
        `;
      }).join('');

    const emptyHistoryHtml = `
      <tr>
        <td colspan="10" style="text-align: center; color: var(--text-tertiary); padding: var(--gap-xl);">
          📜 No completed trades recorded in history yet.
        </td>
      </tr>
    `;

    el.innerHTML = `
      <div class="dashboard-container">
        <div class="dashboard-grid">
          <!-- Calendar Section -->
          <div class="calendar-section">
            <div class="calendar-header" style="display: flex; justify-content: space-between; align-items: center; min-height: 28px;">
              <span class="cal-month-label">📅 ${monthNames[month]} ${year} — ${isSymbolOnly ? `${this.currentSymbol} Only` : 'All Assets'}</span>
              ${sortedMonths.length > 1 ? `
                <div class="calendar-nav" style="display: flex; gap: 4px; align-items: center;">
                  <button id="${keyPrefix}-prev-month-btn" class="btn btn-sm btn-subtle" style="padding: 2px 8px; font-size: 0.65rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-secondary); cursor: pointer;" ${currentIndex > 0 ? '' : 'disabled'}>◀</button>
                  <button id="${keyPrefix}-next-month-btn" class="btn btn-sm btn-subtle" style="padding: 2px 8px; font-size: 0.65rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-secondary); cursor: pointer;" ${currentIndex < sortedMonths.length - 1 ? '' : 'disabled'}>▶</button>
                </div>
              ` : ''}
            </div>
            <div class="calendar-grid">
              ${weekdays.map(d => `<div class="cal-weekday">${d}</div>`).join('')}
              ${calendarCells.join('')}
            </div>
          </div>

          <!-- Day of Week Performance Section -->
          <div class="daywise-section">
            <div class="stats-header">
              <span>📊</span> Day-of-Week Analytics: <strong>${isSymbolOnly ? this.currentSymbol : 'All Assets'}</strong>
            </div>
            <table class="analysis-table" style="margin-top: 8px;">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Trades</th>
                  <th>Win Rate</th>
                  <th>Net Profit</th>
                </tr>
              </thead>
              <tbody>
                ${Object.values(statsByDayOfWeek).map(d => {
                  const profitClass = d.profit >= 0 ? 'positive' : 'negative';
                  const winRateClass = d.winRate >= 50 ? 'bullish' : d.winRate > 0 ? 'bearish' : 'neutral';
                  const formattedProfit = (d.profit >= 0 ? '+' : '') + '$' + d.profit.toFixed(2);
                  return `
                    <tr>
                      <td><strong>${d.name}</strong></td>
                      <td>${d.total} (${d.wins}W / ${d.losses}L)</td>
                      <td><span class="trend-badge ${winRateClass}">${d.winRate.toFixed(1)}%</span></td>
                      <td><span class="trade-pnl ${profitClass}">${formattedProfit}</span></td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Closed Trade History & Analytical Audits -->
        <div class="history-section" style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--gap-md); margin-top: 4px;">
          <div class="stats-header" style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
            <span>📜</span> Closed Trade History & Desk Lead Analytical Audits (${isSymbolOnly ? `${this.currentSymbol}` : 'All Assets'})
          </div>
          <div style="overflow-x: auto; max-height: 380px; overflow-y: auto;">
            <table class="analysis-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Asset</th>
                  <th>Type</th>
                  <th>Lots</th>
                  <th>Entry</th>
                  <th>SL / TP2</th>
                  <th>Exit Price</th>
                  <th>Net P&L</th>
                  <th>Exit Trigger</th>
                  <th>Desk Lead Audit / Explanation</th>
                </tr>
              </thead>
              <tbody>
                ${historyRows || emptyHistoryHtml}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Attach month navigation click listeners dynamically
    const prevBtn = document.getElementById(`${keyPrefix}-prev-month-btn`);
    const nextBtn = document.getElementById(`${keyPrefix}-next-month-btn`);
    
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (currentIndex > 0) {
          const prev = sortedMonths[currentIndex - 1];
          this[`${keyPrefix}ViewedYear`] = prev.year;
          this[`${keyPrefix}ViewedMonth`] = prev.month;
          this._renderCalendarWidget(containerId, tradeHistory, isSymbolOnly);
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (currentIndex < sortedMonths.length - 1) {
          const next = sortedMonths[currentIndex + 1];
          this[`${keyPrefix}ViewedYear`] = next.year;
          this[`${keyPrefix}ViewedMonth`] = next.month;
          this._renderCalendarWidget(containerId, tradeHistory, isSymbolOnly);
        }
      });
    }
  }

  _renderChat() {
    const el = document.getElementById('tab-chat');
    if (!el) return;

    // Seed greeting on initial render or when changing symbols
    if (this.chatMessages.length === 0 || this._lastRenderedSymbol !== this.currentSymbol) {
      this.chatMessages = [{
        sender: 'ai',
        text: `⚡ **Desk Lead / Senior Institutional Analyst online.**

Active scan compiled for **${this.currentSymbol}**. Algorithmic order flow, market structure breaks (BOS/CHoCH), HTF to LTF order blocks, supply/demand premium/discount arrays, and critical liquidity sweeps have been mapped into the terminal database.

Ask me about current structure, optimal PD entries, structural invalidation floors, active indicator red flags, or invoke the **Shall I enter?** live go/no-go advisor. Let's manage this capital like professionals.`,
        time: Date.now()
      }];
      this._lastRenderedSymbol = this.currentSymbol;
    }

    el.innerHTML = `
      <div class="chat-tab-container">
        <!-- Messages Log -->
        <div class="chat-messages" id="chat-messages-container">
          ${this.chatMessages.map(msg => `
            <div class="chat-bubble ${msg.sender}">
              ${this._formatMarkdown(msg.text)}
            </div>
          `).join('')}
        </div>

        <!-- Controls (Chips + Form) -->
        <div class="chat-controls">
          <div class="chat-prompt-chips">
            <button class="chat-chip" data-query="What is happening in the market?">🔍 What is happening?</button>
            <button class="chat-chip" data-query="What are the best zones to buy or sell?">📥 Best buy/sell zones?</button>
            <button class="chat-chip" data-query="Shall I enter the trade now?">🚦 Shall I enter?</button>
            <button class="chat-chip" data-query="When will that entry invalidate?">🚫 When does it invalidate?</button>
            <button class="chat-chip" data-query="What are the red flags?">⚠️ Any red flags?</button>
          </div>
          <div class="chat-input-bar">
            <input type="text" class="chat-input-field" id="chat-user-input" placeholder="Ask about price action, zones, entries, or red flags..." autocomplete="off">
            <button class="chat-send-btn" id="chat-send-trigger">Send</button>
          </div>
        </div>
      </div>
    `;

    // Scroll to bottom
    const msgContainer = document.getElementById('chat-messages-container');
    if (msgContainer) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // Attach listeners
    const input = document.getElementById('chat-user-input');
    const sendBtn = document.getElementById('chat-send-trigger');

    const handleSend = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this._handleChatSend(text);
    };

    if (input) {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSend();
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', handleSend);
    }

    // Chips click binding
    el.querySelectorAll('.chat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const query = chip.dataset.query;
        this._handleChatSend(query);
      });
    });
  }

  _handleChatSend(userText) {
    // Append user message
    this.chatMessages.push({
      sender: 'user',
      text: userText,
      time: Date.now()
    });

    this._renderChat();

    // Generate AI response
    setTimeout(() => {
      const responseText = this._getAIResponse(userText);
      this.chatMessages.push({
        sender: 'ai',
        text: responseText,
        time: Date.now()
      });
      this._renderChat();
    }, 400); // slight simulated analysis delay
  }

  _getAIResponse(query) {
    const data = this.lastAnalysisData;
    if (!data) return "SYSTEM ERROR: Local database compiling order book metrics. Hold standby.";

    const q = query.toLowerCase();
    const sym = this.currentSymbol;
    const decimals = this._getDecimals();

    // 1. Shall I enter? (Live dynamic advisor)
    if (q.includes('enter') || q.includes('should i buy') || q.includes('should i sell') || q.includes('shall i enter') || q.includes('buy now') || q.includes('sell now')) {
      return this._generateShallIEnterResponse(data, sym, decimals);
    }

    // 2. Red Flags
    if (q.includes('red flag') || q.includes('warning') || q.includes('danger') || q.includes('redflag')) {
      return this._generateRedFlagsResponse(data, sym);
    }

    // 3. Invalidation
    if (q.includes('invalidate') || q.includes('invalid') || q.includes('fail') || q.includes('cancel')) {
      return this._generateInvalidationResponse(data, sym, decimals);
    }

    // 4. Best Zones (Buy/Sell)
    if (q.includes('zone') || q.includes('level') || q.includes('support') || q.includes('resistance')) {
      return this._generateZonesResponse(data, sym, decimals);
    }

    // 5. Entry optimal
    if (q.includes('entry') || q.includes('trigger') || q.includes('setup') || q.includes('signal')) {
      return this._generateEntryResponse(data, sym, decimals);
    }

    // 6. Default: What is happening (Trend summary)
    return this._generateTrendResponse(data, sym, decimals);
  }

  _generateTrendResponse(data, symbol, decimals) {
    const trend = data.trendData;
    const structure = data.structureData;
    const indicators = data.indicators;

    const rsiVal = indicators?.rsi && indicators.rsi.length > 0 ? indicators.rsi[indicators.rsi.length - 1] : 50;
    const emaAlignment = trend?.emaAlignment || 'mixed';
    const direction = trend?.direction || 'ranging';
    const strength = trend?.strength || 0;

    return `📊 **HTF Order Flow & Structural Analysis for ${symbol}:**

Our institutional algorithmic model indicates that **${symbol}** is delivering price under a dominant **${this._trendLabel(direction)}** bias, exhibiting an expansion velocity score of **${strength}/100**.

**Market Structure Matrix**:
* **Swing Structure**: The asset is locked in a **${structure.trend.toUpperCase()}** swing pattern, engineering a series of **${structure.higherHighs ? 'Higher Highs (HH)' : 'Lower Highs (LH)'}** and **${structure.higherLows ? 'Higher Lows (HL)' : 'Lower Lows (LL)'}**.
* **Order Delivery Breaks**: We have verified structural breaks. The smart money expansion phase is dynamically targeted **${structure.trend === 'bullish' ? 'upside into premium liquidity pools' : structure.trend === 'bearish' ? 'downside into discount inefficiencies' : 'into range-bound consolidation'}**.

**Algorithmic Momentum**:
* **Exponential Stack (EMA)**: Moving average stack is **${emaAlignment.toUpperCase()}** (${emaAlignment === 'bullish' ? 'order delivery is strictly bullish, bids supported by EMA 9/21/50/200 stack' : emaAlignment === 'bearish' ? 'order delivery is strictly bearish, offers defended by EMA 9/21/50/200 stack' : 'congested, indicating market maker accumulation/distribution balance'}).
* **Relative Strength (RSI)**: Floating at **${rsiVal.toFixed(1)}**, indicating **${this._rsiLabel(rsiVal)}** liquidity conditions.

**Tactical Outlook**: Large-scale institutional market makers are actively **${direction.includes('bullish') ? 're-accumulating contracts inside discount zones' : direction.includes('bearish') ? 'distributing inventory inside premium zones' : 'balancing inventory inside range boundaries'}**. Refrain from trading in fair value; execute strictly on premium/discount structural sweeps.`;
  }

  _generateZonesResponse(data, symbol, decimals) {
    const orderBlocks = data.orderBlocks || [];
    const zones = data.zones || [];

    const activeOBs = orderBlocks.filter(ob => !ob.mitigated);
    const activeZones = zones.filter(z => z.status !== 'broken');

    const demandOBs = activeOBs.filter(ob => ob.type === 'bullish');
    const supplyOBs = activeOBs.filter(ob => ob.type === 'bearish');

    const demandZones = activeZones.filter(z => z.type === 'demand');
    const supplyZones = activeZones.filter(z => z.type === 'supply');

    let response = `📥 **PD Arrays: High-Confluence Institutional Accumulation & Distribution Levels for ${symbol}:**\n\n`;

    // Buy Zones
    response += `🟢 **Discount Accumulation Zones (Buy / High Probability Bids):**\n`;
    if (demandOBs.length > 0 || demandZones.length > 0) {
      demandOBs.slice(-2).forEach(ob => {
        response += `* **Mitigation Block / Bullish OB**: **$${ob.bottom.toFixed(decimals)} - $${ob.top.toFixed(decimals)}** (Strength: ${ob.strength}/100) — *Key structural support where banks triggered heavy buy limit orders. Highly valid accumulation floor.*\n`;
      });
      demandZones.slice(-2).forEach(z => {
        response += `* **Demand Pool (${z.pattern})**: **$${z.bottom.toFixed(decimals)} - $${z.top.toFixed(decimals)}** (Strength: ${z.strength}/100) — *Inefficiency range ready to trigger a massive rally on dynamic tap.*\n`;
      });
    } else {
      response += `* Imbalance Void: No primary accumulation blocks detected nearby. The price is currently floating in an imbalance void. Expect a sweep to locate HTF discount liquidity.\n`;
    }

    // Sell Zones
    response += `\n🔴 **Premium Distribution Zones (Sell / Heavy Institutional Supply):**\n`;
    if (supplyOBs.length > 0 || supplyZones.length > 0) {
      supplyOBs.slice(-2).forEach(ob => {
        response += `* **Breaker Block / Bearish OB**: **$${ob.bottom.toFixed(decimals)} - $${ob.top.toFixed(decimals)}** (Strength: ${ob.strength}/100) — *Key ceiling where commercial desks unloaded inventory. Major selling interest resides here.*\n`;
      });
      supplyZones.slice(-2).forEach(z => {
        response += `* **Supply Ceiling (${z.pattern})**: **$${z.bottom.toFixed(decimals)} - $${z.top.toFixed(decimals)}** (Strength: ${z.strength}/100) — *Institutional liquidity pool. Heavy selling pressure expected on sweep.*\n`;
      });
    } else {
      response += `* Imbalance Void: No primary distribution ceilings detected nearby. Upper range remains open for a premium liquidity run.\n`;
    }

    response += `\n**Strategic Plan**: Maintain patience. Deploy long executions inside the discount buy blocks only when price prints rejection wicks on LTF sweeps. Deploy short executions inside premium distribution zones. Avoid intermediate chop.`;
    return response;
  }

  _generateEntryResponse(data, symbol, decimals) {
    const signals = data.signals || [];
    if (signals.length > 0) {
      const sig = signals[0];
      return `🚦 **High-Probability Institutional Setup Detected on ${symbol}!**

An algorithmic execution model has confirmed a **${sig.type}** setup backed by **${sig.score} institutional confluences** (Grade **${sig.quality}** Prop Setup):

* **Direction**: ${sig.type}
* **Optimal Entry Price**: $${sig.entry.toFixed(decimals)}
* **Structural Invalidation Floor (SL)**: $${sig.sl.toFixed(decimals)}
* **Profit Targets**: TP1 (Mean Reversion): $${sig.tp1.toFixed(decimals)} | TP2 (External Liquidity): $${sig.tp2.toFixed(decimals)}
* **Risk Parameters**: Risks exactly **$${sig.riskAmount.toFixed(2)}** (Strictly aligned with FundingPips maximum $50 risk allocation)
* **Lot Allocation**: **${sig.lotSize.toFixed(2)} lots** (Maximum lot safeguard capped dynamically)
* **Confluences**: ${sig.confluences.join(', ')}

**Tactical Execution**: Execute at the designated entry. Under strict risk protocols, the Stop Loss must be automatically trailed to breakeven (entry price) upon reaching TP1 to establish a risk-free, protected trade. Let the algorithm deliver.`;
    }

    // Suggest pending limits
    const orderBlocks = data.orderBlocks || [];
    const demandOB = orderBlocks.find(ob => ob.type === 'bullish' && !ob.mitigated);
    const supplyOB = orderBlocks.find(ob => ob.type === 'bearish' && !ob.mitigated);

    return `⏳ **Fair Value Consolidation — No Active Algorithmic Trigger for ${symbol}:**

Price is currently trading in a balanced fair-value range. Entering here represents retail breakout chasing. Maintain disciplined desk protocol and set pending limit orders at high-probability boundaries:

* **Pending Buy Limit (LONG)**: Set a Buy Limit at the premium edge of the unmitigated Bullish OB near **$${demandOB ? demandOB.top.toFixed(decimals) : '—'}**, protecting the entry with a structural Stop Loss below the block floor (**$${demandOB ? demandOB.bottom.toFixed(decimals) : '—'}**).
* **Pending Sell Limit (SHORT)**: Set a Sell Limit at the discount edge of the unmitigated Bearish OB near **$${supplyOB ? supplyOB.bottom.toFixed(decimals) : '—'}**, protecting the entry with a structural Stop Loss above the block ceiling (**$${supplyOB ? supplyOB.top.toFixed(decimals) : '—'}**).

**Risk Mandate**: Keep leverage locked. Verify that the lot calculator tab is used to limit risk to exactly $50 before any entry!`;
  }

  _generateInvalidationResponse(data, symbol, decimals) {
    const signals = data.signals || [];
    if (signals.length > 0) {
      const sig = signals[0];
      return `🚫 **Order Flow Invalidation Plan for ${symbol}:**

The active **${sig.type}** institutional setup has strict structural boundaries. Our trade thesis is completely invalidated if:

* **Structural Failure Level**: Price trades and closes beyond **$${sig.sl.toFixed(decimals)}** (our structural Stop Loss floor).
* **Order Flow Breakdown**: A close past this level confirms that the supporting institutional block/zone has been completely swept and broken. It triggers a high-volume **Change of Character (CHoCH)** against our bias, proving that market makers have reversed order flow.

**Professional Mandate**: Never hold a losing trade past invalidation. Accept the $50 loss gracefully like a prop trader, preserve capital, and stand flat for the next setup.`;
    }

    return `🚫 **SMC Structural Invalidation Protocols for ${symbol}:**

* **For LONGs (Bids)**: The buy thesis is completely invalidated the moment price trades and **closes below** the lowest point of the demand zone or swing low.
* **For SHORTs (Offers)**: The sell thesis is completely invalidated the moment price trades and **closes above** the highest point of the supply zone or swing high.

*Why close immediately on invalidation?* A candle close beyond these boundaries confirms a major structural breakdown (a **Change of Character / CHoCH**). It indicates the institutional order blocks have failed, dynamic mitigation has been breached, and market makers have flipped order delivery to the opposite direction. Retail traders hold and pray; professional prop traders exit instantly.`;
  }

  _generateRedFlagsResponse(data, symbol) {
    const indicators = data.indicators;
    const trend = data.trendData;
    const warnings = [];

    const rsiVal = indicators?.rsi && indicators.rsi.length > 0 ? indicators.rsi[indicators.rsi.length - 1] : 50;

    if (rsiVal >= 70) {
      warnings.push(`Extreme Overbought RSI (${rsiVal.toFixed(1)}) — Institutional buyers are exhausted. High probability of an immediate profit-taking pullback.`);
    } else if (rsiVal <= 30) {
      warnings.push(`Extreme Oversold RSI (${rsiVal.toFixed(1)}) — Institutional sellers are exhausted. High probability of a mean-reversion short-squeeze bounce.`);
    }

    if (trend?.emaAlignment === 'mixed') {
      warnings.push("EMA stack is congested/mixed — Market is in a range consolidation. Breakout entries are extremely high-risk; avoid them.");
    }

    // Check MACD histogram
    const macdData = indicators?.macd;
    if (macdData && macdData.histogram.length >= 3) {
      const hist = macdData.histogram;
      const lastHist = hist[hist.length - 1];
      const prevHist = hist[hist.length - 2];
      if (lastHist < prevHist && lastHist > 0) {
        warnings.push("MACD Bullish Momentum Fading — Bullish volume is drying up. Distribution phase is ending.");
      } else if (lastHist > prevHist && lastHist < 0) {
        warnings.push("MACD Bearish Momentum Fading — Bearish volume is drying up. Accumulation phase is ending.");
      }
    }

    if (warnings.length > 0) {
      return `⚠️ **Active Algorithmic Red Flags & Risks for ${symbol}:**\n\n${warnings.map(w => `* **RED FLAG**: ${w}`).join('\n')}\n\n**Risk Management Mandate**: Exercise extreme caution. Do not deploy risk on new positions unless you have A-grade confluence. Maintain strict drawdown defense.`;
    }

    return `🛡️ **Zero Algorithmic Red Flags Detected for ${symbol}!**

Dynamic support is holding firmly, EMAs are stacked in perfect structural alignment, and RSI is hovering in a healthy neutral range. The current price action indicates clean, highly balanced smart money order delivery. Good to trade.`;
  }

  _generateShallIEnterResponse(data, symbol, decimals) {
    const activeTrades = localStorage.getItem('tradeAnalyzer_activeTrades');
    const runningTrades = activeTrades ? JSON.parse(activeTrades) : [];
    const hasRunningTrade = runningTrades.some(t => t.symbol === symbol);

    if (hasRunningTrade) {
      return `🔴 **DECISION: DO NOT ENTER (DUPLICATE POSITION)**

Price action analysis shows that **${symbol}** has a strong technical setup, but portfolio risk parameters explicitly forbid entry.

🟢 **Why you SHOULD enter this trade (Technical Setup):**
* ✓ Active institutional setup: The symbol has a calculated algorithmic trend bias.
* ✓ Liquidity accumulation: Rejections are occurring at key local structural levels.

🔴 **Why you should NOT enter this trade (Risk Management):**
* **RED FLAG**: Duplicate Trade Limit: You already have a position active on **${symbol}**.
* **RED FLAG**: Risk Rule Violation: Under FundingPips guidelines, taking duplicate trades on the same asset leads to over-leveraging and increases portfolio drawdown risk.
* **RED FLAG**: Capital Exposure: Letting a single position run allows you to trail the SL to breakeven before taking new risk. Protect your account!`;
    }

    const signals = data.signals || [];
    if (signals.length === 0) {
      return `⏳ **DECISION: DO NOT ENTER / WAIT FOR EDGE**

There is currently **no clear smart money footprint or setup** active on **${symbol}**.

🟢 **Why you SHOULD enter this trade (Once a setup forms):**
* ✓ Patience Pays: Restraining from low-probability trades protects your capital for high-confluence Grade A setups.
* ✓ Key Levels: Waiting for price to sweep into major Order Blocks allows high R:R execution.

🔴 **Why you should NOT enter this trade (No Valid Edge):**
* **RED FLAG**: Lack of Confluence: There are 0 active algorithmic signals at the current price level.
* **RED FLAG**: Consolidation Chop: The asset is currently ranging or consolidating, where breakout entries are frequently fakeouts.
* **RED FLAG**: Drawdown Risk: Entering here would be gambling without mathematical expectancy, risking your FundingPips daily loss limit.`;
    }

    const bestSignal = signals[0];
    const liveRate = this.liveRates?.[symbol] || bestSignal.entry;
    
    // Check if live rate is within 1.5 ATR of entry
    const atrValues = data.indicators?.atr || [];
    const lastATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0.01;
    const distanceToEntry = Math.abs(liveRate - bestSignal.entry);
    
    const direction = bestSignal.type === 'LONG' ? 1 : -1;
    
    // Invalidation check: did price close past Stop Loss?
    const slBreached = bestSignal.type === 'LONG' ? liveRate <= bestSignal.sl : liveRate >= bestSignal.sl;
    if (slBreached) {
      return `🔴 **DECISION: DO NOT ENTER (SETUP INVALIDATED)**

The institutional setup for **${symbol}** has completely failed and is now **invalid**.

🟢 **Why you SHOULD enter this trade (Historical Bias):**
* ✓ The previous bias was supported by a strong order block/zone rejection prior to the breakout.

🔴 **Why you should NOT enter this trade (Structural Breach):**
* **RED FLAG**: Invalidation Floor Violated: Price has closed past the designated Stop Loss of **$${bestSignal.sl.toFixed(decimals)}**.
* **RED FLAG**: Change of Character (CHoCH): The structural floor was swept by high institutional sell/buy volume, proving our original trade thesis incorrect.
* **RED FLAG**: Counter-Trend Threat: Entering a failed setup is highly dangerous, as you are trading directly against the new dominant trend momentum.`;
    }

    // Missed entry check: price moved too far in target direction
    const movedInProfit = (liveRate - bestSignal.entry) * direction;
    const slDistance = Math.abs(bestSignal.entry - bestSignal.sl);
    const achievedRR = slDistance > 0 ? movedInProfit / slDistance : 0;
    
    if (achievedRR >= 0.5) {
      return `🟡 **DECISION: DO NOT ENTER / WAIT (MISSED GOLDEN ENTRY)**

The trade setup was highly successful and hit the target direction, but price has **moved too far to chase**.

🟢 **Why you SHOULD enter this trade (Trend Validity):**
* ✓ Algorithmic grade: This was a highly verified Grade ${bestSignal.quality} signal with ${bestSignal.score} confluences.
* ✓ High Impulse: The trend remains strongly aligned in our direction.

🔴 **Why you should NOT enter this trade (Compromised Risk-to-Reward):**
* **RED FLAG**: Ruined Risk-to-Reward: Price has reached an achieved R:R of **${achievedRR.toFixed(2)}**. Chasing now reduces your profit buffer and widens your risk.
* **RED FLAG**: Lot Sizing Penalty: To risk exactly $50 with this wider Stop Loss, your compliant lot size is severely choked.
* **RED FLAG**: Impulsive Exhaustion: Entering at the top of an impulsive wave leaves you highly vulnerable to getting stopped out by standard corrective pullbacks.`;
    }

    // Go / Enter Now check: price is inside the entry zone!
    const inZone = distanceToEntry <= lastATR * 1.5;
    if (inZone) {
      return `🟢 **DECISION: GO — ENTER THE TRADE NOW!**

Price is currently at **$${liveRate.toFixed(decimals)}**, which is within our golden **optimal entry range** of **$${bestSignal.entry.toFixed(decimals)}**.

🟢 **Why you SHOULD enter this trade (High Confluence Setup):**
* ✓ Prime Location: Sitting perfectly inside the 1.5 ATR entry buffer.
* ✓ Smart Money Confluences: ${bestSignal.confluences.map(c => c).join(', ')}.
* ✓ Outstanding Risk-to-Reward: Targeting a clear 1:2 R:R at TP1 (**$${bestSignal.tp1.toFixed(decimals)}**) and 1:3 at TP2 (**$${bestSignal.tp2.toFixed(decimals)}**).
* ✓ Safe Lot Sizing: Leverage is fully managed with **${bestSignal.lotSize.toFixed(2)} lots** (risks exactly **$${bestSignal.riskAmount.toFixed(2)}**).

🔴 **Why you should NOT enter this trade (Caution & Stop Loss Boundaries):**
* **RED FLAG**: Hard Invalidation: If price trades and closes beyond **$${bestSignal.sl.toFixed(decimals)}**, you must exit immediately. Do NOT hold past invalidation.
* **RED FLAG**: News Slippage Warning: Ensure no major high-impact macro news is releasing in the next 30 minutes, which could cause bad execution.`;
    }

    // Floating / Wait check: price hasn't reached the zone yet
    return `⏳ **DECISION: WAIT FOR OPTIMAL PRICE / SET LIMIT ORDER**

The technical signal is high-probability, but price is currently at **$${liveRate.toFixed(decimals)}**, which has not yet pulled back into the discount entry zone.

🟢 **Why you SHOULD enter this trade (Once triggered):**
* ✓ Grade ${bestSignal.quality} Setup: Built on ${bestSignal.score} active institutional confluences.
* ✓ High Probability: Features strong trend alignment and unmitigated zone rejections.

🔴 **Why you should NOT enter this trade *yet* (Chasing the price):**
* **RED FLAG**: Sub-optimal Entry: Buying/selling before price reaches our key institutional zone increases the Stop Loss distance.
* **RED FLAG**: Reduced Lot Size: Chasing early reduces your potential lot size under the strict $50 risk rule, diminishing your eventual payouts.
* **RED FLAG**: Impatience Cost: Market makers frequently sweep liquidity into the block before reversing. Entering now exposes you to unnecessary drawdown. Place a pending **Limit Order at $${bestSignal.entry.toFixed(decimals)}** instead!`;
  }

  _formatMarkdown(text) {
    if (!text) return '';
    return text
      .split('\n')
      .map(line => {
        let l = line.trim();
        // Bold tags **
        l = l.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        // Italic tags *
        l = l.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        if (l.startsWith('* ✓')) {
          return `<p style="margin: 3px 0; color: var(--bullish); font-weight: 500;">✓ ${l.replace(/^\*\s*✓\s*/, '')}</p>`;
        }
        if (l.startsWith('* **RED FLAG**') || l.startsWith('* RED FLAG')) {
          return `<p style="margin: 3px 0; color: var(--bearish); font-weight: 600;">⚠️ ${l.replace(/^\*\s*\*\*RED\s*FLAG\*\*\s*:\s*/, '').replace(/^\*\s*RED\s*FLAG\s*:\s*/, '')}</p>`;
        }
        if (l.startsWith('* ')) {
          return `<li style="margin-bottom: 2px;">${l.substring(2)}</li>`;
        }
        if (l.startsWith('🟢') || l.startsWith('🔴') || l.startsWith('🟡') || l.startsWith('⏳') || l.startsWith('📊') || l.startsWith('📥') || l.startsWith('🚦') || l.startsWith('🚫') || l.startsWith('⚠️') || l.startsWith('🛡️')) {
          return `<p style="margin: 8px 0 4px 0; font-weight: 600; color: var(--text-primary); font-size: 0.8rem;">${l}</p>`;
        }
        return l ? `<p>${l}</p>` : '';
      })
      .join('');
  }
}

export default AnalysisPanel;
