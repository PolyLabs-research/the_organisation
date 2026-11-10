import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import type { OrgRunner } from '../src/server/engine/runner';
import { MockProvider } from '../src/server/providers/mock';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import type { BoardMessage } from '../src/shared/types';
import { QUIET, TEAM } from './helpers';

// The built dashboard in a real browser, against a real server on a simulated provider: what a person sees
// when something goes wrong, and what the page sends when they act.

const chrome = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome';

describe.skipIf(!existsSync(chrome) || !existsSync('dist/client/index.html'))('the dashboard in a browser', () => {
  let dir: string;
  let registry: Registry;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-ui-'));
    const store = new Store(dir);
    await store.init();
    registry = new Registry(store, new MockProvider(QUIET));
    const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'mock', providerReason: 'test', production: true, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
    const app = createApp(registry, config);
    app.use(express.static(path.resolve('dist/client')));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true });
  });

  afterAll(async () => {
    await browser?.close();
    await registry?.shutdown();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const organisation = (name: string): Promise<OrgRunner> =>
    registry.create({ name, idea: 'A subscription box that sends people a new houseplant every month, with care instructions.', executives: TEAM, settings: { budgetUsd: 100 } });

  /** A page on the dashboard of one organisation, or wherever `address` says. */
  async function open(address: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10_000);
    await page.goto(base + address);
    return page;
  }

  it('says so in its place when a tab cannot be drawn, and keeps the rest of the page', async () => {
    const runner = await organisation('Broken board');
    // A message with no sender, which the board cannot draw.
    runner.org.board.push({ id: 'm-bad', at: new Date().toISOString(), cycle: 1, type: 'system', title: 'From nobody', body: 'x' } as unknown as BoardMessage);
    const page = await open('/#/org/' + runner.org.id);
    try {
      await page.getByText('This tab could not be shown.').waitFor();
      await page.getByRole('button', { name: 'Reload the page', exact: true }).waitFor();
      // The controls above it are still there and still work.
      expect(await page.getByRole('heading', { name: 'Broken board', exact: true }).isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      // Another tab is drawn as usual, and coming back finds the first one as broken as it was.
      await page.getByRole('tab', { name: 'Privileges', exact: true }).click();
      await page.getByRole('heading', { name: 'Privileges', exact: true }).waitFor();
      expect(await page.getByText('This tab could not be shown.').count()).toBe(0);
      await page.getByRole('tab', { name: 'Board', exact: true }).click();
      await page.getByText('This tab could not be shown.').waitFor();
    } finally {
      await page.close();
    }
  });

  it('says so, and offers a reload, when the page itself cannot be drawn', async () => {
    const runner = await organisation('Broken page');
    // A stage this version of the dashboard has never heard of.
    (runner.org.cycle as { stage: string }).stage = 'retrospective';
    const page = await open('/#/org/' + runner.org.id);
    try {
      await page.getByText('The page could not be shown.').waitFor();
      expect(await page.getByRole('alert').innerText()).toContain('stops nothing that was running');
      await page.getByRole('button', { name: 'Reload the page', exact: true }).click();
      await page.getByText('The page could not be shown.').waitFor();
    } finally {
      await page.close();
    }
  });

  it('opens the live stream again when it has been answered with an error', async () => {
    const runner = await organisation('Behind a proxy');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10_000);
    // What a proxy or a tunnel in front of the server says while the server is away: the next attempt to open the stream
    // gets an error for an answer, which a browser takes as final.
    let refused = 0;
    await page.route('**/api/orgs/*/events', (route) => (refused++ === 0 ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad gateway' }) : route.continue()));
    try {
      // On the first attempt of all: the page must not sit at "Loading…".
      await page.goto(base + '/#/org/' + runner.org.id);
      await page.getByRole('heading', { name: 'Behind a proxy', exact: true }).waitFor();
      await page.getByText('Reconnecting…').waitFor({ state: 'detached' });
      // And on a stream that had been open: it drops, the browser's own attempt to reopen it is refused, and the page opens it again.
      refused = 0;
      server.closeAllConnections();
      await page.getByText('Reconnecting…').waitFor();
      await page.getByText('Reconnecting…').waitFor({ state: 'detached' });
      expect(refused).toBeGreaterThan(1);
      runner.updateSettings({ pace: 'slow' });
      await page.locator('.pace-options [aria-checked=true]').filter({ hasText: 'Slow' }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('opens the file a request points to, however the lead wrote its path', async () => {
    const runner = await organisation('Read first');
    await runner.workspace.write('sales/quote.md', '# Quote\n\nTen boxes of paperclips at 48 GBP.');
    // The same file three ways. The server takes all three; it answers with the last.
    const files = ['/sales/quote.md', './sales/quote.md', 'sales/quote.md'];
    runner.org.signatory.requests.push({ id: 'q-1', cycle: 1, kind: 'payment', fromId: 'cto', planId: null, phase: null, title: 'Deposit for the supplier', detail: 'The quote is in the file.', amount: '48 GBP', party: 'Acme Supplies', files, status: 'pending', raisedAt: new Date().toISOString(), ruling: null, outcome: null });
    const page = await open('/#/org/' + runner.org.id);
    try {
      for (const written of files) {
        await page.getByRole('tab', { name: /^Signatory/ }).click();
        await page.getByTitle('Open ' + written, { exact: true }).click();
        await page.locator('.file-view').getByText('Ten boxes of paperclips at 48 GBP.').waitFor();
        expect(await page.locator('.file-tree button.is-on').innerText()).toBe('quote.md');
        await page.getByRole('tab', { name: 'Board', exact: true }).click();
      }
    } finally {
      await page.close();
    }
  });

  it('sends a steer once, however the shortcut is pressed', async () => {
    const runner = await organisation('Steered once');
    const page = await open('/#/org/' + runner.org.id);
    try {
      const box = page.getByLabel('Steer for the CEO', { exact: true });
      await box.fill('Keep the first box under 20 GBP.');
      // Ctrl+Enter held down: the key repeats before the page has heard back, or even drawn itself again.
      await box.evaluate((el) => {
        for (const repeat of [false, true, true]) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, repeat }));
      });
      await expect.poll(() => box.inputValue()).toBe('');
      expect(runner.org.steers.map((s) => s.text)).toEqual(['Keep the first box under 20 GBP.']);
      // The next steer goes as usual.
      await box.fill('Deliver within the country only.');
      await box.press('Control+Enter');
      await expect.poll(() => runner.org.steers.length).toBe(2);
    } finally {
      await page.close();
    }
  });

  it('leaves the Help dialog as it is while the organisation changes behind it', async () => {
    const runner = await organisation('Reading the guide');
    const page = await open('/#/org/' + runner.org.id);
    try {
      await page.getByRole('button', { name: 'Help and setup guides', exact: true }).click();
      const guide = page.locator('dialog.guide .guide-body');
      await guide.locator('h2').first().waitFor();
      // A heading and a link are marked, so that the same ones can be told from new ones built in their place.
      await guide.evaluate((body) => {
        body.querySelector('h2')!.setAttribute('data-marked', '');
        body.querySelector('a')!.setAttribute('data-marked', '');
      });
      // Every change to the organisation is pushed to the page, which then draws itself again.
      runner.updateSettings({ pace: 'slow' });
      await page.locator('.pace-options [aria-checked=true]').filter({ hasText: 'Slow' }).waitFor();
      expect(await guide.locator('[data-marked]').count()).toBe(2);
    } finally {
      await page.close();
    }
  });
});
