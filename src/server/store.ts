import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BusinessAudit } from '../shared/business';
import type { ActivityEntry, Organisation } from '../shared/types';

/**
 * Organisations on disk, one directory each:
 *   org.json        the live state
 *   activity.jsonl  one line per model call
 *   archive/        plans, decisions and reports of cycles that have left live state
 *   workspace/      the files the agents produce
 */
export class Store {
  constructor(readonly dataDir: string) {}

  private orgsDir(): string {
    return path.join(this.dataDir, 'orgs');
  }

  orgDir(id: string): string {
    return path.join(this.orgsDir(), id);
  }

  workspaceRoot(id: string): string {
    return path.join(this.orgDir(id), 'workspace');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.orgsDir(), { recursive: true });
  }

  async loadAll(): Promise<Organisation[]> {
    return (await this.scan()).orgs;
  }

  /**
   * Every organisation on disk as it was saved, and the folders that should hold one but whose file cannot be
   * read at all. What is read is not yet checked: whoever loads it decides whether it is an organisation.
   */
  async scan(): Promise<{ orgs: Organisation[]; unreadable: Array<{ folder: string; reason: string }> }> {
    const entries = await fs.readdir(this.orgsDir(), { withFileTypes: true });
    const orgs: Organisation[] = [];
    const unreadable: Array<{ folder: string; reason: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let text: string;
      try {
        text = await fs.readFile(path.join(this.orgsDir(), entry.name, 'org.json'), 'utf8');
      } catch (err) {
        // A folder with no organisation in it is not a damaged organisation.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push({ folder: entry.name, reason: `its saved state cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).` });
        continue;
      }
      let org: Organisation;
      try {
        org = JSON.parse(text) as Organisation;
      } catch {
        unreadable.push({ folder: entry.name, reason: 'its saved state is not valid JSON: the file is damaged or was cut short.' });
        continue;
      }
      // A copy of an organisation's folder (a backup, say) holds the original's id. Loading it
      // would have the copy's stale state saved over the original, so it is left alone.
      if (org && typeof org === 'object' && typeof org.id === 'string' && org.id !== entry.name) {
        console.warn(`Skipping ${entry.name}: it holds organisation ${org.id}, which belongs in a folder of that name.`);
        continue;
      }
      // Without an id of its own it is still this folder's, and it is for the loader to say what is wrong with it.
      orgs.push(org && typeof org === 'object' && !Array.isArray(org) ? org : ({ id: entry.name, damaged: true } as unknown as Organisation));
    }
    return { orgs, unreadable };
  }

  /** Write the state to a temporary file and rename it into place, so a crash never leaves half a file. */
  async save(org: Organisation): Promise<void> {
    const dir = this.orgDir(org.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `org.json.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(org), 'utf8');
    await fs.rename(tmp, path.join(dir, 'org.json'));
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.orgDir(id), { recursive: true, force: true });
  }

  async appendActivity(id: string, entry: ActivityEntry): Promise<void> {
    await fs.appendFile(path.join(this.orgDir(id), 'activity.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  }

  /** Add entries to the file that holds the older edit history of an organisation's business records, one line each. */
  async appendAudit(id: string, entries: BusinessAudit[]): Promise<void> {
    if (!entries.length) return;
    await fs.appendFile(path.join(this.orgDir(id), 'business-audit.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  }

  /** The older edit history of an organisation's business records, oldest first. What is still in live state is not in here. */
  async readAudit(id: string): Promise<BusinessAudit[]> {
    return this.lines<BusinessAudit>(path.join(this.orgDir(id), 'business-audit.jsonl'));
  }

  /**
   * The entries in an organisation's activity log, oldest first: all of them, or with `limit` the most recent
   * that many. A line that cannot be read is skipped.
   */
  async readActivity(id: string, limit?: number): Promise<ActivityEntry[]> {
    return this.lines<ActivityEntry>(path.join(this.orgDir(id), 'activity.jsonl'), limit);
  }

  /** The records in a file of one JSON record per line, or the last `limit` of them. No file is no records. */
  private async lines<T>(file: string, limit?: number): Promise<T[]> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let lines = text.split('\n');
    // Only the lines that will be kept are parsed: a long log is mostly lines nobody asked for.
    if (limit !== undefined && lines.length > limit + 1) lines = lines.slice(-(limit + 1));
    const entries: T[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // A line cut short by a crash mid-write.
      }
    }
    return limit !== undefined && entries.length > limit ? entries.slice(-limit) : entries;
  }

  /**
   * Write a cycle to the archive before returning, and throw if it could not be written. The caller removes the
   * cycle from live state on the strength of this, in the same breath, so it must know for certain that it is there.
   */
  archiveCycleNow(id: string, cycle: number, data: unknown): void {
    const dir = path.join(this.orgDir(id), 'archive');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `cycle-${cycle}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  /** The cycles of an organisation that are in its archive, by number. */
  async archivedCycles(id: string): Promise<number[]> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.orgDir(id), 'archive'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names.map((name) => /^cycle-(\d+)\.json$/.exec(name)?.[1]).filter((number): number is string => number !== undefined).map(Number);
  }

  /** One archived cycle, as it was written. */
  async archivedCycle(id: string, cycle: number): Promise<unknown> {
    return JSON.parse(await fs.readFile(path.join(this.orgDir(id), 'archive', `cycle-${cycle}.json`), 'utf8'));
  }

  async archiveCycle(id: string, cycle: number, data: unknown): Promise<void> {
    const dir = path.join(this.orgDir(id), 'archive');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `cycle-${cycle}.json`), JSON.stringify(data, null, 2), 'utf8');
  }
}
