import { Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { MailMessage, MailSummary } from '../shared/access';
import { AccessError, type MailboxSecret } from './access-vault';
import { publicAddress } from './access-network';
import { GmailMail } from './access-google';

export interface MailTransport {
  check(mailbox: MailboxSecret, signal: AbortSignal): Promise<void>;
  list(mailbox: MailboxSecret, signal: AbortSignal): Promise<MailSummary[]>;
  read(mailbox: MailboxSecret, id: string, signal: AbortSignal): Promise<MailMessage>;
  send(mailbox: MailboxSecret, draft: { id: string; to: string; subject: string; text: string }, signal: AbortSignal): Promise<void>;
}
const MAX_MESSAGE = 256 * 1024;
const cleanHeader = (text: string) => text.replace(/[\r\n]/g, ' ').slice(0, 400);

/** IMAP is read-only. SMTP sends plain text with one recipient and no attachments or remote content. */
export class BusinessMail implements MailTransport {
  private readonly gmail = new GmailMail();
  private async imap<T>(box: MailboxSecret, signal: AbortSignal, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const address = await publicAddress(box.imapHost);
    signal.throwIfAborted();
    const client = new ImapFlow({
      host: address, port: 993, secure: true, servername: box.imapHost,
      tls: { servername: box.imapHost, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: box.username, pass: box.password }, logger: false,
      disableAutoIdle: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      maxResponseSize: 2 * 1024 * 1024,
    });
    client.on('error', () => {}); // Protocol errors must never print authentication material.
    const abort = () => client.close();
    signal.addEventListener('abort', abort, { once: true });
    try { await client.connect(); signal.throwIfAborted(); return await work(client); }
    catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError(signal.aborted ? 'Mail access was cancelled.' : 'The mailbox could not be read. Check its host, username, app password and provider policy.', 502);
    } finally { signal.removeEventListener('abort', abort); client.close(); }
  }
  private async smtp(box: MailboxSecret) {
    const address = await publicAddress(box.smtpHost);
    const socket = new Socket();
    socket.on('error', () => {});
    const transport = nodemailer.createTransport({
      socket, host: address, port: box.smtpPort, secure: box.smtpPort === 465, requireTLS: true,
      tls: { servername: box.smtpHost, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: box.username, pass: box.password },
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    return { transport, socket };
  }
  async check(box: MailboxSecret, signal: AbortSignal): Promise<void> {
    if (box.provider === 'gmail') return this.gmail.check(box, signal);
    await this.imap(box, signal, async client => { await client.mailboxOpen('INBOX', { readOnly: true }); });
    const { transport: smtp, socket } = await this.smtp(box);
    const abort = () => { socket.destroy(); smtp.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); await smtp.verify(); }
    catch { throw new AccessError('SMTP could not authenticate. Check the server, port and app password.', 502); }
    finally { signal.removeEventListener('abort', abort); abort(); }
  }
  async list(box: MailboxSecret, signal: AbortSignal): Promise<MailSummary[]> {
    if (box.provider === 'gmail') return this.gmail.list(box, signal);
    return this.imap(box, signal, async client => {
      const folder = await client.mailboxOpen('INBOX', { readOnly: true });
      if (!folder.exists) return [];
      const messages: MailSummary[] = [];
      for await (const item of client.fetch(Math.max(1, folder.exists - 19) + ':*', { uid: true, envelope: true, internalDate: true })) {
        messages.push({
          id: String(folder.uidValidity) + ':' + item.uid,
          from: cleanHeader(item.envelope?.from?.map(person => person.address ?? '').join(', ') ?? ''),
          subject: cleanHeader(item.envelope?.subject ?? '(no subject)'),
          date: item.internalDate instanceof Date ? item.internalDate.toISOString() : '',
        });
      }
      return messages.reverse();
    });
  }
  async read(box: MailboxSecret, id: string, signal: AbortSignal): Promise<MailMessage> {
    if (box.provider === 'gmail') return this.gmail.read(box, id, signal);
    if (!/^\d+:\d+$/.test(id)) throw new AccessError('Select a message from the inbox first.');
    return this.imap(box, signal, async client => {
      const folder = await client.mailboxOpen('INBOX', { readOnly: true });
      const [validity, uid] = id.split(':');
      if (String(folder.uidValidity) !== validity) throw new AccessError('The mailbox changed. Refresh its message list first.', 409);
      const message = await client.fetchOne(uid!, { source: { start: 0, maxLength: MAX_MESSAGE }, size: true }, { uid: true });
      if (!message || !message.source) throw new AccessError('This message is no longer in the inbox.', 404);
      const parsed = await simpleParser(message.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_MESSAGE });
      const text = parsed.text ?? '';
      return { id, from: cleanHeader(parsed.from?.text ?? ''), subject: cleanHeader(parsed.subject ?? '(no subject)'), date: parsed.date?.toISOString() ?? '', text: text.slice(0, 20000), truncated: (message.size ?? 0) > MAX_MESSAGE || text.length > 20000 };
    });
  }
  async send(box: MailboxSecret, draft: { id: string; to: string; subject: string; text: string }, signal: AbortSignal): Promise<void> {
    if (box.provider === 'gmail') return this.gmail.send(box, draft, signal);
    const { transport: smtp, socket } = await this.smtp(box);
    const abort = () => { socket.destroy(); smtp.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await smtp.sendMail({
        from: box.address, to: draft.to, subject: draft.subject, text: draft.text,
        messageId: '<' + draft.id + '@' + box.address.split('@')[1] + '>',
        disableFileAccess: true, disableUrlAccess: true,
      });
      if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP did not accept the recipient');
    } catch { throw new AccessError('Delivery could not be confirmed. Check the mailbox before drafting another copy.', 502); }
    finally { signal.removeEventListener('abort', abort); abort(); }
  }
}
