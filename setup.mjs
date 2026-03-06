#!/usr/bin/env node
/**
 * setup.mjs — claw-apply setup wizard
 * Verifies config, tests logins, registers cron jobs
 * Run once after configuring: node setup.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './lib/queue.mjs';
import { loadEnv } from './lib/env.mjs';
loadEnv();

const __dir = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('🛠️  claw-apply setup\n');

  // Check configs
  console.log('Checking config files...');
  const settings = loadConfig(resolve(__dir, 'config/settings.json'));
  const profile = loadConfig(resolve(__dir, 'config/profile.json'));
  const searchConfig = loadConfig(resolve(__dir, 'config/search_config.json'));

  const checks = [
    [profile.name?.first && profile.name?.last, 'profile.json: name'],
    [profile.email && profile.email !== 'jane@example.com', 'profile.json: email'],
    [profile.phone, 'profile.json: phone'],
    [profile.resume_path && existsSync(profile.resume_path), 'profile.json: resume_path (file must exist)'],
    [settings.notifications?.telegram_user_id !== 'YOUR_TELEGRAM_USER_ID', 'settings.json: telegram_user_id'],
    [settings.notifications?.bot_token !== 'YOUR_TELEGRAM_BOT_TOKEN', 'settings.json: bot_token'],
    [settings.kernel?.proxy_id !== 'YOUR_KERNEL_PROXY_ID', 'settings.json: kernel.proxy_id'],
    [searchConfig.searches?.length > 0, 'search_config.json: at least one search'],
  ];

  let ok = true;
  for (const [pass, label] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) ok = false;
  }

  if (!ok) {
    console.log('\n⚠️  Fix the above before continuing.\n');
    process.exit(1);
  }

  // Create data directory
  mkdirSync(resolve(__dir, 'data'), { recursive: true });
  console.log('\n✅ Data directory ready');

  // Write .env file with API keys (gitignored — never embedded in cron payloads)
  const envPath = resolve(__dir, '.env');
  const envLines = [];
  if (process.env.KERNEL_API_KEY) envLines.push(`KERNEL_API_KEY=${process.env.KERNEL_API_KEY}`);
  if (process.env.ANTHROPIC_API_KEY) envLines.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  if (envLines.length) {
    writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
    console.log('✅ API keys written to .env (mode 600, gitignored)');
  }

  // Test Telegram
  if (settings.notifications?.bot_token && settings.notifications?.telegram_user_id) {
    const { sendTelegram } = await import('./lib/notify.mjs');
    await sendTelegram(settings, '🤖 *claw-apply setup complete!* Job search and auto-apply is ready to run.');
    console.log('✅ Telegram test message sent');
  }

  // Test LinkedIn login
  console.log('\nTesting LinkedIn login...');
  const { createBrowser } = await import('./lib/browser.mjs');
  const { verifyLogin: liLogin } = await import('./lib/linkedin.mjs');
  let liBrowser;
  try {
    liBrowser = await createBrowser(settings, 'linkedin');
    const loggedIn = await liLogin(liBrowser.page);
    console.log(loggedIn ? '✅ LinkedIn login OK' : '❌ LinkedIn not logged in — check Kernel Managed Auth');
  } catch (e) {
    console.log(`❌ LinkedIn browser error: ${e.message}`);
  } finally {
    await liBrowser?.browser?.close().catch(() => {});
  }

  // Test Wellfound login
  console.log('\nTesting Wellfound login...');
  const { verifyLogin: wfLogin } = await import('./lib/wellfound.mjs');
  let wfBrowser;
  try {
    wfBrowser = await createBrowser(settings, 'wellfound');
    const loggedIn = await wfLogin(wfBrowser.page);
    console.log(loggedIn ? '✅ Wellfound login OK' : '⚠️  Wellfound login unconfirmed');
  } catch (e) {
    console.log(`❌ Wellfound browser error: ${e.message}`);
  } finally {
    await wfBrowser?.browser?.close().catch(() => {});
  }

  // Register cron jobs via OpenClaw gateway
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:3000';
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const telegramUserId = settings.notifications?.telegram_user_id;
  const searchSchedule = settings.schedules?.search || '0 * * * *';
  const applySchedule = settings.schedules?.apply || '0 */6 * * *';

  // API keys are loaded from .env at runtime — never embedded in cron payloads
  if (gatewayToken && telegramUserId) {
    console.log('\nRegistering cron jobs...');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` };

    const searchJob = {
      name: 'claw-apply: job searcher',
      schedule: { kind: 'cron', expr: searchSchedule, tz: settings.timezone || 'America/Los_Angeles' },
      payload: {
        kind: 'agentTurn',
        message: `Launch the claw-apply job searcher as a detached background process: \`cd ${__dir} && nohup node job_searcher.mjs >> /tmp/claw-searcher.log 2>&1 & echo $!\`. Confirm the PID and that it started successfully.`,
        timeoutSeconds: 30,
      },
      delivery: { mode: 'announce', to: telegramUserId },
      sessionTarget: 'isolated',
      enabled: true,
    };

    const applyJob = {
      name: 'claw-apply: job applier',
      schedule: { kind: 'cron', expr: applySchedule, tz: settings.timezone || 'America/Los_Angeles' },
      payload: {
        kind: 'agentTurn',
        message: `Launch the claw-apply job applier as a detached background process: \`cd ${__dir} && nohup node job_applier.mjs >> /tmp/claw-applier.log 2>&1 & echo $!\`. Confirm the PID and that it started successfully.`,
        timeoutSeconds: 30,
      },
      delivery: { mode: 'announce', to: telegramUserId },
      sessionTarget: 'isolated',
      enabled: false, // disabled by default — enable when ready
    };

    try {
      const sRes = await fetch(`${gatewayUrl}/api/cron/jobs`, { method: 'POST', headers, body: JSON.stringify(searchJob) });
      const sData = await sRes.json();
      console.log(sRes.ok ? `  ✅ Searcher cron registered (ID: ${sData.id})` : `  ❌ Searcher cron failed: ${JSON.stringify(sData)}`);
    } catch (e) {
      console.log(`  ❌ Searcher cron error: ${e.message}`);
    }

    try {
      const aRes = await fetch(`${gatewayUrl}/api/cron/jobs`, { method: 'POST', headers, body: JSON.stringify(applyJob) });
      const aData = await aRes.json();
      console.log(aRes.ok ? `  ✅ Applier cron registered, disabled (ID: ${aData.id}) — enable when ready` : `  ❌ Applier cron failed: ${JSON.stringify(aData)}`);
    } catch (e) {
      console.log(`  ❌ Applier cron error: ${e.message}`);
    }
  } else {
    console.log('\n⚠️  Skipping cron registration — set OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN to auto-register.');
    console.log('   Or register manually with these schedules:');
    console.log(`     Search: ${searchSchedule}  (timeoutSeconds: 0)`);
    console.log(`     Apply:  ${applySchedule}  (timeoutSeconds: 0, start disabled)`);
  }

  console.log('\n🎉 Setup complete. claw-apply is ready.');
  console.log('\nTo run manually:');
  console.log('  node job_searcher.mjs   — search now');
  console.log('  node job_applier.mjs    — apply now');
}

main().catch(e => { console.error('Setup error:', e.message); process.exit(1); });
