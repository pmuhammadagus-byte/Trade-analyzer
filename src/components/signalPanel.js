/**
 * Signal Panel — Displays active signals with lot sizing, SL/TP, and confluence details
 */
export class SignalPanel {
  constructor({ onTakeTrade }) {
    this.onTakeTrade = onTakeTrade;
    this.signals = [];
    this.signalHistory = [];
  }

  updateSignals(signals, symbol) {
    this.signals = signals || [];
    this._render(symbol);
  }

  _render(symbol) {
    const list = document.getElementById('signal-list');
    const countBadge = document.getElementById('signal-count');
    if (!list) return;

    if (countBadge) {
      countBadge.textContent = this.signals.length;
    }

    if (this.signals.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📡</span>
          <p>Scanning for setups...</p>
          <p style="font-size: 0.68rem; color: var(--text-muted); margin-top: 4px;">
            Waiting for confluence at key levels
          </p>
        </div>`;
      return;
    }

    list.innerHTML = this.signals.map((sig, idx) => this._renderSignalCard(sig, idx, symbol)).join('');

    // Attach event listeners
    list.querySelectorAll('.btn-take-trade').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index);
        if (this.signals[index]) {
          this.onTakeTrade(this.signals[index]);
        }
      });
    });
  }

  _renderSignalCard(signal, index, symbol) {
    const isLong = signal.type === 'LONG';
    const dirClass = isLong ? 'long' : 'short';
    const decimals = this._getDecimals(signal.symbol || symbol);
    const gradeClass = `grade-${signal.quality.toLowerCase()}`;

    return `
      <div class="signal-card ${dirClass} signal-new" id="signal-${index}">
        <div class="signal-header">
          <span class="signal-direction ${dirClass}">${signal.type}</span>
          <span class="signal-quality ${gradeClass}">${signal.quality}</span>
        </div>
        <div class="signal-levels">
          <div class="signal-level">
            <span class="signal-level-label">Entry</span>
            <span class="signal-level-value entry">${signal.entry.toFixed(decimals)}</span>
          </div>
          <div class="signal-level">
            <span class="signal-level-label">Stop Loss</span>
            <span class="signal-level-value sl">${signal.sl.toFixed(decimals)}</span>
          </div>
          <div class="signal-level">
            <span class="signal-level-label">TP1 (1:2)</span>
            <span class="signal-level-value tp">${signal.tp1.toFixed(decimals)}</span>
          </div>
          <div class="signal-level">
            <span class="signal-level-label">TP2 (1:3)</span>
            <span class="signal-level-value tp">${signal.tp2 ? signal.tp2.toFixed(decimals) : '—'}</span>
          </div>
          <div class="signal-level">
            <span class="signal-level-label">Lot Size</span>
            <span class="signal-level-value lots">${signal.lotSize.toFixed(2)}</span>
          </div>
          <div class="signal-level">
            <span class="signal-level-label">Risk</span>
            <span class="signal-level-value sl">$${signal.riskAmount.toFixed(2)}</span>
          </div>
        </div>
        <div class="signal-meta">
          <span class="signal-rr">R:R ${signal.rrRatio.toFixed(1)}</span>
          <span class="signal-risk">${signal.slPips ? signal.slPips.toFixed(1) + ' pips' : ''}</span>
        </div>
        <div class="signal-confluences">
          ${(signal.confluences || []).map(c => `<span class="confluence-tag">✓ ${c}</span>`).join('')}
        </div>
        <div class="signal-actions">
          <button class="btn btn-success btn-sm btn-take-trade" data-index="${index}">
            Take Trade
          </button>
        </div>
      </div>
    `;
  }

  _getDecimals(symbol) {
    if (symbol === 'XAUUSD') return 2;
    if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') return 2;
    return 5;
  }
}

export default SignalPanel;
