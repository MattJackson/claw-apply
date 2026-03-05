/**
 * constants.mjs — Shared constants for claw-apply
 */

// --- Timeouts (ms) ---
export const NAVIGATION_TIMEOUT = 25000;
export const SEARCH_NAVIGATION_TIMEOUT = 30000;
export const FEED_NAVIGATION_TIMEOUT = 20000;
export const PAGE_LOAD_WAIT = 3000;
export const SCROLL_WAIT = 1500;
export const SEARCH_LOAD_WAIT = 5000;
export const SEARCH_SCROLL_WAIT = 2000;
export const LOGIN_WAIT = 2000;
export const CLICK_WAIT = 1500;
export const MODAL_STEP_WAIT = 600;
export const SUBMIT_WAIT = 2500;
export const FORM_FILL_WAIT = 2500;
export const DISMISS_TIMEOUT = 3000;
export const APPLY_CLICK_TIMEOUT = 5000;
export const APPLY_BETWEEN_DELAY_BASE = 2000;
export const APPLY_BETWEEN_DELAY_WF_BASE = 1500;
export const APPLY_BETWEEN_DELAY_JITTER = 1000;

// --- LinkedIn ---
export const LINKEDIN_BASE = 'https://www.linkedin.com';
export const LINKEDIN_EASY_APPLY_MODAL_SELECTOR = '.jobs-easy-apply-modal';
export const LINKEDIN_APPLY_BUTTON_SELECTOR = 'button.jobs-apply-button';
export const LINKEDIN_SUBMIT_SELECTOR = 'button[aria-label="Submit application"]';
export const LINKEDIN_NEXT_SELECTOR = 'button[aria-label="Continue to next step"]';
export const LINKEDIN_REVIEW_SELECTOR = 'button[aria-label="Review your application"]';
export const LINKEDIN_DISMISS_SELECTOR = 'button[aria-label="Dismiss"]';
export const LINKEDIN_MAX_MODAL_STEPS = 12;

// --- Wellfound ---
export const WELLFOUND_BASE = 'https://wellfound.com';

// --- Browser ---
export const LOCAL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
export const KERNEL_SDK_PATH = '/home/ubuntu/.openclaw/workspace/node_modules/@onkernel/sdk/index.js';
export const DEFAULT_PLAYWRIGHT_PATH = '/home/ubuntu/.npm-global/lib/node_modules/playwright/index.mjs';

// --- Form Filler Defaults ---
export const DEFAULT_YEARS_EXPERIENCE = 7;
export const DEFAULT_DESIRED_SALARY = 150000;
export const MINIMUM_SALARY_FACTOR = 0.85;
export const DEFAULT_SKILL_RATING = '8';
export const DEFAULT_FIRST_RUN_DAYS = 90;
export const SEARCH_RESULTS_MAX = 30;

// --- Notification ---
export const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
export const NOTIFY_RATE_LIMIT_MS = 1500;

// --- Queue ---
export const DEFAULT_REVIEW_WINDOW_MINUTES = 30;
