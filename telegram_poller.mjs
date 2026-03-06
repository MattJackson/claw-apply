#!/usr/bin/env node
/**
 * telegram_poller.mjs — Polls Telegram for replies to question messages
 *
 * Run via OpenClaw cron: * * * * * (every minute)
 * Lightweight — single HTTP call, exits immediately if no updates.
 */
import { loadEnv } from './lib/env.mjs';
loadEnv();

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './lib/queue.mjs';
import { processTelegramReplies } from './lib/telegram_answers.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const settings = loadConfig(resolve(__dir, 'config/settings.json'));
const answersPath = resolve(__dir, 'config/answers.json');

const processed = await processTelegramReplies(settings, answersPath);
if (processed > 0) console.log(`Processed ${processed} answer(s)`);
