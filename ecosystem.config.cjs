/**
 * PM2 ecosystem config for claw-apply
 * Start: pm2 start ecosystem.config.cjs
 * Save:  pm2 save
 * Boot:  pm2 startup (follow printed command)
 */
module.exports = {
  apps: [
    {
      // Searcher is triggered by system cron, not PM2 cron_restart.
      // PM2 just manages the process — system cron runs: node job_searcher.mjs
      // Lockfile prevents parallel runs: if already running, new invocation exits immediately.
      name: 'claw-searcher',
      script: 'job_searcher.mjs',
      autorestart: false,  // one-shot — do not restart on exit
      watch: false,
      interpreter: 'node',
      log_file: '/tmp/claw-searcher.log',
      time: true,
    },
    {
      name: 'claw-applier',
      script: 'job_applier.mjs',
      autorestart: false,
      watch: false,
      interpreter: 'node',
      log_file: '/tmp/claw-applier.log',
      time: true,
    },
  ],
};
