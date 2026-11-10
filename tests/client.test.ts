import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keepDataPrivate, serveBuiltClient, serveClientFromSource } from '../src/server/client';

const SECRET = 'sk-test-KEY-THAT-MUST-NOT-LEAVE';

/** One request with its address sent exactly as written: fetch would tidy `..` and `//` away first. */
function get(port: number, rawPath: string): Promise<{ status: number; body: string; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
      })
      .on('error', reject);
  });
}

/** A project folder as the development server sees one: the page, a source file, and the data folder inside it. */
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-dev-'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>the client</title><div id="root"></div>');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hello.js'), 'export const hello = "from source";\n');
  await mkdir(path.join(root, 'data', 'orgs', 'org_1', 'workspace'), { recursive: true });
  await writeFile(path.join(root, 'data', 'connections.json'), JSON.stringify({ connections: [{ id: 'openai', apiKey: SECRET }] }));
  await writeFile(path.join(root, 'data', 'orgs', 'org_1', 'org.json'), JSON.stringify({ id: 'org_1', note: SECRET }));
  await writeFile(path.join(root, 'data', 'orgs', 'org_1', 'access-vault.json'), JSON.stringify({ ciphertext: SECRET }));
  await writeFile(path.join(root, 'data', 'orgs', 'org_1', 'workspace', 'notes.md'), `# Notes\n${SECRET}\n`);
  return root;
}

/** Every way the key file's address can be written, to a server that serves the project folder. */
const addresses = (root: string) => [
  '/data/connections.json',
  '/data/connections.json?raw',
  '/data/connections.json?import&raw',
  '/data/connections.json?url',
  '/data/orgs/org_1/org.json',
  '/data/orgs/org_1/access-vault.json',
  '/data/orgs/org_1/workspace/notes.md',
  `/@fs${root}/data/connections.json`,
  `/@fs${root}/data/connections.json?import&raw`,
  '/DATA/connections.json',
  '/%64ata/connections.json',
  '/data/%2e%2e/data/connections.json',
  '/src/../data/connections.json',
  '//data/connections.json',
  '/data\\connections.json',
  '/data',
];

describe('what the development server hands out', () => {
  let root: string;
  let server: http.Server;
  let port: number;
  let vite: Awaited<ReturnType<typeof serveClientFromSource>>;

  beforeAll(async () => {
    root = await project();
    const app = express();
    vite = await serveClientFromSource(app, { root, dataDir: path.join(root, 'data'), quiet: true });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vite.close();
    await rm(root, { recursive: true, force: true });
  });

  it('serves the client from source', async () => {
    const page = await get(port, '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>the client</title>');
    const source = await get(port, '/src/hello.js');
    expect(source.status).toBe(200);
    expect(source.body).toContain('from source');
  });

  it('gives out nothing from the data folder, however the address is written', async () => {
    for (const address of addresses(root)) {
      const answer = await get(port, address);
      // Turned away before Vite is asked: Vite's own refusal is a 403.
      expect(answer.status, address).toBe(404);
      expect(answer.body, address).not.toContain(SECRET);
    }
  });

  it('has Vite refuse the data folder too, beside what Vite refuses by itself', () => {
    expect(vite.denied).toContain('.env');
    expect(vite.denied.some((pattern) => pattern.includes('.git'))).toBe(true);
    expect(vite.denied).toContain(`${path.join(root, 'data').split(path.sep).join('/')}/**`);
  });
});

describe('the guard in front of whatever serves files', () => {
  let root: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    root = await project();
    const app = express();
    // A file server with no rules of its own, so that only the guard stands between a request and the files. It
    // serves the project folder at its own address and at the one by which the development server reaches a file
    // by its full path: this folder, made for the test, and nothing else on the machine.
    app.use(keepDataPrivate(root, path.join(root, 'data')));
    app.use(express.static(root, { dotfiles: 'allow' }));
    app.use(`/@fs${root}`, express.static(root, { dotfiles: 'allow' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('lets the rest of the project through', async () => {
    expect((await get(port, '/src/hello.js')).body).toContain('from source');
    expect((await get(port, `/@fs${root}/src/hello.js`)).body).toContain('from source');
  });

  it('turns away every address that leads into the data folder', async () => {
    for (const address of addresses(root)) {
      const answer = await get(port, address);
      expect(answer.status, address).toBeGreaterThanOrEqual(400);
      expect(answer.body, address).not.toContain(SECRET);
    }
  });

  it('has nothing to guard, and gets in nobody’s way, when the data folder is kept elsewhere', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-data-'));
    const app = express();
    app.use(keepDataPrivate(root, elsewhere));
    app.use(express.static(root));
    const other = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => other.once('listening', resolve));
    const at = (other.address() as AddressInfo).port;
    try {
      // A folder called "data" inside the project is then only a folder.
      expect((await get(at, '/data/connections.json')).status).toBe(200);
      expect((await get(at, `/@fs${elsewhere}/connections.json`)).status).toBe(404);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('the client as it was built', () => {
  let built: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    built = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-built-'));
    await writeFile(path.join(built, 'index.html'), '<!doctype html><title>the built client</title><div id="root"></div>');
    await mkdir(path.join(built, 'assets'));
    await writeFile(path.join(built, 'assets', 'index-abc123.js'), 'console.log("as built");\n');
    const app = express();
    serveBuiltClient(app, built);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(built, { recursive: true, force: true });
  });

  it('serves the page and what was built with it', async () => {
    expect((await get(port, '/')).body).toContain('the built client');
    // Where the browser is sent once a mailbox has been connected: the page, with a note in the address.
    expect((await get(port, '/?access=connected')).body).toContain('the built client');
    expect((await get(port, '/assets/index-abc123.js')).body).toContain('as built');
  });

  it('sends an address that reads like a page’s to the page, which has only the one', async () => {
    for (const address of ['/org/org_1', '/models', '/new/', '/org/org_1?tab=board']) {
      const answer = await get(port, address);
      expect([answer.status, answer.location], address).toEqual([302, '/']);
    }
  });

  it('says that a file is not there when it is not, and does not answer with the page', async () => {
    // A script from before the last build, the icon a browser asks for unprompted, a file of the data folder.
    for (const address of ['/assets/index-old999.js', '/favicon.ico', '/data/connections.json']) {
      const answer = await get(port, address);
      expect(answer.status, address).toBe(404);
      expect(answer.body, address).not.toContain('the built client');
    }
  });

  it('does not send the browser round for ever when the built page has gone', async () => {
    await rm(path.join(built, 'index.html'));
    const answer = await get(port, '/');
    expect([answer.status, answer.location]).toEqual([404, undefined]);
  });
});
