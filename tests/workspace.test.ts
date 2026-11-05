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
  });

  it('have descriptions and schemas the model can use', () => {
    for (const tool of workspaceTools(workspace, () => {})) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.schema.safeParse({}).success).toBe(false);
    }
  });
});
