/** Local browser smoke test. Uses installed Chrome; no external account or model calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { MockProvider } from '../src/server/providers/mock';

const temp = await mkdtemp(path.join(os.tmpdir(), 'paperclips-browser-'));
const store = new Store(path.join(temp, 'data'));
await store.init();
const registry = new Registry(store, new MockProvider({ delayMs: 0, objections: 'never', rework: 'never', followUps: 'never', requests: 'never' }));
const config: Config = { port: 0, host: '127.0.0.1', dataDir: store.dataDir, provider: 'mock', providerReason: 'browser smoke', production: true, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
const app = createApp(registry, config);
app.use(express.static(path.resolve('dist/client')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
const chrome = spawn(process.env.CHROME_PATH ?? '/opt/google/chrome/chrome', [
  '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + path.join(temp, 'profile'), 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError = '';
chrome.stderr.on('data', (part) => { chromeError = (chromeError + String(part)).slice(-4000); });
chrome.on('error', (error) => { chromeError = error.message; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let socket: WebSocket | undefined;
try {
  let port = '';
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(path.join(temp, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]!; break; } catch { await sleep(100); }
  }
  assert(port, 'Chrome did not start: ' + chromeError);
  const page = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(base), { method: 'PUT' })).json() as { webSocketDebuggerUrl: string };
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const exceptions: string[] = [];
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data));
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(JSON.stringify(data.params));
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(data.id);
    if (data.error) request.reject(new Error(JSON.stringify(data.error))); else request.resolve(data.result);
  });
  const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000) });
    socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression: string) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error('Browser condition not reached: ' + expression);
  };
  const click = (label: string) => evaluate('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === ' + JSON.stringify(label) + ')?.click()');
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await wait('document.body?.textContent.includes("Try Only Paperclips")');
  await click('Try Only Paperclips');
  await wait('document.querySelector("h1")?.textContent === "Only Paperclips"');
  await evaluate('Array.from(document.querySelectorAll("[role=tab]")).find(b => b.textContent.startsWith("Calendar")).click()');
  await wait('document.body.textContent.includes("Shared calendar")');
  await click('Show month');
  assert.equal(await evaluate('document.querySelectorAll(".calendar-day").length'), 42);
  await click('Add commitment');
  await wait('!!document.querySelector(".ops-editor")');
  await evaluate('(() => { const field = Array.from(document.querySelectorAll(".ops-editor label")).find(l => l.querySelector(".field-label")?.textContent === "Commitment").querySelector("input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "Browser-checked commitment"); field.dispatchEvent(new Event("input", {bubbles:true})); })()');
  await click('Save job');
  await wait('!document.querySelector(".ops-editor") && document.body.textContent.includes("Browser-checked commitment")');
  // Also exercise editing; remove the test-only commitment from the live agenda before the documentation capture.
  await evaluate('Array.from(document.querySelectorAll(".ops-card")).find(c => c.textContent.includes("Browser-checked commitment")).querySelector("button").click()');
  await wait('!!document.querySelector(".ops-editor")');
  await evaluate('(() => { const field = Array.from(document.querySelectorAll(".ops-editor label")).find(l => l.querySelector(".field-label")?.textContent === "Status").querySelector("select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(field, "cancelled"); field.dispatchEvent(new Event("change", {bubbles:true})); })()');
  await click('Save job');
  await wait('!document.querySelector(".ops-editor") && !document.body.textContent.includes("Browser-checked commitment")');
  if (process.env.UPDATE_SCREENSHOTS === '1') {
    await writeFile('docs/only-paperclips-calendar.png', Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  for (const label of ['Customers', 'Scorecard', 'Finances', 'Knowledge', 'Events', 'History']) {
    await evaluate('Array.from(document.querySelectorAll("[role=tab]")).find(b => b.textContent.startsWith("Business")).click()');
    await wait('!!document.querySelector(".ops-nav")');
    await click(label);
    assert(await evaluate('!!document.querySelector(".operations h2")'));
  }
  await click('Digest');
  await click('Start');
  await wait('document.body.textContent.includes("Waiting for scheduled work")');
  await wait('document.body.textContent.includes("Verify completion")');
  if (process.env.UPDATE_SCREENSHOTS === '1') {
    await writeFile('docs/only-paperclips-business.png', Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  // Exercise narrow screens and client-side rendering after live state pushes.
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('Array.from(document.querySelectorAll("[role=tab]")).find(b => b.textContent.startsWith("Calendar")).click()');
  await wait('document.body.textContent.includes("Shared calendar")');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'Page overflows the viewport');
  assert.deepEqual(exceptions, [], 'Browser runtime errors');
  console.log('Browser smoke passed: example, calendar, job creation/editing, all business registers, live execution and narrow layout.');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await new Promise<void>((resolve) => { if (chrome.exitCode !== null) resolve(); else { chrome.once('exit', () => resolve()); setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  await registry.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}

