import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceFile } from '../shared/types';
import type { AgentTool } from './providers/types';

const MAX_WRITE_BYTES = 1_000_000;
/** Files brought home from a hosted session can be built artefacts, so they may be larger than what an agent writes here. */
const MAX_OUTPUT_BYTES = 25_000_000;
const MAX_READ_CHARS = 120_000;
/** A ceiling on how many files a listing walks, so a runaway workspace cannot stall the server. */
const MAX_LISTED = 5000;
/** How many files the listing tool shows an agent at once. */
const MAX_SHOWN = 400;

export class WorkspaceError extends Error {}

/**
 * The shared folder an organisation's agents work in. Every path an agent
 * supplies is untrusted and is confined to the root: no absolute paths, no
 * `..`, and no escaping through a symlink.
 */
export class Workspace {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Normalise a workspace-relative path, or throw if it would leave the workspace. */
  normalise(input: string): string {
    if (typeof input !== 'string' || !input.trim()) throw new WorkspaceError('path is empty');
    if (input.includes('\0')) throw new WorkspaceError('path contains a null byte');
    // A leading slash is read as "from the workspace root", which is what agents mean by it.
    const cleaned = input.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
    const target = path.resolve(this.root, cleaned);
    const rel = path.relative(this.root, target);
    if (!rel || rel === '.') throw new WorkspaceError('path must name a file inside the workspace');
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new WorkspaceError('path escapes the workspace');
    }
    return rel.split(path.sep).join('/');
  }

  /** Absolute path for a workspace-relative one, after checking that no symlink leads outside. */
  private async resolveSafe(rel: string): Promise<string> {
    const target = path.join(this.root, rel);
    const realRoot = await fs.realpath(this.root);
    // A link whose destination does not exist yet has no real path to check, and writing
    // to it would create that destination. Nothing in a workspace needs to be a link.
    const link = await fs.lstat(target).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
    if (link) throw new WorkspaceError('path is a symbolic link');
    // Walk up to the deepest ancestor that exists and make sure it really lives inside the root.
    let probe = target;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const relReal = path.relative(realRoot, real);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new WorkspaceError('path escapes the workspace');
        return target;
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const parent = path.dirname(probe);
        if (parent === probe) throw new WorkspaceError('path escapes the workspace');
        probe = parent;
      }
    }
  }

  async write(input: string, content: string): Promise<{ path: string; bytes: number }> {
    const rel = this.normalise(input);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) throw new WorkspaceError(`file is ${bytes} bytes; the limit is ${MAX_WRITE_BYTES}`);
    const target = await this.resolveSafe(rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { path: rel, bytes };
  }

  /** Write a file as bytes: for work products brought home from a hosted session, which need not be text. */
  async writeBytes(input: string, bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    const rel = this.normalise(input);
    if (bytes.length > MAX_OUTPUT_BYTES) throw new WorkspaceError(`file is ${bytes.length} bytes; the limit is ${MAX_OUTPUT_BYTES}`);
    const target = await this.resolveSafe(rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    return { path: rel, bytes: bytes.length };
  }

  async read(input: string): Promise<{ path: string; content: string; truncated: boolean }> {
    const rel = this.normalise(input);
    const target = await this.resolveSafe(rel);
    let content: string;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new WorkspaceError(`no such file: ${rel}`);
      if (code === 'EISDIR') throw new WorkspaceError(`${rel} is a directory`);
      throw err;
    }
    const truncated = content.length > MAX_READ_CHARS;
    return { path: rel, content: truncated ? content.slice(0, MAX_READ_CHARS) : content, truncated };
  }

  /** Every file under `dir` (default: the whole workspace), oldest path first. */
  async list(dir = ''): Promise<WorkspaceFile[]> {
    const start = dir.trim().replace(/^\.?\/*$/, '') ? await this.resolveSafe(this.normalise(dir)) : this.root;
    const out: WorkspaceFile[] = [];
    const walk = async (abs: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return;
        throw err;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= MAX_LISTED) return;
        const child = path.join(abs, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) {
          const stat = await fs.stat(child);
          out.push({
            path: path.relative(this.root, child).split(path.sep).join('/'),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };
    await walk(start);
    return out;
  }
}

const PathInput = z.object({
  path: z.string().describe('Path relative to the workspace root, e.g. "engineering/spec.md"'),
});
const WriteInput = z.object({
  path: z.string().describe('Path relative to the workspace root, e.g. "engineering/spec.md"'),
  content: z.string().describe('The complete contents of the file'),
});
const ListInput = z.object({
  directory: z.string().describe('Directory to list, relative to the workspace root. Use "" for the whole workspace.'),
});

/**
 * The tools an agent gets for the shared workspace. `onWrite` is told each
 * path the agent writes so the task can record its work products.
 */
export function workspaceTools(workspace: Workspace, onWrite: (path: string) => void): AgentTool[] {
  return [
    {
      name: 'list_files',
      description:
        'List the files in the shared workspace with their sizes. Call this first to see what your own team and other teams have already produced, and again whenever you need to find a file you were told to build on.',
      schema: ListInput,
      async run(input) {
        const { directory } = ListInput.parse(input);
        const files = await workspace.list(directory);
        if (!files.length) return directory ? `No files under ${directory}.` : 'The workspace is empty.';
        if (files.length <= MAX_SHOWN) return files.map((f) => `${f.path} (${f.size} bytes)`).join('\n');
        // Too many to show: the most recently written ones, and a pointer to narrowing the listing.
        const recent = [...files]
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
          .slice(0, MAX_SHOWN)
          .sort((a, b) => a.path.localeCompare(b.path));
        return `${recent.map((f) => `${f.path} (${f.size} bytes)`).join('\n')}\n\n[${files.length - MAX_SHOWN} older files not shown. List a directory to see all of its files.]`;
      },
    },
    {
      name: 'read_file',
      description:
        'Read a text file from the shared workspace. Call this before building on, reviewing or changing any existing file; never rely on a file you have not read.',
      schema: PathInput,
      async run(input) {
        const { path: p } = PathInput.parse(input);
        const file = await workspace.read(p);
        return file.truncated ? `${file.content}\n\n[file truncated at ${MAX_READ_CHARS} characters]` : file.content;
      },
    },
    {
      name: 'write_file',
      description:
        'Create a file in the shared workspace, or replace one, with the complete contents given. Call this for every work product of your task: documents, source code, data. To change an existing file, read it first and write the whole new version.',
      schema: WriteInput,
      async run(input) {
        const { path: p, content } = WriteInput.parse(input);
        const written = await workspace.write(p, content);
        onWrite(written.path);
        return `Wrote ${written.path} (${written.bytes} bytes).`;
      },
    },
  ];
}
