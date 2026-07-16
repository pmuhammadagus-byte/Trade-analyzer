import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/binance': {
        target: 'https://api.binance.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/binance/, ''),
        secure: true,
      },
      '/api/finnhub': {
        target: 'https://finnhub.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/finnhub/, ''),
        secure: true,
      },
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        secure: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://finance.yahoo.com',
          'Referer': 'https://finance.yahoo.com',
        },
      },
      '/api/swissquote': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/terminal-state': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/market-data': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/take-trade': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/manual-close': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
      '/api/reset-account': {
        target: 'http://localhost:7860',
        changeOrigin: true,
      },
    },
  },
});
