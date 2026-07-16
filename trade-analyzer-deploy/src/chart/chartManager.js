/**
 * Chart Manager — TradingView Lightweight Charts v4
 * Renders candlestick chart with overlays for OBs, zones, EMAs, and signals.
 */
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';

export class ChartManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.emaLines = {};
    this.markers = [];
    this.drawnObjects = { zones: [], orderBlocks: [], signalLines: [] };
    this._init();
  }

  _init() {
    this.chart = createChart(this.container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b92a5',
        fontFamily: "'Inter', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(59, 130, 246, 0.3)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#3b82f6',
        },
        horzLine: {
          color: 'rgba(59, 130, 246, 0.3)',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#3b82f6',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.06)',
        scaleMargins: { top: 0.12, bottom: 0.12 },
        autoScale: true,
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.06)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseButton: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          price: true,
          time: true,
        },
      },
    });

    // Candlestick series
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#00e5a0',
      downColor: '#ff4757',
      borderUpColor: '#00e5a0',
      borderDownColor: '#ff4757',
      wickUpColor: 'rgba(0, 229, 160, 0.6)',
      wickDownColor: 'rgba(255, 71, 87, 0.6)',
    });

    // Volume series
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });

    this.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    // Handle resize with mobile clientWidth guards
    this._resizeObserver = new ResizeObserver(() => {
      if (this.container && this.chart) {
        let w = this.container.clientWidth;
        let h = this.container.clientHeight;
        if (w < 100) {
          w = this.container.parentElement?.clientWidth || window.innerWidth - 20;
        }
        if (h < 100) {
          h = 380;
        }
        this.chart.applyOptions({
          width: w,
          height: h,
        });
      }
    });
    this._resizeObserver.observe(this.container);
  }

  /**
   * Set historical candle data
   */
  setData(candles, symbol = 'BTCUSDT') {
    this.symbol = symbol;
    if (!candles || candles.length === 0) return;

    // Explicitly align chart size on data load to heal asynchronous mobile layouts
    if (this.container && this.chart) {
      let w = this.container.clientWidth;
      let h = this.container.clientHeight;
      if (w < 100) {
        w = this.container.parentElement?.clientWidth || window.innerWidth - 20;
      }
      if (h < 100) {
        h = 380;
      }
      this.chart.applyOptions({
        width: w,
        height: h,
      });
    }

    this.lastClose = candles[candles.length - 1].close;

    // Configure exact precision based on asset class
    const isForex = ['GBPUSD', 'USDCAD'].includes(symbol);
    const precision = isForex ? 5 : 2;
    const minMove = isForex ? 0.00001 : 0.01;

    // Apply precision formatting to candle series
    this.candleSeries.applyOptions({
      priceFormat: {
        type: 'price',
        precision: precision,
        minMove: minMove,
      },
    });

    const candleData = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const volumeData = candles.map(c => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open
        ? 'rgba(0, 229, 160, 0.2)'
        : 'rgba(255, 71, 87, 0.2)',
    }));

    this.candleSeries.setData(candleData);
    this.volumeSeries.setData(volumeData);

    // Reset vertical price scale to autoScale, clearing any manual zooms/drags
    this.chart.priceScale('right').applyOptions({ autoScale: true });

    // Comfortably view the last 100 candles with a 5-bar right-offset padding
    const total = candleData.length;
    if (total > 0) {
      this.chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, total - 100),
        to: total + 5,
      });
    } else {
      this.chart.timeScale().fitContent();
    }
  }

  /**
   * Update or add a single candle (real-time)
   */
  updateCandle(candle) {
    if (!candle) return;

    this.lastClose = candle.close;

    this.candleSeries.update({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });

    this.volumeSeries.update({
      time: candle.time,
      value: candle.volume,
      color: candle.close >= candle.open
        ? 'rgba(0, 229, 160, 0.2)'
        : 'rgba(255, 71, 87, 0.2)',
    });
  }

  /**
   * Draw EMA lines
   */
  drawEMAs(emaData) {
    // Remove old EMA lines
    Object.values(this.emaLines).forEach(line => {
      this.chart.removeSeries(line);
    });
    this.emaLines = {};

    const emaColors = {
      9: '#f59e0b',   // amber
      21: '#06b6d4',  // cyan
      50: '#3b82f6',  // blue
      200: '#8b5cf6', // purple
    };

    for (const [period, values] of Object.entries(emaData)) {
      if (!values || values.length === 0) continue;

      const color = emaColors[period] || '#8b92a5';
      const line = this.chart.addLineSeries({
        color: color,
        lineWidth: period === '200' ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        lineStyle: period === '200' ? LineStyle.Solid : LineStyle.Solid,
      });

      const lineData = values
        .filter(v => v.value !== null && !isNaN(v.value))
        .map(v => ({ time: v.time, value: v.value }));

      if (lineData.length > 0) {
        line.setData(lineData);
      }
      this.emaLines[period] = line;
    }
  }

  /**
   * Draw order blocks as colored rectangles using price lines
   */
  drawOrderBlocks(orderBlocks, candles) {
    // Clear previous
    this._clearDrawnObjects('orderBlocks');

    if (!orderBlocks || orderBlocks.length === 0 || !candles || candles.length === 0) return;

    const lastClose = candles[candles.length - 1].close;
    const isCrypto = this.symbol === 'BTCUSDT';
    const limitPct = isCrypto ? 0.12 : 0.03; // 12% for crypto, 3% for forex/gold
    const maxDiff = lastClose * limitPct;

    // Filter OBs close to the current price so they don't squish the price scale
    const relevantOBs = orderBlocks.filter(ob => {
      if (ob.mitigated) return false;
      return Math.abs(ob.top - lastClose) <= maxDiff || Math.abs(ob.bottom - lastClose) <= maxDiff;
    });

    for (const ob of relevantOBs) {
      const color = ob.type === 'bullish'
        ? 'rgba(0, 229, 160, 0.08)'
        : 'rgba(255, 71, 87, 0.08)';
      const borderColor = ob.type === 'bullish'
        ? 'rgba(0, 229, 160, 0.4)'
        : 'rgba(255, 71, 87, 0.4)';

      // Draw top and bottom lines of the OB
      const topLine = this.candleSeries.createPriceLine({
        price: ob.top,
        color: borderColor,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
      });

      const bottomLine = this.candleSeries.createPriceLine({
        price: ob.bottom,
        color: borderColor,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
      });

      this.drawnObjects.orderBlocks.push(topLine, bottomLine);
    }
  }

  /**
   * Draw supply/demand zones
   */
  drawZones(zones) {
    this._clearDrawnObjects('zones');

    if (!zones || zones.length === 0) return;

    const lastClose = this.lastClose || zones[0].top;
    const isCrypto = this.symbol === 'BTCUSDT';
    const limitPct = isCrypto ? 0.12 : 0.03;
    const maxDiff = lastClose * limitPct;

    // Filter S/D zones close to the current price so they don't squish the price scale
    const relevantZones = zones.filter(zone => {
      if (zone.status === 'broken') return false;
      return Math.abs(zone.top - lastClose) <= maxDiff || Math.abs(zone.bottom - lastClose) <= maxDiff;
    });

    for (const zone of relevantZones) {
      const color = zone.type === 'demand'
        ? 'rgba(0, 229, 160, 0.3)'
        : 'rgba(255, 71, 87, 0.3)';

      const topLine = this.candleSeries.createPriceLine({
        price: zone.top,
        color: color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });

      const bottomLine = this.candleSeries.createPriceLine({
        price: zone.bottom,
        color: color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });

      this.drawnObjects.zones.push(topLine, bottomLine);
    }
  }

  /**
   * Draw signal entry, SL, and TP levels
   */
  drawSignal(signal) {
    this._clearDrawnObjects('signalLines');

    if (!signal) return;

    // Entry line
    const entryLine = this.candleSeries.createPriceLine({
      price: signal.entry,
      color: '#3b82f6',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `Entry ${signal.entry.toFixed(signal.symbol === 'XAUUSD' ? 2 : (signal.symbol.includes('USD') && !signal.symbol.includes('BTC') && !signal.symbol.includes('ETH') ? 5 : 2))}`,
    });

    // SL line
    const slLine = this.candleSeries.createPriceLine({
      price: signal.sl,
      color: '#ff4757',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'SL',
    });

    // TP1 line
    const tp1Line = this.candleSeries.createPriceLine({
      price: signal.tp1,
      color: '#00e5a0',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'TP1',
    });

    // TP2 line
    if (signal.tp2) {
      const tp2Line = this.candleSeries.createPriceLine({
        price: signal.tp2,
        color: '#00e5a0',
        lineWidth: 1,
        lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: true,
        title: 'TP2',
      });
      this.drawnObjects.signalLines.push(tp2Line);
    }

    this.drawnObjects.signalLines.push(entryLine, slLine, tp1Line);
  }

  /**
   * Set chart markers (swing highs/lows, BOS/CHoCH)
   */
  setMarkers(structureData, candles) {
    if (!structureData || !candles || candles.length === 0) return;

    const markers = [];

    // Prioritize markers so we select the most important ones: CHoCH (3) > BOS (2) > SH/SL (1)

    // Swing highs
    if (structureData.swingHighs) {
      for (const sh of structureData.swingHighs.slice(-15)) {
        if (sh.index < candles.length) {
          markers.push({
            time: candles[sh.index].time,
            position: 'aboveBar',
            color: '#ff4757',
            shape: 'arrowDown',
            text: 'SH',
            priority: 1,
          });
        }
      }
    }

    // Swing lows
    if (structureData.swingLows) {
      for (const sl of structureData.swingLows.slice(-15)) {
        if (sl.index < candles.length) {
          markers.push({
            time: candles[sl.index].time,
            position: 'belowBar',
            color: '#00e5a0',
            shape: 'arrowUp',
            text: 'SL',
            priority: 1,
          });
        }
      }
    }

    // Structure breaks
    if (structureData.structureBreaks) {
      for (const sb of structureData.structureBreaks.slice(-10)) {
        if (sb.index < candles.length) {
          const isBullish = sb.direction === 'bullish';
          markers.push({
            time: candles[sb.index].time,
            position: isBullish ? 'belowBar' : 'aboveBar',
            color: sb.type === 'CHoCH' ? '#f59e0b' : (isBullish ? '#00e5a0' : '#ff4757'),
            shape: isBullish ? 'arrowUp' : 'arrowDown',
            text: sb.type,
            priority: sb.type === 'CHoCH' ? 3 : 2,
          });
        }
      }
    }

    // Deduplicate markers: ensure at most one marker exists per timestamp + position combination
    // This perfectly prevents overlapping/stacking labels on the chart.
    const dedupedMap = new Map();
    for (const marker of markers) {
      const key = `${marker.time}_${marker.position}`;
      const existing = dedupedMap.get(key);
      if (!existing || marker.priority > existing.priority) {
        dedupedMap.set(key, marker);
      }
    }

    const finalMarkers = Array.from(dedupedMap.values());

    // Clean up internal priority property so it is not sent to lightweight-charts
    for (const m of finalMarkers) {
      delete m.priority;
    }

    // Sort markers chronologically (required by lightweight-charts)
    finalMarkers.sort((a, b) => a.time - b.time);
    this.candleSeries.setMarkers(finalMarkers);
  }

  /**
   * Clear drawn objects of a specific type
   */
  _clearDrawnObjects(type) {
    if (this.drawnObjects[type]) {
      for (const obj of this.drawnObjects[type]) {
        try {
          this.candleSeries.removePriceLine(obj);
        } catch (e) { /* already removed */ }
      }
      this.drawnObjects[type] = [];
    }
  }

  /**
   * Clear everything
   */
  clearAll() {
    this._clearDrawnObjects('zones');
    this._clearDrawnObjects('orderBlocks');
    this._clearDrawnObjects('signalLines');
    this.candleSeries.setMarkers([]);
    Object.values(this.emaLines).forEach(line => {
      try { this.chart.removeSeries(line); } catch(e) {}
    });
    this.emaLines = {};
  }

  /**
   * Destroy the chart
   */
  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    if (this.chart) {
      this.chart.remove();
    }
  }
}

export default ChartManager;
