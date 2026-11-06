import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AccessVault } from '../src/server/access-vault';
import { BusinessAccess } from '../src/server/access';
import { accessTools } from '../src/server/access-tools';
import { publicIP, serviceURL } from '../src/server/access-network';
import { redactData } from '../src/server/access-browser';
import type { MailTransport } from '../src/server/access-mail';
import type { AccountBrowser } from '../src/server/access-browser';

const phrase = 'a long business vault passphrase';
const mailPassword = 'test-only-mail-secret';
const accountPassword = 'test-only-site-secret';
const mailbox = { label: 'Business', address: 'office@paperclips.example', username: 'office@paperclips.example', password: mailPassword, imapHost: 'imap.paperclips.example', smtpHost: 'smtp.paperclips.example', smtpPort: 465, ownerIds: ['coo'] };
const account = { label: 'Supplier', loginUrl: 'https://supplies.example/login', username: 'paperclips', password: accountPassword, ownerIds: ['coo'] };
let dir: string;
let access: BusinessAccess;
let mail: MailTransport;
let browser: AccountBrowser;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'business-access-'));
  mail = {
    check: vi.fn(async () => {}),
    list: vi.fn(async () => [{ id: '1:2', from: 'supplier@supplies.example', subject: 'Verify your account', date: '' }]),
    read: vi.fn(async () => ({ id: '1:2', from: 'supplier@supplies.example', subject: 'Verify your account', date: '', text: 'Verification code 123456. ' + mailPassword, truncated: false })),
    send: vi.fn(async () => {}),
  };
  browser = {
    run: vi.fn(async () => ({ title: 'Logged in', url: 'https://supplies.example/home', text: 'Echo: ' + accountPassword, elements: [], notice: '' })),
    close: vi.fn(async () => {}),
  };
  access = new BusinessAccess(path.join(dir, 'access-vault.json'), 'org_test', () => ['ceo', 'coo', 'cto'], { mail, browser });
  await access.unlock(phrase, true);
});
afterEach(async () => { await access.dispose(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('encrypted business vault', () => {
  it('encrypts passwords and private records, uses private file permissions and starts locked after restart', async () => {
    await access.addMailbox(mailbox);
    const saved = await access.addAccount(account);
    const data = await readFile(access.vault.file, 'utf8');
    for (const secret of [phrase, mailPassword, accountPassword, mailbox.address, account.username]) expect(data).not.toContain(secret);
    expect((await stat(access.vault.file)).mode & 0o777).toBe(0o600);
    const restarted = new AccessVault(access.vault.file, 'org_test');
    expect(restarted.unlocked).toBe(false);
    expect(() => restarted.read()).toThrow(/Unlock/);
    await restarted.unlock(phrase);
    expect(restarted.read().accounts.find(item => item.id === saved.id)?.password).toBe(accountPassword);
    restarted.lock();
  });
  it('rejects wrong passphrases, tampering, and copying a vault to another organisation', async () => {
    const other = new AccessVault(access.vault.file, 'org_other');
    await expect(other.unlock(phrase)).rejects.toThrow(/incorrect|damaged/);
    const reopened = new AccessVault(access.vault.file, 'org_test');
    await expect(reopened.unlock('not the correct passphrase')).rejects.toThrow(/incorrect/);
    const envelope = JSON.parse(await readFile(access.vault.file, 'utf8'));
    envelope.tag = Buffer.alloc(16).toString('base64');
    await writeFile(access.vault.file, JSON.stringify(envelope));
    await expect(reopened.unlock(phrase)).rejects.toThrow(/damaged/);
  });
  it('serialises concurrent writes and refuses to overwrite an existing vault', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => access.request('coo', { service: 'Service ' + i, reason: 'Needed for work' })));
    expect((await access.view()).requests).toHaveLength(12);
    const other = new AccessVault(access.vault.file, 'org_test');
    await expect(other.unlock(phrase, true)).rejects.toThrow(/already/);
  });
  it('leaves committed memory and disk unchanged when a mutation or save fails', async () => {
    await expect(access.vault.change(data => { data.requests.push({ id: 'bad', actorId: 'coo', service: 'Bad', reason: 'Bad', createdAt: '', status: 'open' }); throw new Error('no'); })).rejects.toThrow('no');
    expect(access.vault.read().requests).toEqual([]);
    const original = await readFile(access.vault.file, 'utf8');
    await rm(access.vault.file);
    // A directory at the destination makes the atomic rename fail without mocking the crypto/storage code.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(access.vault.file);
    await expect(access.request('coo', { service: 'Unsaved', reason: 'Must not be acknowledged' })).rejects.toThrow(/saved/);
    expect(access.vault.read().requests).toEqual([]);
    await rm(access.vault.file, { recursive: true });
    await writeFile(access.vault.file, original);
  });
  it('locks automatically without an access action', async () => {
    const short = new BusinessAccess(path.join(dir, 'short.json'), 'org_short', () => ['coo'], { idleMs: 30 });
    await short.unlock(phrase, true);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect((await short.view()).unlocked).toBe(false);
    await short.dispose();
  });
});

describe('business access permissions', () => {
  it('enforces team grants on inboxes, messages, drafts and accounts', async () => {
    const box = await access.addMailbox(mailbox);
    const site = await access.addAccount({ ...account, mailboxId: box.id });
    await expect(access.listMail(box.id, 'cto')).rejects.toMatchObject({ status: 403 });
    await expect(access.readMail(box.id, '1:2', 'cto')).rejects.toMatchObject({ status: 403 });
    await expect(access.draft({ mailboxId: box.id, to: 'contact@example.com', subject: 'Hello', text: 'Hello' }, 'cto')).rejects.toMatchObject({ status: 403 });
    await expect(access.browse({ accountId: site.id, action: 'login' }, 'cto', 'task2')).rejects.toMatchObject({ status: 403 });
    expect(mail.list).not.toHaveBeenCalled();
    expect(browser.run).not.toHaveBeenCalled();
    expect(access.context('cto')).not.toContain(box.id);
    expect(access.context('coo')).toContain(box.id);
  });
  it('never returns mailbox secrets, account passwords or the passphrase in public views and context', async () => {
    const box = await access.addMailbox(mailbox);
    const site = await access.addAccount(account);
    const view = JSON.stringify(await access.view()) + access.context('coo');
    for (const value of [mailPassword, accountPassword, phrase]) expect(view).not.toContain(value);
    expect((await access.readMail(box.id, '1:2', 'coo')).text).toContain('[redacted]');
    expect((await access.browse({ accountId: site.id, action: 'login' }, 'coo', 'task1')).text).toBe('Echo: [redacted]');
    expect(await access.reveal(site.id)).toBe(accountPassword);
    expect((await access.view()).audit.some(item => item.action === 'password_revealed')).toBe(true);
  });
  it('redacts secrets containing JSON metacharacters without corrupting structured results', () => {
    const secret = 'strange"\\password';
    const input = { text: 'contains ' + secret, nested: [secret, encodeURIComponent(secret)] };
    expect(redactData(input, [secret])).toEqual({ text: 'contains [redacted]', nested: ['[redacted]', '[redacted]'] });
  });
  it('generates a unique saved password before account creation and validates account origins', async () => {
    const site = await access.addAccount({ ...account, password: '', allowSignup: true, signupUrl: 'https://supplies.example/signup' });
    expect((await access.reveal(site.id)).length).toBeGreaterThanOrEqual(32);
    await expect(access.addAccount({ ...account, loginUrl: 'http://supplies.example/login' })).rejects.toThrow(/HTTPS/);
    await expect(access.addAccount({ ...account, signupUrl: 'https://other.example/signup' })).rejects.toThrow(/same/);
    await expect(access.addAccount({ ...account, ownerIds: ['invented'] })).rejects.toThrow(/existing/);
    await expect(access.addAccount({ ...account, password: '' })).rejects.toThrow(/existing account password/);
  });
  it('aborts in-flight reads on revocation and prevents the old grant from receiving the result', async () => {
    const box = await access.addMailbox(mailbox);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mail.read = vi.fn((_box, _id, signal) => new Promise<never>((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
    const reading = access.readMail(box.id, '1:2', 'coo');
    const failed = expect(reading).rejects.toMatchObject({ status: 409 });
    await ready;
    await access.grant('mailboxes', box.id, { ownerIds: ['cto'], enabled: true });
    await failed;
    await expect(access.listMail(box.id, 'coo')).rejects.toMatchObject({ status: 403 });
  });
  it('closes sessions on lock and rejects subsequent tool use', async () => {
    const site = await access.addAccount(account);
    await access.browse({ accountId: site.id, action: 'login' }, 'coo', 'task1');
    await access.lock();
    expect(browser.close).toHaveBeenCalled();
    await expect(access.reveal(site.id)).rejects.toMatchObject({ status: 423 });
    const locked = await access.view();
    expect(locked.accounts).toEqual([]);
    expect(locked.mailboxes).toEqual([]);
  });
  it('requires explicit team assignment and keeps inactive tasks from invoking tools', async () => {
    const box = await access.addMailbox({ ...mailbox, ownerIds: [] });
    await expect(access.listMail(box.id, 'ceo')).rejects.toMatchObject({ status: 403 });
    const tools = accessTools(access, 'coo', 'task1', new AbortController().signal, () => false);
    expect(JSON.parse(await tools.find(tool => tool.name === 'read_business_email')!.run({ mailboxId: box.id })).error).toMatch(/no longer active/);
    expect(mail.list).not.toHaveBeenCalled();
    expect(tools.some(tool => /send|reveal|password/.test(tool.name))).toBe(false);
  });
  it('does not expose adapter errors containing credentials to the model', async () => {
    const box = await access.addMailbox(mailbox);
    mail.list = vi.fn(async () => { throw new Error('login failed for ' + mailPassword); });
    const tools = accessTools(access, 'coo', 'task1', new AbortController().signal, () => true);
    const result = await tools.find(tool => tool.name === 'read_business_email')!.run({ mailboxId: box.id });
    expect(result).not.toContain(mailPassword);
    expect(JSON.parse(result).error).toMatch(/could not complete/);
  });
});

describe('email drafts and delivery', () => {
  it('only sends on the separate person action and prevents concurrent or repeated sends', async () => {
    const box = await access.addMailbox(mailbox);
    const draft = await access.draft({ mailboxId: box.id, to: 'supplier@example.com', subject: 'Quote', text: 'Please quote for 10 boxes.' }, 'coo');
    expect(mail.send).not.toHaveBeenCalled();
    const results = await Promise.allSettled([access.sendDraft(draft.id), access.sendDraft(draft.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect((await access.view()).drafts[0]!.status).toBe('sent');
    await expect(access.sendDraft(draft.id)).rejects.toThrow(/already been attempted/);
  });
  it('keeps ambiguous delivery marked uncertain across restart and never silently retries', async () => {
    const box = await access.addMailbox(mailbox);
    const draft = await access.draft({ mailboxId: box.id, to: 'supplier@example.com', subject: 'Quote', text: 'Please quote.' }, 'coo');
    mail.send = vi.fn(async () => { throw new Error('connection dropped'); });
    await expect(access.sendDraft(draft.id)).rejects.toThrow();
    expect((await access.view()).drafts[0]!.status).toBe('uncertain');
    await access.lock();
    await access.unlock(phrase);
    await expect(access.sendDraft(draft.id)).rejects.toThrow(/already been attempted/);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
  it('recovers a crash during sending as uncertain and deduplicates repeated draft requests', async () => {
    const box = await access.addMailbox(mailbox);
    const spec = { mailboxId: box.id, to: 'supplier@example.com', subject: 'Quote', text: 'Please quote.' };
    const first = await access.draft(spec, 'coo');
    expect((await access.draft(spec, 'coo')).id).toBe(first.id);
    await access.vault.change(data => { data.drafts[0]!.status = 'sending'; });
    await access.lock();
    await access.unlock(phrase);
    expect((await access.view()).drafts[0]!.status).toBe('uncertain');
  });
  it('refuses headers, multiple recipients and saved passwords in drafts', async () => {
    const box = await access.addMailbox(mailbox);
    const spec = { mailboxId: box.id, to: 'supplier@example.com', subject: 'Quote', text: 'Please quote.' };
    for (const change of [{ subject: 'Hi\r\nBcc: leak@example.com' }, { to: 'one@example.com,two@example.com' }, { text: mailPassword }]) await expect(access.draft({ ...spec, ...change }, 'coo')).rejects.toThrow();
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('network destinations', () => {
  it.each(['127.0.0.1', '10.0.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '224.0.0.1', '2001:db8::1'])('refuses private or reserved address %s', ip => { expect(publicIP(ip)).toBe(false); });
  it('accepts public addresses but refuses unsafe or ambiguous service URLs', () => {
    expect(publicIP('8.8.8.8')).toBe(true);
    for (const value of ['file:///etc/passwd', 'http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://example.com:8443', 'https://user:pass@example.com', 'https://host.local', 'https://example.com.']) expect(() => serviceURL(value)).toThrow();
    expect(serviceURL('https://supplies.example/login').origin).toBe('https://supplies.example');
  });
});
