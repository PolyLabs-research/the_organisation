import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, WorkspaceError, workspaceTools } from '../src/server/workspace';

let dir: string;
let workspace: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-ws-'));
  workspace = new Workspace(path.join(dir, 'workspace'));
  await workspace.init();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('the workspace', () => {
  it('writes, reads and lists files', async () => {
    await workspace.write('engineering/spec.md', '# Spec');
    await workspace.write('marketing/brief.md', '# Brief');
    expect((await workspace.read('engineering/spec.md')).content).toBe('# Spec');
    expect((await workspace.list()).map((f) => f.path)).toEqual(['engineering/spec.md', 'marketing/brief.md']);
    expect((await workspace.list('engineering')).map((f) => f.path)).toEqual(['engineering/spec.md']);
    expect(await workspace.list('nowhere')).toEqual([]);
  });

  it('reads a leading slash as the workspace root, not the machine root', async () => {
    const written = await workspace.write('/engineering/spec.md', 'x');
    expect(written.path).toBe('engineering/spec.md');
    await expect(workspace.read('/etc/passwd')).rejects.toThrow('no such file: etc/passwd');
  });

  it.each(['../secret.txt', 'a/../../secret.txt', '..', 'a/b/../../../x', '', '   ', '.', 'bad\0name'])('refuses the path %j', async (bad) => {
    await expect(workspace.write(bad, 'x')).rejects.toBeInstanceOf(WorkspaceError);
    await expect(workspace.read(bad)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('refuses a path that climbs out of the workspace before it looks at the disk at all', () => {
    // Two checks keep a path inside: this one, on the path as written, and one on where it really leads. Each
    // has to hold by itself, since some callers use a path this has passed without going on to the second.
    for (const outside of ['../outside.txt', '..', 'a/../../outside.txt', 'legal/../../../etc/passwd', '..\\outside.txt', './../outside.txt']) {
      expect(() => workspace.normalise(outside), outside).toThrow('path escapes the workspace');
    }
    expect(() => workspace.normalise('')).toThrow('path is empty');
    expect(() => workspace.normalise('.')).toThrow('must name a file');
    expect(() => workspace.normalise('a\0b')).toThrow('null byte');
    expect(workspace.normalise('legal/../engineering/spec.md')).toBe('engineering/spec.md');
    expect(workspace.normalise('..notes/plan.md')).toBe('..notes/plan.md');
  });

  it('takes a folder whose name only begins with two dots for what it is: a folder inside', async () => {
    expect(await workspace.write('..notes/plan.md', 'A plan.')).toEqual({ path: '..notes/plan.md', bytes: 7 });
    expect((await workspace.read('..notes/plan.md')).content).toBe('A plan.');
    expect((await workspace.list('..notes')).map((f) => f.path)).toEqual(['..notes/plan.md']);
  });

  it('refuses to follow a symlink out of the workspace', async () => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(workspace.root, 'link'));
    await expect(workspace.read('link/secret.txt')).rejects.toThrow('escapes');
    await expect(workspace.write('link/new.txt', 'x')).rejects.toThrow('escapes');
  });

  it('refuses to write through a link, even one that points at nothing yet', async () => {
    await symlink(path.join(dir, 'not-there-yet.txt'), path.join(workspace.root, 'dangling'));
    await expect(workspace.write('dangling', 'x')).rejects.toThrow('symbolic link');
    await symlink(path.join(workspace.root, 'real.md'), path.join(workspace.root, 'inside-link'));
    await expect(workspace.write('inside-link', 'x')).rejects.toThrow('symbolic link');
  });

  it('refuses files over the size limit', async () => {
    await expect(workspace.write('big.txt', 'x'.repeat(1_000_001))).rejects.toThrow('limit');
  });

  it('edits one exact passage of a file and leaves the rest as it was', async () => {
    await workspace.write('legal/terms.md', '# Terms\n\nClause one.\n\nClause two.\n');
    expect(await workspace.edit('legal/terms.md', 'Clause two.', 'Clause 2, revised.')).toEqual({ path: 'legal/terms.md', bytes: 41 });
    expect((await workspace.read('legal/terms.md')).content).toBe('# Terms\n\nClause one.\n\nClause 2, revised.\n');
  });

  it('refuses an edit that names no passage, or more than one', async () => {
    await workspace.write('a.md', 'same\nsame\n');
    await expect(workspace.edit('a.md', 'other', 'x')).rejects.toThrow('not in a.md');
    await expect(workspace.edit('a.md', 'same', 'x')).rejects.toThrow('more than once');
    await expect(workspace.edit('a.md', '', 'x')).rejects.toThrow('empty');
    await expect(workspace.edit('missing.md', 'same', 'x')).rejects.toThrow('no such file');
    expect((await workspace.read('a.md')).content).toBe('same\nsame\n');
  });

  it('moves the time on a file on with every write, so that one written twice in a moment at the same size is seen to have changed', async () => {
    // What keeps a copy of the workspace knows a file has changed by its size and when it was written. Written again within the
    // same millisecond, at the same size, it would look like the file they already have.
    const seen = new Set<string>();
    const times: number[] = [];
    const look = async () => {
      const [file] = await workspace.list();
      seen.add(`${file!.size}:${file!.modifiedAt}`);
      times.push(new Date(file!.modifiedAt).getTime());
    };
    for (let round = 0; round < 150; round++) {
      await workspace.write('ops/ledger.md', `round ${round % 10} ${'x'.repeat(200)}`);
      await look();
    }
    for (let round = 0; round < 100; round++) {
      await workspace.writeBytes('ops/ledger.md', Buffer.from(`round ${round % 10} ${'y'.repeat(200)}`));
      await look();
    }
    await workspace.edit('ops/ledger.md', 'round 9', 'round 0');
    await look();
    expect(seen.size).toBe(251);
    // Always later than it was, and never far from the time it really is.
    expect(times.every((time, i) => i === 0 || time > times[i - 1]!)).toBe(true);
    expect(Math.abs(times.at(-1)! - Date.now())).toBeLessThan(5000);
    // A file that grows or shrinks is told apart by its size, and its time is left as the clock gave it.
    await workspace.write('ops/other.md', 'one');
    await workspace.write('ops/other.md', 'three');
    expect((await workspace.read('ops/other.md')).content).toBe('three');
  });

  it('edits the end of a file too long to read in one go, without losing any of it', async () => {
    const long = 'x'.repeat(130_000) + 'THE END';
    await workspace.write('long.md', long);
    expect((await workspace.read('long.md')).truncated).toBe(true);
    await workspace.edit('long.md', 'THE END', 'FIN');
    const whole = await workspace.readWhole('long.md', 1_000_000);
    expect(whole).toBe('x'.repeat(130_000) + 'FIN');
  });
});

describe('the agent tools', () => {
  it('report each file an agent writes', async () => {
    const written: string[] = [];
    const tools = workspaceTools(workspace, (p) => written.push(p));
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    expect(await tool('list_files').run({ directory: '' })).toBe('The workspace is empty.');
    expect(await tool('write_file').run({ path: 'product/prd.md', content: 'hello' })).toBe('Wrote product/prd.md (5 bytes).');
    expect(written).toEqual(['product/prd.md']);
    expect(await tool('read_file').run({ path: 'product/prd.md' })).toBe('hello');
    expect(await tool('list_files').run({ directory: '' })).toBe('product/prd.md (5 bytes)');
    await expect(tool('write_file').run({ path: '../x', content: 'x' })).rejects.toThrow('escapes');
    await expect(tool('read_file').run({ path: 'missing.md' })).rejects.toThrow('no such file');
    expect(await tool('edit_file').run({ path: 'product/prd.md', find: 'hello', replace: 'hello, world' })).toBe('Edited product/prd.md (now 12 bytes).');
    expect(await tool('read_file').run({ path: 'product/prd.md' })).toBe('hello, world');
  });

  it('have descriptions and schemas the model can use', () => {
    for (const tool of workspaceTools(workspace, () => {})) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.schema.safeParse({}).success).toBe(false);
    }
  });
});
