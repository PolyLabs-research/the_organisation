import { it } from 'vitest';
import { withoutBrowser } from './helpers';

it.skipIf(withoutBrowser({ build: true }))('operates Only Paperclips through the real browser interface', async () => {
  if (process.argv.includes('--update') || process.argv.includes('-u')) process.env.UPDATE_SCREENSHOTS = '1';
  await import('../scripts/smoke-business');
}, 40_000);
