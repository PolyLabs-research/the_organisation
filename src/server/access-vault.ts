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
/** A tool as its server described it, kept whole: what an agent is shown is what is kept here, and never what the server says later. */
export interface StoredTool {
  /** The server's name for it, and the name agents call it by. */
  name: string; callName: string; description: string;
  /** What it takes, as a JSON Schema. */
  inputSchema: { [key: string]: unknown };
  /** What the server says of it: true, false, or nothing at all. */
  readOnly: boolean | null; destructive: boolean | null;
  /** Why it cannot be offered to a model at all. Empty when it can. */
  unusable: string;
  /** The fingerprint of the description a person allowed. The tool is offered only while its description still has that fingerprint. */
  approved: string | null;
}
/**
 * A sign-in to a tool server made through the browser, kept so that it can be renewed without the person. The token
 * in use sits where a password does. What is here is either a secret too, or says where one of them may go.
 */
export interface ToolSignIn {
  /** The authorisation server the person signed in at, and where it renews a sign-in. A refresh token goes nowhere else, whatever the tool server says later. */
  issuer: string; tokenEndpoint: string;
  /** How that server lets a program prove which program it is, as it said at sign-in. */
  authMethods: string[];
  clientId: string; clientSecret: string;
  /** How this client proves itself, where the service said at registration. Empty to go by what the service takes. */
  clientAuthMethod: string;
  /** Whether a person gave the client, having registered one at the service, or this program registered itself. */
  clientGiven: boolean;
  /** What the token is for and what it allows, as they were asked for. */
  resource: string; scope: string;
  /** Renews the token. Empty where the server gave none: the sign-in then lasts as long as its token does. */
  refreshToken: string;
  /** When the token in use stops working, if the server said. */
  expiresAt: string | null;
  /** The sign-in can no longer be renewed. A person has to sign in again. */
  lapsed: boolean;
  signedInAt: string;
}
/** A server that offers tools. Its token, if it has one, sits where a password does; an empty one means it asks for none. */
export interface ToolServerSecret {
  id: string; label: string; prefix: string; url: string; password: string;
  /** The header the token is sent in. */
  header: string; serverName: string;
  tools: StoredTool[]; toolsLeftOut: number; toolsReadAt: string;
  /** Set where a person signed in through the browser. Absent where they gave a token of their own, or none. */
  signIn?: ToolSignIn | null;
  ownerIds: string[]; enabled: boolean; createdAt: string;
}
export interface VaultData {
  mailboxes: MailboxSecret[]; accounts: AccountSecret[]; repositories: RepositorySecret[]; toolServers: ToolServerSecret[]; drafts: MailDraft[]; requests: AccessRequest[]; audit: AccessAudit[];
}
interface Envelope { version: 1; salt: string; iv: string; tag: string; ciphertext: string; }
const empty = (): VaultData => ({ mailboxes: [], accounts: [], repositories: [], toolServers: [], drafts: [], requests: [], audit: [] });
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
          // From before repositories, and then tool servers, could be connected.
          data.repositories ??= [];
          data.toolServers ??= [];
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
