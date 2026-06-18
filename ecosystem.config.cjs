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
      autorestart: true,
      // Restart if memory creeps past this — tune for your host (a 512MB Pi
      // may want this lower, a roomier box can raise it).
      max_memory_restart: '400M',
      // Give the SIGINT/SIGTERM graceful-shutdown handler time to close the
      // Discord gateway and flush SQLite before pm2 escalates to SIGKILL.
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
