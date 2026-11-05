import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PRESETS, type Price } from './providers/catalogue';
import type { ListedModel } from './providers/openai-compatible';

// The API keys this server can call models with: which provider each is for,
// where that provider's API is, and what the key was last seen to offer.
// Keys added through the interface are kept in a file only this user can
// read. Keys can also come from the environment, in which case the key
// itself is never written anywhere by this program.

export interface Connection {
  /** Short and stable: it is the first part of every model reference that uses this key, e.g. "openai" in "openai:gpt-5". */
  id: string;
  /** Which provider this is, from the catalogue. */
  presetId: string;
  label: string;
  baseURL: string;
  apiKey: string;
  /** stored: added through the interface and kept on disk. env: read from the environment when the server started. */
  source: 'stored' | 'env';
  addedAt: string;
  /** The chat models the key could call when the provider was last asked. Empty if the provider does not list them. */
  models: ListedModel[];
  checkedAt: string | null;
  /** Why the last attempt to list the key's models failed, if it did. */
  listingError: string | null;
  /** Prices set by hand for models on this connection. They stand over the catalogue's. */
  prices: Record<string, Price>;
  /** Model ids added by hand, for a provider whose listing does not have them. */
  extraModels: string[];
}

/** What is kept on disk for a connection whose key comes from the environment: everything but the key. */
type Remembered = Pick<Connection, 'models' | 'checkedAt' | 'listingError' | 'prices' | 'extraModels'>;

interface FileShape {
  version: 1;
  connections: Connection[];
  /** What was learned about connections that come from the environment, by connection id. */
  environment: Record<string, Remembered>;
  /** True once this server has had a key of any kind. From then on, having none is a lack of keys, not a simulation. */
  hadKeys?: boolean;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;

export class ConnectionStore {
  private stored: Connection[] = [];
  private fromEnv: Connection[] = [];
  private remembered: Record<string, Remembered> = {};
  private everHadKeys = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Whether Anthropic credentials can be found without a key being handed over (an `ant auth login` profile, say). */
    private readonly anthropicAmbient = false,
  ) {}

  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      let parsed: Partial<FileShape>;
      try {
        parsed = JSON.parse(text) as Partial<FileShape>;
      } catch {
        // Carrying on as if there were no keys would run organisations on the simulator, and the next
        // save would write over whatever keys the file still holds. Better to stop and say so.
        throw new Error(`${this.file} cannot be read: it is not valid JSON. Repair it, or move it aside and add the keys again, then start the server.`);
      }
      this.stored = Array.isArray(parsed.connections) ? parsed.connections.filter((c) => c && ID.test(c.id) && typeof c.apiKey === 'string' && !!address(String(c.baseURL ?? ''))).map(tidy) : [];
      this.remembered = parsed.environment && typeof parsed.environment === 'object' ? parsed.environment : {};
      this.everHadKeys = parsed.hadKeys === true || this.stored.length > 0;
    }
    this.fromEnv = [];
    for (const preset of PRESETS) {
      const name = preset.env.find((n) => (this.env[n] ?? '').trim());
      const ambient = preset.id === 'anthropic' && this.anthropicAmbient;
      if (!name && !ambient) continue;
      // A key added by hand for the same provider takes the provider's plain id; the one from the environment stands beside it.
      const id = this.stored.some((c) => c.id === preset.id) ? `${preset.id}-env` : preset.id;
      // A provider with more than one platform is reached at its first unless the environment names another address.
      const elsewhere = address(this.env[baseUrlVariable(preset.id)] ?? '');
      this.fromEnv.push(
        tidy({
          id,
          presetId: preset.id,
          label: preset.label,
          baseURL: elsewhere || preset.regions[0]!.baseURL,
          apiKey: name ? this.env[name]!.trim() : '',
          source: 'env',
          addedAt: new Date(0).toISOString(),
          ...(this.remembered[id] ?? { models: [], checkedAt: null, listingError: null, prices: {}, extraModels: [] }),
        }),
      );
    }
    if (this.fromEnv.length && !this.everHadKeys) {
      this.everHadKeys = true;
      await this.save();
    }
  }

  /**
   * True once this server has had a key, even if it has none now. A server that has never had one simulates;
   * one that has lost its keys must say so, not carry real organisations on with made-up answers.
   */
  get hadKeys(): boolean {
    return this.everHadKeys || this.list().length > 0;
  }

  /** Every connection, the ones from the environment first, each group in the order it was added. */
  list(): Connection[] {
    return [...this.fromEnv, ...this.stored];
  }

  get(id: string): Connection | undefined {
    return this.list().find((c) => c.id === id);
  }

  /** An id for a new connection to this provider: the provider's own, or that with a number if it is taken. */
  freeId(presetId: string): string {
    const taken = new Set(this.list().map((c) => c.id));
    if (!taken.has(presetId)) return presetId;
    for (let n = 2; ; n++) if (!taken.has(`${presetId}-${n}`)) return `${presetId}-${n}`;
  }

  async add(connection: Connection): Promise<void> {
    if (!ID.test(connection.id) || this.get(connection.id)) throw new Error(`A connection called ${connection.id} already exists.`);
    this.stored.push(tidy({ ...connection, source: 'stored' }));
    this.everHadKeys = true;
    await this.save();
  }

  /** Change what is kept about a connection. Returns it, or undefined if there is none of that id. */
  async update(id: string, change: (connection: Connection) => void): Promise<Connection | undefined> {
    const connection = this.get(id);
    if (!connection) return undefined;
    change(connection);
    if (connection.source === 'env') {
      const { models, checkedAt, listingError, prices, extraModels } = connection;
      this.remembered[id] = { models, checkedAt, listingError, prices, extraModels };
    }
    await this.save();
    return connection;
  }

  /** Forget a key that was added through the interface. One from the environment cannot be removed from here. */
  async remove(id: string): Promise<boolean> {
    const index = this.stored.findIndex((c) => c.id === id);
    if (index < 0) return false;
    this.stored.splice(index, 1);
    await this.save();
    return true;
  }

  /** One write at a time, to a temporary file that is then renamed, readable by this user only. */
  private save(): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        const shape: FileShape = { version: 1, connections: this.stored, environment: this.remembered, hadKeys: this.everHadKeys };
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(shape, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, this.file);
        await fs.chmod(this.file, 0o600);
      });
    return this.writing;
  }
}

function tidy(connection: Connection): Connection {
  return {
    ...connection,
    models: Array.isArray(connection.models) ? connection.models : [],
    checkedAt: connection.checkedAt ?? null,
    listingError: connection.listingError ?? null,
    prices: connection.prices && typeof connection.prices === 'object' ? connection.prices : {},
    extraModels: Array.isArray(connection.extraModels) ? connection.extraModels : [],
  };
}

/** The environment variable that gives a provider's address when it is not the usual one, e.g. DEEPSEEK_BASE_URL. */
export function baseUrlVariable(presetId: string): string {
  return `${presetId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BASE_URL`;
}

/** A base address with no trailing slash, or '' if it is not an http(s) address. */
export function address(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : '';
  } catch {
    return '';
  }
}

/** The end of a key, for showing which one it is without showing it. */
export function keyHint(apiKey: string): string {
  if (!apiKey) return '';
  return apiKey.length <= 8 ? '…' : `…${apiKey.slice(-4)}`;
}
