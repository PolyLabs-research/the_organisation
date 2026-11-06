import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessMail } from '../src/server/access-mail';
import type { MailboxSecret } from '../src/server/access-vault';
const state = vi.hoisted(() => ({
  imap: [] as any[], smtp: [] as any[],
  imapError: false, onSend: null as null | ((options: any) => Promise<unknown>),
}));
vi.mock('../src/server/access-network', () => ({ publicAddress: vi.fn(async () => '93.184.215.14'), serviceURL: (value: string) => new URL(value) }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    options: any; closed = false;
    constructor(options: unknown) { this.options = options; state.imap.push(this); }
    on() { return this; }
    async connect() { if (state.imapError) throw new Error('Authentication failed with leaked-password'); }
    close() { this.closed = true; }
    async mailboxOpen(name: string, options: unknown) { Object.assign(this, { folder: name, openOptions: options }); return { exists: 2, uidValidity: 77n }; }
    async *fetch(range: string, query: unknown) { Object.assign(this, { range, query }); yield { uid: 5, envelope: { from: [{ address: 'sender@example.com' }], subject: 'Verify' }, internalDate: new Date('2026-01-01') }; }
    async fetchOne(uid: string, query: unknown, options: unknown) {
      Object.assign(this, { uid, query, fetchOptions: options });
      return { size: 100, source: Buffer.from('From: sender@example.com\r\nSubject: Verify\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour code is 123456.') };
    }
  },
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: (options: any) => {
    const transport = { options, verify: vi.fn(async () => true), sendMail: vi.fn(async (message: unknown) => {
      Object.assign(transport, { message });
      if (state.onSend) return state.onSend(options);
      return { accepted: ['supplier@example.com'], rejected: [] };
    }), close: vi.fn() };
    state.smtp.push(transport);
    return transport;
  } },
}));
const box: MailboxSecret = { id: 'mail_test', provider: 'imap', label: 'Test mailbox', address: 'office@example.com', username: 'office@example.com', password: 'test-app-password', imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 465, ownerIds: ['coo'], enabled: true, createdAt: '' };
beforeEach(() => { state.imap = []; state.smtp = []; state.imapError = false; state.onSend = null; });
describe('IMAP and SMTP transport boundaries', () => {
  it('requires verified TLS on both protocols, pins the destination and disables protocol logging', async () => {
    await new BusinessMail().check(box, new AbortController().signal);
    expect(state.imap[0].options).toMatchObject({ host: '93.184.215.14', secure: true, port: 993, logger: false, tls: { servername: box.imapHost, rejectUnauthorized: true }, maxResponseSize: 2 * 1024 * 1024 });
    expect(state.imap[0].openOptions).toEqual({ readOnly: true });
    expect(state.imap[0].closed).toBe(true);
    expect(state.smtp[0].options).toMatchObject({ host: '93.184.215.14', secure: true, requireTLS: true, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false, tls: { servername: box.smtpHost, rejectUnauthorized: true } });
    expect(state.smtp[0].verify).toHaveBeenCalledTimes(1);
    expect(state.smtp[0].sendMail).not.toHaveBeenCalled();
    expect(state.smtp[0].options.socket.destroyed).toBe(true);
  });
  it('reads by UID and UIDVALIDITY, bounds content and never marks mail read', async () => {
    const client = new BusinessMail(), signal = new AbortController().signal;
    expect(await client.list(box, signal)).toMatchObject([{ id: '77:5', from: 'sender@example.com' }]);
    expect(await client.read(box, '77:5', signal)).toMatchObject({ text: 'Your code is 123456.', truncated: false });
    expect(state.imap[1].fetchOptions).toEqual({ uid: true });
    expect(state.imap[1].query.source.maxLength).toBe(256 * 1024);
    expect(state.imap.every(item => item.openOptions.readOnly)).toBe(true);
    await expect(client.read(box, '78:5', signal)).rejects.toThrow(/mailbox changed/);
    await expect(client.read(box, '1:*', signal)).rejects.toThrow(/Select a message/);
  });
  it('requires STARTTLS on port 587 and sends only plain text from the connected address', async () => {
    await new BusinessMail().send({ ...box, smtpPort: 587 }, { id: 'draft_test', to: 'supplier@example.com', subject: 'Quote', text: 'Ten boxes please.' }, new AbortController().signal);
    expect(state.smtp[0].options).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(state.smtp[0].message).toMatchObject({ from: box.address, to: 'supplier@example.com', text: 'Ten boxes please.', disableFileAccess: true, disableUrlAccess: true });
    expect(state.smtp[0].message.html).toBeUndefined();
    expect(state.smtp[0].message.attachments).toBeUndefined();
  });
  it('destroys the owned SMTP socket on cancellation and strips authentication errors', async () => {
    state.imapError = true;
    await expect(new BusinessMail().list(box, new AbortController().signal)).rejects.not.toThrow('leaked-password');
    state.imapError = false;
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    state.onSend = options => new Promise((_resolve, reject) => { started(); options.socket.once('close', () => reject(new Error('closed'))); });
    const abort = new AbortController();
    const sending = new BusinessMail().send(box, { id: 'draft_test', to: 'supplier@example.com', subject: 'Quote', text: 'Ten boxes.' }, abort.signal);
    const failed = expect(sending).rejects.toThrow(/Delivery could not be confirmed/);
    await ready; abort.abort(); await failed;
    expect(state.smtp[0].options.socket.destroyed).toBe(true);
  });
});
