/**
 * PM2 ecosystem config for claw-apply
 * Start: pm2 start ecosystem.config.cjs
 * Save:  pm2 save
 * Boot:  pm2 startup (follow printed command)
 */
module.exports = {
  apps: [
    {
      name: 'claw-searcher',
      script: 'job_searcher.mjs',
      cron_restart: '0 * * * *',   // hourly
      autorestart: false,           // don't restart on exit — it's a one-shot job
      watch: false,
      interpreter: 'node',
      log_file: '/tmp/claw-searcher.log',
      time: true,
    },
    {
      name: 'claw-applier',
      script: 'job_applier.mjs',
      cron_restart: '0 */6 * * *', // every 6 hours
      autorestart: false,
      watch: false,
      interpreter: 'node',
      log_file: '/tmp/claw-applier.log',
      time: true,
    },
  ],
};
