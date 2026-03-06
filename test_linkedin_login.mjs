import { createBrowser } from './lib/browser.mjs';
import { verifyLogin } from './lib/linkedin.mjs';
import { loadConfig } from './lib/queue.mjs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const settings = loadConfig(resolve(__dir, 'config/settings.json'));

console.log('Creating Kernel browser with LinkedIn profile...');
const b = await createBrowser(settings, 'linkedin');
console.log('Browser created, checking login...');
const loggedIn = await verifyLogin(b.page);
console.log('Logged in:', loggedIn);
console.log('URL:', b.page.url());
await b.browser.close();
console.log('Done.');
