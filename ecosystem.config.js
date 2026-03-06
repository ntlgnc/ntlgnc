module.exports = {
  apps: [
    // Frontend - Next.js on port 3000
    {
      name: 'ntlgnc-frontend',
      cwd: './frontend',
      script: 'node_modules/.bin/next',
      args: 'start -p 3000',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Data Collection - 1m candles
    {
      name: 'ntlgnc-data-collector',
      cwd: './backend',
      script: 'live-fetch.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/data-collector-error.log',
      out_file: './logs/data-collector-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Data Collection - 1h candles
    {
      name: 'ntlgnc-data-hourly',
      cwd: './backend',
      script: 'live-fetch-hourly.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/data-hourly-error.log',
      out_file: './logs/data-hourly-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Data Collection - 1d candles
    {
      name: 'ntlgnc-data-daily',
      cwd: './backend',
      script: 'live-fetch-daily.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/data-daily-error.log',
      out_file: './logs/data-daily-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Signal Engine - fracmap signal generation
    {
      name: 'fracmap-signals',
      cwd: './backend',
      script: 'live-signals.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/signals-error.log',
      out_file: './logs/signals-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // LLM Board - Hourly BTC forecast meetings
    {
      name: 'ntlgnc-llm-board',
      cwd: './backend',
      script: 'llm-board.js',
      interpreter: 'node',
      node_args: '--experimental-vm-modules',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/llm-board-error.log',
      out_file: './logs/llm-board-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Regime Cache - refreshes every 5 min for all timeframes
    {
      name: 'fracmap-regime-cache',
      cwd: './backend',
      script: 'regime-cache.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '300M',
      error_file: './logs/regime-cache-error.log',
      out_file: './logs/regime-cache-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // MTM Cron - mark-to-market snapshots for open positions
    {
      name: 'fracmap-mtm-cron',
      cwd: './backend',
      script: 'mtm-cron.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '300M',
      error_file: './logs/mtm-cron-error.log',
      out_file: './logs/mtm-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Research Cron - autonomous LLM research
    {
      name: 'fracmap-research',
      cwd: './backend',
      script: 'research-cron.cjs',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/research-error.log',
      out_file: './logs/research-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // Predictions - AI predictions (legacy)
    {
      name: 'ntlgnc-predictions',
      cwd: './backend',
      script: 'forecast-multi.js',
      interpreter: 'node',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/predictions-error.log',
      out_file: './logs/predictions-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
