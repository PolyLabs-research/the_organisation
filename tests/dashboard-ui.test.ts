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
import { plan } from './client-helpers';
import { QUIET, TEAM } from './helpers';

// The built dashboard in a real browser, against a real server on a simulated provider: what a person sees
// when something goes wrong, and what the page sends when they act.

const chrome = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome';

// Each test has the time the other browser tests have: a browser shared with the rest of a full run can be slow to answer.
describe.skipIf(!existsSync(chrome) || !existsSync('dist/client/index.html'))('the dashboard in a browser', { timeout: 40_000 }, () => {
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
  }, 40_000);

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

  it('shows a link in the file a request points to as words, with nothing to click', async () => {
    const runner = await organisation('Pay here');
    // The file a payment request tells the signatory to read first, written by an agent, with a link to pay somewhere of its choosing.
    await runner.workspace.write('sales/invoice.md', '# Invoice\n\nThe deposit is 48 GBP. [Pay the deposit here](https://elsewhere.example/pay?ref=q-1)');
    runner.org.signatory.requests.push({ id: 'q-1', cycle: 1, kind: 'payment', fromId: 'cto', planId: null, phase: null, title: 'Deposit for the supplier', detail: 'The invoice is in the file.', amount: '48 GBP', party: 'Acme Supplies', files: ['sales/invoice.md'], status: 'pending', raisedAt: new Date().toISOString(), ruling: null, outcome: null });
    const page = await open('/#/org/' + runner.org.id);
    try {
      await page.getByRole('tab', { name: /^Signatory/ }).click();
      await page.getByTitle('Open sales/invoice.md', { exact: true }).click();
      await page.locator('.file-view').getByText('Pay the deposit here (https://elsewhere.example/pay?ref=q-1)').waitFor();
      expect(await page.locator('.file-view a').count()).toBe(0);
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

  it('goes to an organisation it has established even when starting it fails, and establishes no other', async () => {
    const page = await open('/#/new');
    // The organisation is established by one request and started by a second, and here the second never arrives.
    await page.route('**/api/orgs/*/start', (route) => route.abort('connectionreset'));
    try {
      await page.getByLabel('What should this organisation pursue?', { exact: true }).fill('Sharpened pencils by post, a box a month.');
      await page.getByLabel('Name', { exact: true }).fill('Established once');
      await page.getByRole('button', { name: 'Seat the team myself', exact: true }).click();
      await page.getByRole('button', { name: 'Add a seat', exact: true }).click();
      await page.locator('.library li button').first().click();
      await page.getByRole('button', { name: 'Establish the organisation', exact: true }).click();
      await page.getByRole('heading', { name: 'Established once', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
      expect(registry.list().filter((org) => org.name === 'Established once')).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('opens on Email & accounts after a mailbox is connected, once', async () => {
    const connected = await organisation('Just connected');
    const other = await organisation('Another one');
    const selected = (page: Page) => page.locator('.tabs [role=tab][aria-selected=true]').innerText();
    // Where the server sends the browser when Google sign-in has finished.
    const page = await open('/?access=connected#/org/' + connected.org.id);
    try {
      await page.getByRole('heading', { name: 'Just connected', exact: true }).waitFor();
      expect(await selected(page)).toBe('Email & accounts');
      await expect.poll(() => page.url()).toBe(base + '/#/org/' + connected.org.id);
      // The next organisation opened from here starts on its board, and so does this one after a reload.
      await page.getByRole('link', { name: 'Organisations' }).click();
      await page.getByRole('link', { name: /Another one/ }).click();
      await page.getByRole('heading', { name: 'Another one', exact: true }).waitFor();
      expect(await selected(page)).toBe('Board');
      await page.reload();
      await page.getByRole('heading', { name: 'Another one', exact: true }).waitFor();
      expect(await selected(page)).toBe('Board');
    } finally {
      await page.close();
    }
  });

  it('says so when an agent’s whole report cannot be fetched', async () => {
    const runner = await organisation('Long reports');
    // A finished task whose report is longer than is sent with the rest, so the whole of it is fetched on request.
    const report = 'The first paragraph of the report. '.repeat(40);
    plan(runner.org, 'cto', 'p-1').phases[0]!.tasks.push({ id: 't-1', title: 'Draft the specification', brief: 'Write it.', status: 'done', agent: 1, rework: false, result: report, files: [], error: null, attempts: 1, startedAt: null, finishedAt: null, effort: null });
    const page = await open('/#/org/' + runner.org.id);
    await page.route('**/api/orgs/*/tasks/*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on the server.' }) }));
    try {
      await page.getByRole('tab', { name: /^Plans/ }).click();
      await page.getByText('Draft the specification', { exact: true }).click();
      await page.getByRole('button', { name: 'Read the whole report', exact: true }).click();
      await page.getByText('The report could not be read. Something went wrong on the server.').waitFor();
      // Asked again once the server answers, the report comes and the note goes.
      await page.unroute('**/api/orgs/*/tasks/*');
      await page.getByRole('button', { name: 'Read the whole report', exact: true }).click();
      await page.getByRole('button', { name: 'Read the whole report', exact: true }).waitFor({ state: 'detached' });
      expect(await page.getByText('The report could not be read.').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('says so when the record of an organisation’s calls cannot be read for the Overseer', async () => {
    const runner = await organisation('Unread history');
    const page = await open('/#/org/' + runner.org.id);
    await page.route('**/api/orgs/*/activity/history', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on the server.' }) }));
    try {
      await page.getByRole('tab', { name: 'Overseer', exact: true }).click();
      await page.getByText('The organisation’s record of its calls could not be read, so these views are drawn from the most recent calls only. Something went wrong on the server.').waitFor();
    } finally {
      await page.close();
    }
  });

  it('saves the settings that were changed in the dialog, and leaves the others as they now are', async () => {
    const runner = await organisation('Two windows');
    const page = await open('/#/org/' + runner.org.id);
    const sent: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().endsWith('/settings')) sent.push(request.postDataJSON());
    });
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByLabel(/^Budget \(US dollars\)/).fill('150');
      // While the dialog is open, the pace is changed from somewhere else: another window, or a script.
      runner.updateSettings({ pace: 'slow' });
      await page.locator('.pace-options [aria-checked=true]').filter({ hasText: 'Slow' }).waitFor();
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor({ state: 'detached' });
      expect(sent).toEqual([{ budgetUsd: 150 }]);
      expect(runner.org.settings).toMatchObject({ budgetUsd: 150, pace: 'slow' });
      // A dialog closed with Save and nothing changed sends nothing at all.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor({ state: 'detached' });
      expect(sent).toHaveLength(1);
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
