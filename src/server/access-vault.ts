import { createCipheriv, createDecipheriv, randomBytes, scrypt as derive } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AccessAudit, AccessRequest, AccountView, MailboxView, MailDraft, RepositoryView } from '../shared/access';

export class AccessError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface MailboxSecret extends MailboxView { password: string; }
export interface AccountSecret extends AccountView { password: string; }
/** The token sits where a password does, so that everything that keeps passwords safe keeps it safe too. */
export interface RepositorySecret extends RepositoryView { password: string; }
export interface VaultData {
  mailboxes: MailboxSecret[]; accounts: AccountSecret[]; repositories: RepositorySecret[]; drafts: MailDraft[]; requests: AccessRequest[]; audit: AccessAudit[];
}
interface Envelope { version: 1; salt: string; iv: string; tag: string; ciphertext: string; }
const empty = (): VaultData => ({ mailboxes: [], accounts: [], repositories: [], drafts: [], requests: [], audit: [] });
const keyFor = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  derive(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
});

/** One encrypted file per organisation, outside the agents' workspace. Keys exist only while unlocked. */
export class AccessVault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private data: VaultData | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;

  constructor(readonly file: string, private readonly orgId: string) {}
  get epoch(): number { return this.generation; }
  get unlocked(): boolean { return this.key !== null && this.data !== null; }
  async exists(): Promise<boolean> {
    try { await fs.access(this.file); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new AccessError('The vault file cannot be read.', 500);
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private encrypt(data: VaultData, key: Buffer, salt: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('the_organisation:access:v1:' + this.orgId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const envelope: Envelope = { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    return JSON.stringify(envelope);
  }
  private async persist(contents: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async unlock(passphrase: string, create = false): Promise<void> {
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new AccessError('Use a vault passphrase of 12 to 1024 characters.');
    const generation = this.generation;
    return this.serial(async () => {
      if (this.unlocked) throw new AccessError('The vault is already unlocked.', 409);
      const exists = await this.exists();
      if (create && exists) throw new AccessError('This organisation already has a vault.', 409);
      if (!create && !exists) throw new AccessError('Create a vault first.', 409);
      let key: Buffer | undefined;
      try {
        let data: VaultData;
        let salt: Buffer;
        if (create) {
          salt = randomBytes(16);
          key = await keyFor(passphrase, salt);
          data = empty();
          if (generation !== this.generation) throw new AccessError('Vault unlock was cancelled.', 409);
          await this.persist(this.encrypt(data, key, salt));
        } else {
          const envelope = JSON.parse(await fs.readFile(this.file, 'utf8')) as Envelope;
          salt = Buffer.from(envelope.salt, 'base64');
          if (envelope.version !== 1 || salt.length !== 16 || Buffer.from(envelope.iv, 'base64').length !== 12 || Buffer.from(envelope.tag, 'base64').length !== 16) throw new Error('Invalid vault');
          key = await keyFor(passphrase, salt);
          const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
          decipher.setAAD(Buffer.from('the_organisation:access:v1:' + this.orgId));
          decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
          data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as VaultData;
          if (!['mailboxes', 'accounts', 'drafts', 'requests', 'audit'].every(k => Array.isArray(data[k as keyof VaultData]))) throw new Error('Invalid vault');
          // From before repositories could be connected.
          data.repositories ??= [];
        }
        if (generation !== this.generation) throw new AccessError('Vault unlock was cancelled.', 409);
        this.key = key; this.salt = salt; this.data = data; key = undefined;
      } catch (error) {
        if (error instanceof AccessError) throw error;
        throw new AccessError(create ? 'The vault could not be saved.' : 'The passphrase is incorrect, or the vault file is damaged.');
      } finally { key?.fill(0); }
    });
  }
  lock(): void {
    this.generation++;
    this.key?.fill(0); this.key = null; this.salt = null; this.data = null;
  }
  read(): VaultData {
    if (!this.data || !this.key) throw new AccessError('Unlock the business vault first.', 423);
    return structuredClone(this.data);
  }
  async change<T>(change: (data: VaultData) => T): Promise<T> {
    const generation = this.generation;
    return this.serial(async () => {
      if (generation !== this.generation || !this.key || !this.salt) throw new AccessError('The vault is locked.', 423);
      const data = this.read();
      const result = change(data);
      const contents = this.encrypt(data, this.key, this.salt);
      try { await this.persist(contents); }
      catch { throw new AccessError('The vault could not be saved. No external action was started.', 500); }
      if (generation !== this.generation) throw new AccessError('The vault was locked during the operation.', 423);
      this.data = data;
      return structuredClone(result);
    });
  }
  async backup(): Promise<string> {
    await this.queue;
    if (!await this.exists()) throw new AccessError('There is no vault to back up.', 404);
    return fs.readFile(this.file, 'utf8');
  }
}
