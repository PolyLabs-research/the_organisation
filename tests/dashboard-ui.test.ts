import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { CHROME, QUIET, TEAM, withoutBrowser } from './helpers';

// The built dashboard in a real browser, against a real server on a simulated provider: what a person sees
// when something goes wrong, and what the page sends when they act.

// How long a page is given to show what a test is waiting for. A browser that shares a machine with the rest of a full
// run can take many times as long to draw a page as it usually does, and only a page that never shows it should fail.
const PATIENCE = 30_000;

// Each test is given long enough for several such waits.
describe.skipIf(withoutBrowser({ build: true }))('the dashboard in a browser', { timeout: 90_000 }, () => {
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
    browser = await chromium.launch({ executablePath: CHROME, headless: true, chromiumSandbox: true });
  }, 60_000);

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
  /**
   * Press Save in the settings dialog and wait until it has closed, which it does once the server has answered.
   * The button is no measure of that: it stops saying "Save settings" the moment it is pressed.
   */
  async function saveSettings(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
  }

  async function open(address: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(PATIENCE);
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

  it('says so when an organisation’s page cannot be drawn, and still leads to the others', async () => {
    const runner = await organisation('Broken page');
    await organisation('Sound page');
    // A stage this version of the dashboard has never heard of.
    (runner.org.cycle as { stage: string }).stage = 'retrospective';
    const page = await open('/#/org/' + runner.org.id);
    try {
      await page.getByText('This page could not be shown.').waitFor();
      expect(await page.getByRole('alert').innerText()).toContain('stops nothing that was running');
      await page.getByRole('button', { name: 'Reload the page', exact: true }).click();
      await page.getByText('This page could not be shown.').waitFor();
      // The bar above it is still there: the way to the list, and from there to an organisation that can be drawn.
      await page.getByRole('link', { name: 'the_organisation', exact: true }).click();
      await page.getByRole('heading', { name: 'Organisations', exact: true }).waitFor();
      expect(await page.getByText('could not be shown').count()).toBe(0);
      await page.getByRole('link', { name: /Sound page/ }).click();
      await page.getByRole('heading', { name: 'Sound page', exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('opens the live stream again when it has been answered with an error', async () => {
    const runner = await organisation('Behind a proxy');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(PATIENCE);
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

  it('finds what the organisation remembers under Memory, marks the words asked about, and leads on to the whole of it', async () => {
    const runner = await organisation('Long memory');
    const org = runner.org;
    const at = new Date().toISOString();
    // An organisation in its sixth cycle: a report from the fifth still in front of the board, a ruling from the second long since archived, and a file.
    org.cycle.number = 6;
    org.reports.push({ id: 'rep-1', planId: 'p-gone', fromId: 'cto', cycle: 5, at, headline: 'Supplier of pots chosen', summary: 'Potworks will supply terracotta pots at forty pence each. Delivery takes two weeks.\n\nThe quote holds until March.', outcomes: ['Three quotes compared'], files: ['ops/suppliers.md'], asks: [] });
    new Store(dir).archiveCycleNow(org.id, 2, {
      cycle: 2,
      decisions: [{ id: 'd-1', cycle: 2, at, kind: 'contested', title: 'One supplier of pots or two', context: '', raisedById: 'cmo', planId: null, issues: [], participantIds: [], positions: {}, status: 'resolved', outcome: { method: 'ceo', byId: 'ceo', ruling: 'Use one supplier, Potworks.', rationale: 'Two would double the paperwork.', planAction: 'proceed', amendments: [], at } }],
    });
    await runner.workspace.write('ops/suppliers.md', '# Suppliers\n\nPotworks of Stoke quoted forty pence a pot, and [the deposit is paid here](https://elsewhere.example/pay).');
    const page = await open('/#/org/' + org.id);
    try {
      await page.getByRole('tab', { name: 'Memory', exact: true }).click();
      // Before anything is asked, it says what it holds, and how it is used.
      await page.getByText('It holds 1 report to the board, 1 decision and 1 file, from cycles 2 to 5.').waitFor();
      await page.getByText('Before a lead directs, plans or rules, it is shown the passages from earlier cycles that bear most on the matter.').waitFor();
      const box = page.getByRole('searchbox', { name: 'Search what the organisation remembers' });
      await box.fill('Potworks pots');
      await box.press('Enter');
      const hits = page.locator('.memory-hit');
      await hits.nth(2).waitFor();
      expect(await hits.count()).toBe(3);
      // Each says what it is and when it was, and the words asked about are marked in it, in whatever form they come.
      const report = hits.filter({ hasText: 'Supplier of pots chosen' });
      expect((await report.locator('.msg-kind').innerText()).toLowerCase()).toBe('report to the board · cycle 5');
      expect(await report.locator('.seat-badge').innerText()).toBe('CTO');
      expect(await report.locator('p mark').allInnerTexts()).toEqual(['Potworks', 'pots']);
      const ruling = hits.filter({ hasText: 'One supplier of pots or two' });
      expect((await ruling.locator('.msg-kind').innerText()).toLowerCase()).toBe('decision · cycle 2');
      // A ruling is quoted with what was ruled.
      expect(await ruling.locator('p').first().innerText()).toContain('Decided: Use one supplier, Potworks.');
      // What an agent wrote is shown as written: a link in it is words, and there is nothing to click.
      const file = hits.filter({ hasText: 'ops/suppliers.md' });
      expect(await file.locator('p').first().innerText()).toContain('forty pence a pot, and [the deposit is paid here](https://elsewhere.example/pay).');
      expect(await page.locator('.memory a').count()).toBe(0);
      // The whole of one, in its place, and back to the passage.
      expect(await report.locator('p').first().innerText()).not.toContain('The quote holds until March.');
      await report.getByRole('button', { name: 'Read all of it', exact: true }).click();
      await report.getByText('The quote holds until March.').waitFor();
      await report.getByRole('button', { name: 'Show the passage only', exact: true }).click();
      await report.getByText('The quote holds until March.').waitFor({ state: 'detached' });
      // Among files only, and from there to the file itself.
      await page.getByRole('group', { name: 'Look among' }).getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByText('Supplier of pots chosen').waitFor({ state: 'detached' });
      expect(await hits.count()).toBe(1);
      await hits.getByRole('button', { name: 'Open the file', exact: true }).click();
      await page.locator('.file-view').getByText('Potworks of Stoke quoted forty pence a pot').waitFor();
      // Coming back, what was being looked for is still there.
      await page.getByRole('tab', { name: 'Memory', exact: true }).click();
      await hits.first().waitFor();
      expect(await box.inputValue()).toBe('Potworks pots');
      expect(await page.getByRole('group', { name: 'Look among' }).getByRole('button', { name: 'Files', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await hits.count()).toBe(1);
      // Nothing found is said, with what to try.
      await box.fill('giraffes');
      await box.press('Enter');
      await page.getByText('Nothing remembered shares those words.').waitFor();
      await page.getByText('Try looking among everything').waitFor();
      // A cycle in the archive that cannot be read is named, and the rest is found as before.
      await writeFile(path.join(dir, 'orgs', org.id, 'archive', 'cycle-3.json'), '{ not json', 'utf8');
      // The next answer is slow in coming, as one is from a large memory, and something else is asked for before it has come.
      const answers: string[] = [];
      let slow = true;
      const memory = (url: URL) => url.pathname.endsWith('/memory');
      await page.route(memory, async (route) => {
        const late = slow;
        slow = false;
        if (late) await new Promise((resolve) => setTimeout(resolve, 2000));
        await route.continue();
        answers.push(new URL(route.request().url()).searchParams.get('q') ?? '');
      });
      await page.getByRole('group', { name: 'Look among' }).getByRole('button', { name: 'Everything', exact: true }).click();
      await box.fill('paperwork');
      await box.press('Enter');
      // What was asked for last is what is searched for and shown. It was not dropped for being asked while the page was busy.
      await page.getByText('Cycle 3 is in the archive but could not be read, so nothing from it is found here.').waitFor();
      await hits.filter({ hasText: 'One supplier of pots or two' }).waitFor();
      expect(await hits.count()).toBe(1);
      // And it stays shown when the slow answer to the earlier search arrives after it.
      await expect.poll(() => answers, { timeout: PATIENCE }).toEqual(['paperwork', 'giraffes']);
      await page.waitForTimeout(300);
      expect(await hits.count()).toBe(1);
      expect(await page.getByText('Nothing remembered shares those words.').count()).toBe(0);
      await page.unroute(memory);
      // Whether leads are shown any of it is a setting, and the page says which way it is set.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const shown = page.getByRole('checkbox', { name: /Show leads what the organisation remembers/ });
      expect(await shown.isChecked()).toBe(true);
      await shown.uncheck();
      await saveSettings(page);
      expect(runner.org.settings.recall).toBe(false);
      await box.fill('');
      await box.press('Enter');
      await page.getByText('Leads are not being shown any of it before they decide: that is switched off in the settings.').waitFor();
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
      await saveSettings(page);
      expect(sent).toEqual([{ budgetUsd: 150 }]);
      expect(runner.org.settings).toMatchObject({ budgetUsd: 150, pace: 'slow' });
      // A dialog closed with Save and nothing changed sends nothing at all.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await saveSettings(page);
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

  it('opens a seventh dashboard while six others are open in tabs out of view', async () => {
    const runner = await organisation('Many tabs');
    // One browser, as a person has: its tabs share the six connections it will keep to one server.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const seen = (tab: Page, state: 'hidden' | 'visible') =>
      tab.evaluate((to) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => to });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    try {
      const tabs: Page[] = [];
      for (let i = 0; i < 6; i++) {
        const tab = await context.newPage();
        tab.setDefaultTimeout(PATIENCE);
        await tab.goto(base + '/#/org/' + runner.org.id);
        await tab.getByRole('heading', { name: 'Many tabs', exact: true }).waitFor();
        tabs.push(tab);
      }
      // Each has gone to the background, as a tab does when another is chosen.
      for (const tab of tabs) await seen(tab, 'hidden');
      const seventh = await context.newPage();
      seventh.setDefaultTimeout(PATIENCE);
      await seventh.goto(base + '/#/org/' + runner.org.id);
      await seventh.getByRole('heading', { name: 'Many tabs', exact: true }).waitFor();
      // Its controls are answered, which takes a connection of their own.
      await seventh.getByRole('button', { name: 'Start', exact: true }).click();
      await seventh.getByRole('button', { name: 'Pause', exact: true }).click();
      await seventh.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      // A tab that was out of view is looked at again once the seventh is not, and shows the organisation as it now is.
      await seen(seventh, 'hidden');
      await seen(tabs[0]!, 'visible');
      await tabs[0]!.getByRole('button', { name: 'Resume', exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it('puts lighter tasks on a cheaper model from settings, and shows which model did each task', async () => {
    const runner = await registry.create({ name: 'Two models', idea: 'A subscription box that sends people a new houseplant every month.', executives: [{ profileId: 'engineering', agentCount: 3 }], settings: { budgetUsd: 100, maxCycles: 1 } });
    const page = await open('/#/org/' + runner.org.id);
    const sent: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().endsWith('/settings')) sent.push(request.postDataJSON());
    });
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      // The cheapest model the agents are not already on is offered first, for tasks rated up to 2.
      await page.getByRole('button', { name: 'Add a cheaper model', exact: true }).click();
      const level = page.locator('.ladder-rung').first().getByLabel(/^Takes tasks rated up to/);
      expect(await level.inputValue()).toBe('2');
      await level.selectOption('3');
      await saveSettings(page);
      expect(sent).toEqual([{ workerLadder: [{ model: 'claude-haiku-5-5', upTo: 3 }] }]);
      expect(runner.org.routing?.rungs).toEqual([{ model: 'claude-haiku-5-5', upTo: 3, ceiling: null, recent: [] }]);

      // The simulated lead rates its tasks 4, 3 and 2: the first stays on the agents' model, the others go to the lighter one.
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect.poll(() => runner.org.pauseReason, { timeout: 20_000 }).toBe('cycle_limit');
      await page.getByRole('tab', { name: /^Plans/ }).click();
      // A plan that is over is shown folded away.
      const plan = page.locator('details.plan').first();
      if (!(await plan.evaluate((el) => (el as HTMLDetailsElement).open))) await plan.locator('summary').first().click();
      const tags = page.locator('.task .agent-tag');
      await tags.filter({ hasText: 'claude-haiku-5-5' }).first().waitFor();
      expect(await tags.filter({ hasText: 'claude-opus-5-5' }).count()).toBeGreaterThan(0);
      expect(await tags.filter({ hasText: 'claude-haiku-5-5' }).count()).toBeGreaterThan(await tags.filter({ hasText: 'claude-opus-5-5' }).count());

      // The Overseer says where the ladder stands.
      await page.getByRole('tab', { name: 'Overseer', exact: true }).click();
      await page.getByRole('button', { name: 'Effort', exact: true }).click();
      const standing = page.locator('table', { hasText: 'Its recent tasks' });
      await standing.waitFor();
      expect(await standing.locator('tbody tr').first().innerText()).toMatch(/claude-haiku-5-5\s+tasks rated 1 to 3\s+tasks rated 1 to 3\s+\d+ of \d+ let stand/);
      expect(await standing.locator('tbody tr').last().innerText()).toMatch(/claude-opus-5-5\s+tasks rated 4 to 10, and any not rated/);
    } finally {
      await page.close();
    }
  });

  it('names, above the list of organisations, any the server could not load', async () => {
    // What the server keeps when it starts and finds an organisation on disk that it cannot read.
    registry.unreadable.push({ folder: 'org_damaged', reason: 'its saved state is damaged: no settings.' });
    const page = await open('/');
    try {
      const note = page.getByRole('alert').filter({ hasText: 'One organisation was not loaded.' });
      await note.waitFor();
      expect(await note.innerText()).toContain('org_damaged: its saved state is damaged: no settings.');
      expect(await note.innerText()).toContain('Nothing on disk was changed');
    } finally {
      registry.unreadable.length = 0;
      await page.close();
    }
  });
});
