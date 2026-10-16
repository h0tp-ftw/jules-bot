// pm2 process configuration.  Build first (`npm run build`), then:
//   pm2 start ecosystem.config.cjs
//
// IMPORTANT: fork mode + a single instance is REQUIRED. JulesBot keeps
// coordination state (active streams, dedup sets, warm-pool bookkeeping) in
// process memory, so it cannot be clustered or sharded — run exactly one
// instance per bot token.
//
// This file is `.cjs` (not `.js`) on purpose: package.json sets
// "type": "module", so a `module.exports` config must use the .cjs extension.
module.exports = {
  apps: [
    {
      name: 'jules-bot',
      script: 'dist/index.js',
      exec_mode: 'fork',
      instances: 1,
      // Autorestart on unexpected crashes (with delays and limits to avoid thrashing
      // and protect Discord gateway sessions), while allowing PM2 to restart before OOM.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      max_memory_restart: '2500M',
      node_args: '--max-old-space-size=3072',
      // Prefix PM2 log lines with timestamps so the first failure can be tied
      // to Discord/Jules activity without relying on surrounding daemon logs.
      time: true,
      merge_logs: true,
      // Give the SIGINT/SIGTERM graceful-shutdown handler time to close the
      // Discord gateway and flush SQLite before pm2 escalates to SIGKILL.
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
