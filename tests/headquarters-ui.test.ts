import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import type { OrgRunner } from '../src/server/engine/runner';
import { MockProvider } from '../src/server/providers/mock';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import type { OrgSettings, Task } from '../src/shared/types';
import { plan } from './client-helpers';
import { CHROME, QUIET, TEAM, withoutBrowser } from './helpers';

// The headquarters in a real browser, against a real server on a simulated provider: what a shareholder sees on
// opening an organisation, and what happens when they look closer, move about, and act on what they find.

// How long a page is given to show what a test is waiting for. A browser that shares a machine with the rest of a full
// run can take many times as long to draw a page as it usually does, and only a page that never shows it should fail.
const PATIENCE = 30_000;

describe.skipIf(withoutBrowser({ build: true }))('the headquarters in a browser', { timeout: 90_000 }, () => {
  let dir: string;
  let registry: Registry;
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'headquarters-ui-'));
    const store = new Store(dir);
    await store.init();
    // Each call takes a moment, so that work can be seen while it is in flight.
    registry = new Registry(store, new MockProvider({ ...QUIET, delayMs: 700 }));
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

  const task = (id: string, fields: Partial<Task>): Task => ({ id, title: id, brief: '', status: 'pending', agent: null, rework: false, result: null, files: [], error: null, attempts: 1, startedAt: null, finishedAt: null, effort: null, ...fields });

  /**
   * An organisation that has not been started, as it would stand part of the way through a plan: one phase done, with
   * what its agent reported and wrote, a task of the next phase failed, and a payment asked of the signatory.
   */
  async function shop(name: string, settings: Partial<OrgSettings> = {}): Promise<OrgRunner> {
    const runner = await registry.create({ name, idea: 'A subscription box that sends people a new houseplant every month, with care instructions.', executives: TEAM, settings: { budgetUsd: 100, ...settings } });
    const org = runner.org;
    org.cycle.stage = 'work';
    const p = plan(org, 'cto', 'p-shop');
    p.objective = 'Open the shop for orders';
    p.phases[0]!.status = 'done';
    p.phases[0]!.tasks = [task('t-spec', { title: 'Write the spec', brief: 'Say what the shop must do.', status: 'done', agent: 1, result: 'The spec is in **spec.md**, with the open questions at its end.', files: ['spec.md'], finishedAt: new Date().toISOString() })];
    p.phases[1]!.status = 'working';
    p.phases[1]!.tasks = [task('t-pay', { title: 'Wire up payments', brief: 'Take a card payment.', status: 'failed', agent: 2, error: 'No account to test with.' })];
    await runner.workspace.write('spec.md', '# The shop\n\nIt takes an order and a payment.');
    org.signatory.requests.push({ id: 'r-pay', cycle: 1, kind: 'payment', fromId: 'cto', planId: 'p-shop', phase: 'Build', title: 'Payment account', detail: 'Open a merchant account so that payments can be tested.', amount: '25 GBP a month', party: 'Paywell', files: [], status: 'pending', raisedAt: new Date().toISOString(), ruling: null, outcome: null });
    return runner;
  }

  async function open(runner: OrgRunner, viewport = { width: 1440, height: 1000 }): Promise<{ page: Page; map: Locator; room: (name: string) => Locator; beside: (name: string) => Locator; level: () => Promise<string> }> {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(PATIENCE);
    await page.goto(base + '/#/org/' + runner.org.id);
    const map = page.getByRole('group', { name: /^Map of the headquarters/ });
    await map.waitFor();
    return {
      page,
      map,
      // A room, by the name it begins what it says of itself with.
      room: (name) => map.getByRole('button', { name: new RegExp('^' + name + '\\.') }),
      // The panel beside the map, by what it is showing.
      beside: (name) => page.getByRole('complementary', { name, exact: true }),
      // Which of the three distances the map says it is at.
      level: () => page.locator('.hq-levels button[aria-pressed=true]').innerText(),
    };
  }

  /** Press on a room's name, which is the room and nothing that stands in it. */
  const press = (room: Locator) => room.locator('.hq-title').click();

  /** Where a room's floor is, once the map has stopped moving. */
  async function atRest(room: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    let last = (await room.locator('.hq-floor').boundingBox())!;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const now = (await room.locator('.hq-floor').boundingBox())!;
      if (now.x === last.x && now.y === last.y && now.width === last.width) return now;
      last = now;
    }
  }

  it('opens on the headquarters, with a room for every seat, and says first what needs a person', async () => {
    const runner = await shop('Seen from above');
    const { page, map, room, beside, level } = await open(runner);
    try {
      expect(await page.locator('.tabs [role=tab][aria-selected=true]').innerText()).toBe('Headquarters');
      // The whole width is the map's: the hierarchy that stands beside the other tabs is what it draws.
      expect(await page.locator('.org-side').count()).toBe(0);
      const frame = (await map.boundingBox())!;
      expect(frame.width).toBeGreaterThan(1000);
      // What the other tabs have above them is along its own top edge, once: the cycle, the spend and the pace.
      expect(await page.locator('.org-strip').count()).toBe(0);
      expect(await page.getByRole('radiogroup', { name: 'Pace', exact: true }).count()).toBe(1);
      // What waits for a payment or a signature is said by the headquarters itself, and not in a note above it as well.
      expect(await page.getByText('waiting for you to pay or sign').count()).toBe(0);
      // The map and what is beneath it are in view without scrolling.
      const foot = (await page.locator('.hq-ticker').boundingBox())!;
      expect(foot.y).toBeCloseTo(frame.y + frame.height, 0);
      expect(foot.y + foot.height).toBeLessThanOrEqual(1000);
      expect(frame.height).toBeGreaterThan(560);
      // Nothing has just happened, so no room is marked as if it had.
      expect(await page.locator('.hq-flash').count()).toBe(0);
      expect(await level()).toBe('Building');
      for (const name of ['Shareholders', 'CEO’s office', 'Boardroom', 'Signing desk', 'Engineering', 'Product', 'Marketing', 'Memory', 'Files', 'Operations']) await room(name).waitFor();
      expect(await room('Signing desk').getAttribute('aria-label')).toBe('Signing desk. 1 request waiting for you. 1 waiting for you');
      expect(await room('Engineering').getAttribute('aria-label')).toBe('Engineering. Build · at its gate. 1 gone wrong');
      // Along the top: what needs a person, what has gone wrong, and what there is of each thing.
      await page.getByRole('button', { name: '2 need you', exact: true }).waitFor();
      await page.getByRole('button', { name: '1 gone wrong', exact: true }).waitFor();
      expect((await page.locator('.hq-tiles').innerText()).replace(/\s+/g, ' ')).toBe('Cycle 1 · Work Simulated spend $0.00 of $100.00 Agents at work 0 of 6 Plans 1 Phases done 1 of 4 Open decisions 0');
      // Beside the map, the same in words, each with the way to it.
      const situation = beside('The situation');
      await situation.getByText('Not started', { exact: true }).waitFor();
      await situation.getByText('Pay: Payment account (25 GBP a month, to Paywell)', { exact: true }).waitFor();
      await situation.getByText('CTO Build: 1 task failed', { exact: true }).waitFor();
      await situation.locator('.hq-alert.is-trouble').getByRole('button', { name: 'Show it', exact: true }).click();
      const phase = beside('Build');
      await phase.getByText('Wire up payments', { exact: true }).waitFor();
      expect(await room('Engineering').getAttribute('aria-pressed')).toBe('true');
      // And back to the whole of it.
      await phase.getByRole('button', { name: 'The situation', exact: true }).click();
      await situation.waitFor();
      expect(await room('Engineering').getAttribute('aria-pressed')).toBe('false');
      // A line on the map leads to the room it waits on: here, the desk where it waits for a person.
      await map.locator('[data-hq-flow="request:dept:cto>signatory"]').dispatchEvent('click');
      await beside('Signing desk').waitFor();
      expect(await room('Signing desk').getAttribute('aria-pressed')).toBe('true');
      // The counts along the top lead to the same list, from wherever the panel is.
      await press(room('Boardroom'));
      await beside('Boardroom').waitFor();
      await page.getByRole('button', { name: '2 need you', exact: true }).click();
      await situation.waitFor();
      // On the other tabs the note above them is still there.
      await page.getByRole('tab', { name: 'Board', exact: true }).click();
      await page.getByText('1 request is waiting for you to pay or sign.').waitFor();
      expect(await page.locator('.org-strip').count()).toBe(1);
      // A note that appears above the map takes its height from the map, and what is beneath the map stays in view.
      await page.getByRole('tab', { name: 'Headquarters', exact: true }).click();
      await map.waitFor();
      runner.org.status = 'paused';
      runner.org.pauseReason = 'budget';
      await page.getByRole('radio', { name: 'Slow', exact: true }).click();
      const note = page.getByText('The budget is spent, or what is left is too little');
      await note.waitFor();
      const under = async () => {
        const ticker = (await page.locator('.hq-ticker').boundingBox())!;
        return ticker.y + ticker.height;
      };
      await expect.poll(under).toBeLessThanOrEqual(1000);
      expect((await map.boundingBox())!.height).toBeLessThan(frame.height - 20);
      await beside('The situation').getByText('Paused: the budget is spent', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('goes from a room to a desk and to what was written there, and on to the tab where the whole of it is', async () => {
    const runner = await shop('Looked at closely');
    const { page, room, beside, level } = await open(runner);
    try {
      await press(room('Engineering'));
      const department = beside('Engineering');
      await department.getByText('Open the shop for orders').waitFor();
      await department.getByRole('button', { name: 'Agent 2 Idle', exact: true }).waitFor();
      // A desk on the map is a desk in the panel.
      await page.locator('[data-hq="dept:cto/agent/1"]').click();
      const agent = beside('Agent 1');
      await agent.getByText('Last finished', { exact: true }).waitFor();
      await agent.getByText('Say what the shop must do.', { exact: true }).waitFor();
      expect((await agent.locator('.md').innerText()).trim()).toBe('The spec is in spec.md, with the open questions at its end.');
      expect(await page.locator('[data-hq="dept:cto/agent/1"]').getAttribute('class')).toContain('is-selected');
      // Asked to be shown on the map, it is gone to, near enough to read.
      await agent.getByRole('button', { name: 'Show it on the map', exact: true }).click();
      await expect.poll(level).toBe('Desks');
      // The file it wrote opens under Files.
      await agent.getByRole('button', { name: 'spec.md', exact: true }).click();
      expect(await page.locator('.tabs [role=tab][aria-selected=true]').innerText()).toBe('Files');
      await page.getByText('It takes an order and a payment.').waitFor();
      // Coming back, the headquarters is as it was left: the same desk, from the same distance.
      await page.getByRole('tab', { name: 'Headquarters', exact: true }).click();
      await agent.getByText('Say what the shop must do.', { exact: true }).waitFor();
      expect(await level()).toBe('Desks');
      // The plan opens under Plans, on that plan.
      await agent.getByRole('button', { name: 'Open the plan', exact: true }).click();
      expect(await page.locator('.tabs [role=tab][aria-selected=true]').innerText()).toMatch(/^Plans/);
      await page.locator('.plan').filter({ hasText: 'Open the shop for orders' }).getByText('Wire up payments').waitFor();
      // And what waits for a signature or a payment is answered under Signatory.
      await page.getByRole('tab', { name: 'Headquarters', exact: true }).click();
      await page.getByRole('button', { name: 'The situation', exact: true }).click();
      await beside('The situation').locator('.hq-alert.is-you').getByRole('button', { name: 'Show it', exact: true }).click();
      const request = beside('Pay: Payment account (25 GBP a month, to Paywell)');
      await request.getByText('Open a merchant account so that payments can be tested.', { exact: true }).waitFor();
      expect(await room('Signing desk').getAttribute('aria-pressed')).toBe('true');
      await request.getByRole('button', { name: 'Answer it under Signatory', exact: true }).click();
      expect(await page.locator('.tabs [role=tab][aria-selected=true]').innerText()).toMatch(/^Signatory/);
    } finally {
      await page.close();
    }
  });

  it('is moved with the wheel, by dragging and from the keyboard, and shows the whole building in small once part of it is out of view', async () => {
    const runner = await shop('Moved about');
    const { page, map, room, beside, level } = await open(runner);
    try {
      const box = (await map.boundingBox())!;
      const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const where = async (name: string) => (await room(name).locator('.hq-floor').boundingBox())!;
      const whole = await where('Engineering');
      expect(await page.locator('.hq-mini').count()).toBe(0);

      // The wheel brings the map nearer, about the pointer: what is under it stays under it.
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.wheel(0, -300);
      await expect.poll(level).toBe('Desks');
      await page.locator('.hq-mini').waitFor();
      const near = await where('Engineering');
      expect(near.width / whole.width).toBeCloseTo(Math.exp(300 * 0.0019), 1);
      expect((near.x - middle.x) / (whole.x - middle.x)).toBeCloseTo(near.width / whole.width, 1);
      // The page itself has not scrolled.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // Dragging moves it by as far as it was dragged, and is not a press on whatever was under the pointer.
      await page.mouse.down();
      await page.mouse.move(middle.x + 90, middle.y + 50, { steps: 5 });
      await page.mouse.up();
      const dragged = await where('Engineering');
      expect(dragged.x - near.x).toBeCloseTo(90, 0);
      expect(dragged.y - near.y).toBeCloseTo(50, 0);
      await beside('The situation').waitFor();
      expect(await page.locator('.hq-room.is-selected').count()).toBe(0);
      // Nor does it let go of what was chosen before it.
      await room('Engineering').focus();
      await page.keyboard.press('Enter');
      await beside('Engineering').waitFor();
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x - 40, middle.y - 20, { steps: 4 });
      await page.mouse.up();
      expect((await where('Engineering')).x - dragged.x).toBeCloseTo(-40, 0);
      await page.waitForTimeout(50);
      expect(await room('Engineering').getAttribute('aria-pressed')).toBe('true');
      await beside('Engineering').getByRole('button', { name: 'The situation', exact: true }).click();

      // The whole building in small leads to any part of it: a press there, or a drag, puts that part in the middle of the map.
      const mini = (await page.locator('.hq-mini').boundingBox())!;
      const size = await page.evaluate(() => ({ w: document.querySelector('.hq-mini')!.getAttribute('width'), h: document.querySelector('.hq-mini')!.getAttribute('height') }));
      expect(Number(size.w)).toBe(156);
      // Where the middle of the CEO's office is, as a share of the building's width and height.
      const ceo = { x: 593 / 1092, y: 104 / 530 };
      await page.mouse.click(mini.x + mini.width * ceo.x, mini.y + mini.height * ceo.y);
      const office = await where('CEO’s office');
      expect(Math.abs(office.x + office.width / 2 - middle.x)).toBeLessThan(4);
      expect(Math.abs(office.y + office.height / 2 - middle.y)).toBeLessThan(4);
      await page.mouse.move(mini.x + mini.width * 0.2, mini.y + mini.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(mini.x + mini.width * ceo.x, mini.y + mini.height * ceo.y, { steps: 4 });
      await page.mouse.up();
      expect(await where('CEO’s office')).toEqual(office);
      await beside('The situation').waitFor();

      // From the keyboard: 0 shows the whole building, plus and minus go nearer and further, and the arrows move it.
      await map.focus();
      await page.keyboard.press('0');
      await expect.poll(level).toBe('Building');
      await expect.poll(async () => (await where('Engineering')).x).toBeCloseTo(whole.x, 0);
      expect(await page.locator('.hq-mini').count()).toBe(0);
      await page.keyboard.press('+');
      await expect.poll(level).toBe('Rooms');
      await expect.poll(async () => (await where('Engineering')).width / whole.width).toBeCloseTo(1.35, 3);
      const before = await where('Engineering');
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await where('Engineering')).x - before.x).toBeCloseTo(-70, 0);
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await where('Engineering')).y - before.y).toBeCloseTo(-70, 0);
      await page.keyboard.press('-');
      await expect.poll(async () => (await where('Engineering')).width / whole.width).toBeCloseTo(1, 3);
      // A key that moves the map stops it going where it was on its way to: it ends where the key put it.
      await page.keyboard.press('+');
      await page.keyboard.press('ArrowLeft');
      const stopped = await where('Engineering');
      await page.waitForTimeout(500);
      expect(await where('Engineering')).toEqual(stopped);

      // A room is reached with Tab, chosen with Enter and let go with Escape.
      await room('Boardroom').focus();
      await page.keyboard.press('Enter');
      await beside('Boardroom').waitFor();
      expect(await room('Boardroom').getAttribute('aria-pressed')).toBe('true');
      await page.keyboard.press('Escape');
      await beside('The situation').waitFor();

      // The three distances are a press away, and so is a room: pressed twice, it is gone to.
      await page.getByRole('button', { name: 'Desks', exact: true }).click();
      await expect.poll(level).toBe('Desks');
      await expect.poll(async () => (await where('Engineering')).width / whole.width).toBeGreaterThan(2);
      await page.getByRole('button', { name: 'Rooms', exact: true }).click();
      await expect.poll(level).toBe('Rooms');
      await page.getByRole('button', { name: 'Building', exact: true }).click();
      await expect.poll(level).toBe('Building');
      await expect.poll(async () => (await where('Engineering')).width).toBeCloseTo(whole.width, 0);
      // Nearer and further, a step at a time.
      await page.getByRole('button', { name: 'Nearer', exact: true }).click();
      await expect.poll(async () => (await where('Engineering')).width / whole.width).toBeCloseTo(1.35, 3);
      await page.getByRole('button', { name: 'Further', exact: true }).click();
      await expect.poll(async () => (await where('Engineering')).width / whole.width).toBeCloseTo(1, 3);
      await page.getByRole('button', { name: 'Building', exact: true }).click();
      await expect.poll(level).toBe('Building');
      await room('Marketing').locator('.hq-title').dblclick();
      await beside('Marketing').waitFor();
      await expect.poll(async () => (await where('Marketing')).width).toBeGreaterThan(whole.width * 1.3);
      // A press on the ground lets go of it.
      await page.keyboard.press('0');
      await expect.poll(level).toBe('Building');
      await page.mouse.click(box.x + 20, box.y + box.height - 20);
      await beside('The situation').waitFor();

      // In a window too short for all of it the page scrolls, but not from the wheel over the map: there the wheel is the map's.
      await page.setViewportSize({ width: 1440, height: 620 });
      await page.mouse.move(80, 150);
      await page.mouse.wheel(0, 90);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await page.mouse.wheel(0, -600);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const short = (await map.boundingBox())!;
      const was = await atRest(room('Engineering'));
      await page.mouse.move(short.x + short.width / 2, short.y + 180);
      await page.mouse.wheel(0, 120);
      await expect.poll(async () => (await where('Engineering')).width / was.width).toBeCloseTo(Math.exp(-120 * 0.0019), 2);
      // A page that is scrolled by the wheel is scrolled over a moment, so it is given that moment.
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('takes a steer in the shareholders’ room, and keeps one that is half written while another tab is looked at', async () => {
    const runner = await shop('Steered from above');
    const { page, room, beside } = await open(runner);
    try {
      await press(room('Shareholders'));
      const box = beside('Shareholders').getByLabel('Steer for the CEO', { exact: true });
      await box.fill('Take the first order');
      // Beside the tabs it is the same steer, as far as it has been written.
      await page.getByRole('tab', { name: 'Board', exact: true }).click();
      const other = page.locator('.org-side').getByLabel('Steer for the CEO', { exact: true });
      expect(await other.inputValue()).toBe('Take the first order');
      await other.fill('Take the first order this month.');
      await page.getByRole('tab', { name: 'Headquarters', exact: true }).click();
      expect(await box.inputValue()).toBe('Take the first order this month.');
      await beside('Shareholders').getByRole('button', { name: 'Send steer', exact: true }).click();
      await expect.poll(() => runner.org.steers.map((s) => s.text)).toEqual(['Take the first order this month.']);
      await expect.poll(() => box.inputValue()).toBe('');
      // The room says that the CEO has it to take up.
      await expect.poll(() => room('Shareholders').getAttribute('aria-label')).toBe('Shareholders. 1 steer with the CEO');
      await beside('Shareholders').getByText('Take the first order this month.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('fills the window, keeps the page behind out of reach, and gives the window back', async () => {
    const runner = await shop('Filling the window');
    const viewport = { width: 1280, height: 720 };
    const { page, map, room } = await open(runner, viewport);
    try {
      const small = (await map.boundingBox())!;
      await page.getByRole('button', { name: 'Fill the window', exact: true }).click();
      const whole = page.locator('.hq.is-expanded');
      await whole.waitFor();
      expect(await whole.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
      const large = (await map.boundingBox())!;
      expect(large.height).toBeGreaterThan(small.height + 100);
      // The building is drawn to the map it now has.
      await expect.poll(async () => (await room('Engineering').locator('.hq-floor').boundingBox())!.y).toBeGreaterThan(large.y);
      // What is behind it cannot be reached, with the pointer or the keyboard: its own Start is the one that is pressed.
      expect(await page.locator('.org-controls').evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
      expect(await page.locator('.tabs').evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
      expect(await page.locator('.hq').evaluate((el) => el.closest('[inert]') !== null)).toBe(false);
      await whole.getByRole('button', { name: 'Start', exact: true }).click();
      await expect.poll(() => runner.org.status).toBe('running');
      await whole.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect.poll(() => runner.org.status).toBe('paused');
      // Escape gives the window back, and the page with it.
      await page.keyboard.press('Escape');
      await whole.waitFor({ state: 'detached' });
      expect(await page.locator('[inert]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
      await expect.poll(async () => (await map.boundingBox())!.height).toBeCloseTo(small.height, 0);
      // The settings open over the page, so from the filled window the page is gone back to first.
      await page.getByRole('button', { name: 'Fill the window', exact: true }).click();
      await whole.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('dialog[open]').getByRole('button', { name: 'Save settings', exact: true }).waitFor();
      expect(await page.locator('.hq.is-expanded').count()).toBe(0);
      expect(await page.locator('[inert]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('shows the largest team there can be from afar, and goes to a room that is pressed there', async () => {
    const runner = await registry.create({ name: 'Seen from afar', idea: 'A subscription box that sends people a new houseplant every month.', executives: ['engineering', 'product', 'marketing', 'finance', 'operations', 'sales', 'legal', 'data'].map((profileId) => ({ profileId, agentCount: 8 })), settings: { budgetUsd: 100, arbiter: 'judge' } });
    const { page, map, room, beside, level } = await open(runner, { width: 1440, height: 800 });
    try {
      // Eight departments in two rows, and a judge's chambers on the executive floor: all of it in view.
      const frame = (await map.boundingBox())!;
      const rooms = await map.locator('.hq-room').all();
      expect(rooms).toHaveLength(16);
      for (const each of rooms) {
        const box = (await each.locator('.hq-floor').boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(frame.x);
        expect(box.y).toBeGreaterThanOrEqual(frame.y);
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
      }
      await room('Chambers').waitFor();
      // From here a department shows who is in it, and no desk that could be told from the next one.
      expect(await map.locator('[data-hq="dept:cto"] .hq-crowd .hq-person').count()).toBe(9);
      expect(await map.locator('.hq-cell').count()).toBe(0);
      const before = (await room('Data').locator('.hq-floor').boundingBox())!;
      // So a press on a room goes to it, near enough to read, as well as choosing it.
      await press(room('Data'));
      await beside('Data').waitFor();
      await expect.poll(level).toBe('Rooms');
      await expect.poll(async () => (await room('Data').locator('.hq-floor').boundingBox())!.width / before.width).toBeGreaterThan(1.8);
      await expect.poll(() => map.locator('[data-hq="dept:cdo"] .hq-cell').count()).toBe(8);
      const data = await atRest(room('Data'));
      expect(data.x).toBeGreaterThanOrEqual(frame.x);
      expect(data.x + data.width).toBeLessThanOrEqual(frame.x + frame.width);
      // Near enough already, a press chooses and the map stays where it is.
      await press(room('Legal'));
      await beside('Legal').waitFor();
      await page.waitForTimeout(450);
      expect(await atRest(room('Data'))).toEqual(data);
    } finally {
      await page.close();
    }
  });

  it('follows the organisation as it runs: who is at work, what is on its way, and where something has just happened', async () => {
    const runner = await registry.create({ name: 'Watched as it runs', idea: 'A subscription box that sends people a new houseplant every month, with care instructions.', executives: TEAM, settings: { budgetUsd: 100, pace: 'step' } });
    const { page, map, room, beside } = await open(runner);
    try {
      // At the step pace nothing starts by itself, and the headquarters says that it is waited for.
      await page.locator('.org-controls').getByRole('button', { name: 'Start', exact: true }).click();
      await beside('The situation').getByText('Waiting for your next step', { exact: true }).waitFor();
      await page.getByRole('button', { name: '1 needs you', exact: true }).waitFor();
      // The pace is in one line here: what the next step is, is said by the button and on hovering, and not written out beneath.
      expect(await page.locator('.pace-note').count()).toBe(0);
      expect(await page.locator('.hq-bar .pace').getAttribute('title')).toMatch(/^Next: (CTO|CPO|CMO) · Preparing a proposal for the CEO$/);
      // Nothing is in flight, so nothing on the map moves.
      expect(await map.getAttribute('class')).not.toContain('is-live');
      // One step: a lead prepares its proposal for the CEO. Its room is at work, and the proposal is on its way.
      await page.getByRole('button', { name: 'Next step', exact: true }).click();
      // It is listed as at work, and again against its room.
      await expect.poll(() => beside('The situation').locator('.hq-list .hq-item').filter({ hasText: 'Preparing a proposal for the CEO' }).count()).toBe(2);
      const working = map.locator('.hq-room.is-working');
      await working.waitFor();
      expect(await map.getAttribute('class')).toContain('is-live');
      expect(await working.getAttribute('aria-label')).toMatch(/\. Preparing a proposal for the CEO\. At work$/);
      await map.locator('.hq-flow.is-moving.hq-flow-proposal').waitFor({ state: 'attached' });
      await map.locator('.hq-flow-dot').waitFor({ state: 'attached' });
      const from = (await working.getAttribute('data-hq'))!;
      // When it is in, it is among the dispatches, and the room it came from is marked for a moment.
      await page.locator('.hq-ticker .hq-chip').filter({ hasText: 'Proposal' }).first().waitFor();
      await map.locator(`[data-hq="${from}"] .hq-flash`).waitFor({ state: 'attached' });
      await expect.poll(() => map.locator('.hq-room.is-working').count()).toBe(0);
      expect(await map.locator('.hq-flow').count()).toBe(0);
      // A dispatch leads to where it happened.
      await page.locator('.hq-ticker .hq-chip').filter({ hasText: 'Proposal' }).first().click();
      await expect.poll(() => map.locator(`[data-hq="${from}"]`).getAttribute('aria-pressed')).toBe('true');
      // The mark does not stay.
      await map.locator('.hq-flash').waitFor({ state: 'detached' });
      // All of the dispatches are a press away.
      await page.getByRole('button', { name: 'All of them', exact: true }).click();
      await beside('Dispatches').locator('.hq-item').filter({ hasText: 'Proposal' }).first().waitFor();
    } finally {
      runner.stop();
      await page.close();
    }
  });
});
