import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import type { PlanJob } from '../types';

// Files in and out of a hosted session. In: workspace files are uploaded once
// and mounted read-only in the sandbox. Out: what the session writes to its
// output folder is listed and downloaded through the Files API.

/** Listing a session's files needs this header, which the files client does not add by itself. */
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
/**
 * An upload is kept for thirty days and then removed by Anthropic. A session
 * gets its own copy of each file when it is created, so the upload is only
 * needed again if another session mounts the same file before it expires.
 */
const UPLOAD_TTL_SECONDS = 30 * 24 * 3600;
const UPLOADS_AT_ONCE = 4;

interface Uploaded {
  size: number;
  modifiedAt: string;
  fileId: string;
  expiresAt: string;
}

export interface Mount {
  /** Path within the workspace. */
  path: string;
  fileId: string;
}

/**
 * One at a time for each record. Every plan has its own `Uploads` for its organisation's one record, and plans
 * that start together would each read it before any had written it: every file would be sent once per plan,
 * and their writes of the record would run into one another.
 */
const turns = new Map<string, Promise<void>>();

function inTurn<T>(record: string, work: () => Promise<T>): Promise<T> {
  const result = (turns.get(record) ?? Promise.resolve()).then(work);
  // Whoever is next goes ahead whether this went well or not.
  const done = result.then(
    () => {},
    () => {},
  );
  turns.set(record, done);
  void done.then(() => {
    if (turns.get(record) === done) turns.delete(record);
  });
  return result;
}

/** The uploads made for one organisation, remembered on disk so an unchanged file is not sent twice. */
export class Uploads {
  private known: Record<string, Uploaded> | null = null;
  private readonly file: string;

  constructor(
    private readonly client: Anthropic,
    stateDir: string,
  ) {
    this.file = path.join(stateDir, 'uploads.json');
  }

  private async load(): Promise<Record<string, Uploaded>> {
    if (this.known) return this.known;
    try {
      this.known = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, Uploaded>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      this.known = {};
    }
    return this.known;
  }

  private async save(): Promise<void> {
    if (!this.known) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.known), 'utf8');
    await fs.rename(tmp, this.file);
  }

  /** A file id for each of these files, uploading the ones that are new or have changed since they were last sent. */
  ensure(files: PlanJob['files'], signal?: AbortSignal): Promise<Mount[]> {
    return inTurn(this.file, () => this.send(files, signal));
  }

  private async send(files: PlanJob['files'], signal?: AbortSignal): Promise<Mount[]> {
    const known = await this.load();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const mounts: Mount[] = [];
    const queue = [...files];
    const work = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const had = known[file.path];
        if (had && had.size === file.size && had.modifiedAt === file.modifiedAt && had.expiresAt > soon) {
          mounts.push({ path: file.path, fileId: had.fileId });
          continue;
        }
        const uploaded = await this.client.beta.files.upload(
          { file: await toFile(createReadStream(file.absolutePath), path.basename(file.path)), expires_in_seconds: UPLOAD_TTL_SECONDS },
          { signal },
        );
        known[file.path] = {
          size: file.size,
          modifiedAt: file.modifiedAt,
          fileId: uploaded.id,
          expiresAt: uploaded.expires_at ?? new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
        };
        mounts.push({ path: file.path, fileId: uploaded.id });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, files.length) }, work));
    } finally {
      // Entries for files that are no longer in the workspace are of no further use.
      const current = new Set(files.map((f) => f.path));
      for (const key of Object.keys(known)) if (!current.has(key) && known[key]!.expiresAt <= soon) delete known[key];
      await this.save();
    }
    return mounts.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The ids on file were refused. Send everything again next time. */
  forget(): Promise<void> {
    return inTurn(this.file, async () => {
      this.known = {};
      await this.save();
    });
  }
}

export interface SessionFile {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

/** The files a session has produced so far. `inputs` are the session's own copies of the files mounted into it, which the same listing can return. */
export async function listOutputs(client: Anthropic, sessionId: string, inputs: ReadonlySet<string>): Promise<SessionFile[]> {
  const files: SessionFile[] = [];
  for await (const file of client.beta.files.list({ scope_id: sessionId, betas: [MANAGED_AGENTS_BETA] })) {
    if (inputs.has(file.id) || file.downloadable === false) continue;
    files.push({ id: file.id, name: file.filename, size: file.size_bytes, createdAt: file.created_at });
  }
  return files;
}

export async function download(client: Anthropic, fileId: string): Promise<Uint8Array> {
  const response = await client.beta.files.download(fileId);
  return new Uint8Array(await response.arrayBuffer());
}
