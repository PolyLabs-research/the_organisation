import { promises as fs } from 'node:fs';
import path from 'node:path';
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
    const entries = await fs.readdir(this.orgsDir(), { withFileTypes: true });
    const orgs: Organisation[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const org = JSON.parse(await fs.readFile(path.join(this.orgsDir(), entry.name, 'org.json'), 'utf8')) as Organisation;
        // A copy of an organisation's folder (a backup, say) holds the original's id. Loading it
        // would have the copy's stale state saved over the original, so it is left alone.
        if (org.id !== entry.name) {
          console.warn(`Skipping ${entry.name}: it holds organisation ${org.id}, which belongs in a folder of that name.`);
          continue;
        }
        orgs.push(org);
      } catch (err) {
        console.warn(`Skipping ${entry.name}: ${(err as Error).message}`);
      }
    }
    return orgs;
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

  async archiveCycle(id: string, cycle: number, data: unknown): Promise<void> {
    const dir = path.join(this.orgDir(id), 'archive');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `cycle-${cycle}.json`), JSON.stringify(data, null, 2), 'utf8');
  }
}
