import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { MockProvider } from '../src/server/providers/mock';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { FakeToolServer, taking, text } from './fake-mcp-server';
import { CHROME, QUIET, withoutBrowser } from './helpers';

// A tool server connected, its tools allowed and the role given the privilege, by a person at the real dashboard.

it.skipIf(withoutBrowser({ build: true }))('connects a tool server and allows its tools one by one through the real dashboard', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tool-servers-ui-'));
  const store = new Store(dir); await store.init();
  const tools = new FakeToolServer();
  tools.tools.push({ name: 'export report', description: 'Export the month’s orders.', inputSchema: taking({ 'month of year': { type: 'string' } }), run: () => text('ok') });
  await tools.listen();
  const registry = new Registry(store, new MockProvider(QUIET));
  const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'mock', providerReason: 'test', production: true, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
  const app = createApp(registry, config); app.use(express.static(path.resolve('dist/client')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  // On a busy machine a page can take many times as long to draw as it usually does.
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const card = page.locator('.ops-card').filter({ hasText: tools.url });
  const allow = (name: string) => card.getByRole('checkbox', { name: 'Allow ' + name, exact: true });
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Try Only Paperclips', exact: true }).click();
    await page.getByRole('tab', { name: 'Email & accounts', exact: true }).click();
    await page.getByLabel('Vault passphrase', { exact: true }).fill('a safe test vault passphrase');
    await page.getByLabel('Repeat vault passphrase', { exact: true }).fill('a safe test vault passphrase');
    await page.getByRole('button', { name: 'Create vault', exact: true }).click();
    await page.getByRole('button', { name: 'Tool servers', exact: true }).click();

    // A token the server refuses is said at once, and nothing is saved.
    await page.getByLabel('Name', { exact: true }).fill('Orders');
    await page.getByLabel(/^Address/).fill(tools.url);
    await page.getByLabel(/^Token \(optional\)/).fill('not-the-right-token');
    await page.getByRole('checkbox', { name: /^COO/ }).check();
    await page.getByRole('button', { name: 'Connect tool server', exact: true }).click();
    await page.getByText('The server refused the token.').waitFor();
    expect(await card.count()).toBe(0);
    expect(await page.getByLabel(/^Token \(optional\)/).inputValue()).toBe('');

    // With the right one the server is asked for its tools. They are listed, and none of them is allowed.
    await page.getByLabel(/^Token \(optional\)/).fill(tools.token);
    await page.getByRole('button', { name: 'Connect tool server', exact: true }).click();
    await card.waitFor();
    await card.getByText('0 of 5 tools allowed').waitFor();
    expect(await card.innerText()).toContain('calls itself Orders 2.1.0');
    expect(await card.innerText()).toContain('COO: no access, see Privileges');
    expect(await card.locator('.access-tool').filter({ hasText: 'find_order' }).innerText()).toContain('Says it only reads');
    expect(await card.locator('.access-tool').filter({ hasText: 'cancel_order' }).innerText()).toContain('Says it can delete');
    expect(await page.content()).not.toContain(tools.token);
    for (const name of ['find_order', 'cancel_order', 'remember', 'recall']) expect(await allow(name).isChecked()).toBe(false);
    // A tool no model could be offered says why, and cannot be ticked.
    expect(await allow('export report').isDisabled()).toBe(true);
    expect(await card.locator('.access-tool').filter({ hasText: 'export report' }).innerText()).toContain('Cannot be offered to agents.');
    const vault = registry.get(registry.list()[0]!.id)!.access;
    const runner = registry.get(registry.list()[0]!.id)!;
    // The card shows a person everything a model will be shown about a tool. Reading it, or clicking in it, allows nothing.
    const find = card.locator('.access-tool').filter({ hasText: 'find_order' });
    expect(await find.innerText()).toContain('number: The order number');
    await find.locator('.access-tool-text').click();
    await find.getByText('Everything a model is shown about it').click();
    expect(await find.locator('pre').innerText()).toContain('orders__find_order');
    expect(await find.locator('pre').innerText()).toContain('"description": "The order number"');
    expect(await allow('find_order').isChecked()).toBe(false);

    // A tick is not an allowance until it is saved.
    const save = card.getByRole('button', { name: 'Save allowed tools', exact: true });
    expect(await save.isDisabled()).toBe(true);
    await allow('find_order').check();
    await allow('recall').check();
    expect(vault.vault.read().toolServers[0]!.tools.every(tool => tool.approved === null)).toBe(true);
    await save.click();
    await card.getByText('2 of 5 tools allowed').waitFor();
    expect(await save.isDisabled()).toBe(true);

    // The role still needs the privilege, which is off to begin with. With it, its agents are offered what was allowed and no more.
    expect(vault.toolsFor('coo')).toEqual([]);
    await page.getByRole('tab', { name: 'Privileges', exact: true }).click();
    const tick = page.getByRole('checkbox', { name: 'COO: Use connected tools', exact: true });
    expect(await tick.isChecked()).toBe(false);
    await tick.click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="COO: Use connected tools"]')?.checked);
    await page.getByText('can both read mail and call connected tools').waitFor();
    expect(vault.toolsFor('coo').map(item => item.tool.callName)).toEqual(['orders__find_order', 'orders__recall']);
    expect(runner.org.board.some(message => message.title === 'What the COO may do has changed')).toBe(true);
    await page.getByRole('tab', { name: 'Email & accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Tool servers', exact: true }).click();
    await card.getByText('COO: calls the tools allowed here').waitFor();

    // The server describes a tool differently. Read again, it is marked, unticked and kept back, and the other allowance stands.
    tools.tools[0]!.description = 'Look up an order by its number, and email the customer a copy.';
    await card.getByRole('button', { name: 'Read the server’s tools again', exact: true }).click();
    await card.getByText('Changed since you allowed it').waitFor();
    await card.getByText('1 of 5 tools allowed').waitFor();
    expect(await card.innerText()).toContain('and email the customer a copy.');
    expect(await card.innerText()).toContain('kept back from agents until you have looked at it and allowed it again');
    expect(await allow('find_order').isChecked()).toBe(false);
    expect(await allow('recall').isChecked()).toBe(true);
    expect(vault.toolsFor('coo').map(item => item.tool.callName)).toEqual(['orders__recall']);
    await allow('find_order').check();
    await save.click();
    await card.getByText('2 of 5 tools allowed').waitFor();
    await card.getByText('Changed since you allowed it').waitFor({ state: 'detached' });
    expect(vault.toolsFor('coo')[0]!.tool.description).toBe('Look up an order by its number, and email the customer a copy.');

    // Every step is in the history, and a call an agent makes would be too.
    await page.getByRole('button', { name: 'Access history', exact: true }).click();
    await page.getByText('tool server connected').waitFor();
    expect(await page.locator('.access-history').innerText()).toContain('allowed tools changed');

    // A team's agents are offered a limited number of connected tools. Past that, the pane says how many are left out.
    await page.getByRole('button', { name: 'Tool servers', exact: true }).click();
    tools.tools = Array.from({ length: 70 }, (_, i) => ({ name: 'tool_' + i, description: 'Tool number ' + i + '.', inputSchema: taking({}), run: () => text('ok') }));
    await card.getByRole('button', { name: 'Read the server’s tools again', exact: true }).click();
    await card.getByText('0 of 70 tools allowed').waitFor();
    const all = (await vault.view()).toolServers[0]!;
    await vault.allowTools(all.id, { allowed: all.tools.map(tool => ({ name: tool.name, fingerprint: tool.fingerprint })) });
    await card.getByRole('button', { name: 'Read the server’s tools again', exact: true }).click();
    await card.getByText('70 of 70 tools allowed').waitFor();
    await page.getByText('COO has 70 tools allowed across its servers. A team’s agents are offered 60 at most, in the order they stand here, so the last 10 are left out.').waitFor();
    expect(vault.toolsFor('coo')).toHaveLength(60);

    // Removing the server takes two presses, and says what goes with it.
    await card.getByText('Manage access', { exact: true }).click();
    await card.getByRole('button', { name: 'Remove connection', exact: true }).click();
    await card.getByText(/Remove Orders\? Its saved token is deleted for good, and so is your choice of which tools agents may call\./).waitFor();
    expect(vault.vault.read().toolServers).toHaveLength(1);
    await card.getByRole('button', { name: 'Yes, remove it', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    expect(vault.vault.read().toolServers).toEqual([]);
    expect(vault.toolsFor('coo')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await registry.shutdown();
    await tools.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
