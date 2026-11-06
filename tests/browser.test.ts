import { existsSync } from 'node:fs';
import { it } from 'vitest';

const browser = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome';
it.skipIf(!existsSync(browser) || !existsSync('dist/client/index.html'))('operates Only Paperclips through the real browser interface', async () => {
  if (process.argv.includes('--update') || process.argv.includes('-u')) process.env.UPDATE_SCREENSHOTS = '1';
  await import('../scripts/smoke-business');
}, 40_000);

