import { describe, expect, it } from 'vitest';
import { ZOOM, fit, fitText, inView, keepInView, plot, roomOf, route, survey, textWidth, wrapText, zoomAt, type Boardroom, type Department, type Office, type Rect, type Scene } from '../src/client/headquarters';
import { createOrganisation } from '../src/server/engine/state';
import type { BusinessJob } from '../src/shared/business';
import type { ActiveWork, Decision, Organisation, OrgView, SignatoryRequest, Task, WorkKind } from '../src/shared/types';
import { organisation, plan } from './client-helpers';

// The headquarters is drawn from what this works out: where each room stands, what is going on in it, what is on its
// way between rooms and what needs a person. None of it draws anything, so all of it is tested here without a browser.

const AT = '2026-11-08T12:00:00.000Z';
const LEADS = ['engineering', 'product', 'marketing', 'finance', 'operations', 'sales', 'legal', 'data'];

function team(leads: number, judge = false): Organisation {
  return createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: LEADS.slice(0, leads).map((profileId) => ({ profileId })), settings: { arbiter: judge ? 'judge' : 'ceo' } }, 'org_1');
}

const view = (org: Organisation, active: ActiveWork[] = [], rest: Partial<OrgView> = {}): OrgView => ({ org, active, draining: false, pace: { next: [], nextAt: null }, ...rest });
const work = (kind: WorkKind, execId: string, fields: Partial<ActiveWork> = {}): ActiveWork => ({ key: `${kind}:${execId}:${fields.agent ?? ''}`, kind, execId, agent: null, label: `Doing ${kind}`, planId: null, startedAt: AT, ...fields });
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, brief: 'Do it.', status: 'pending', agent: null, rework: false, result: null, files: [], error: null, attempts: 0, startedAt: null, finishedAt: null, effort: null, ...fields });
const running = (): Organisation => {
  const org = organisation();
  org.status = 'running';
  return org;
};
const room = <T extends Department | Boardroom | Office>(scene: Scene, id: string): T => scene.rooms.find((r) => r.id === id) as T;
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('where the rooms of the headquarters stand', () => {
  it('gives every seat a room inside the building, with no room on another, for any team there can be', () => {
    for (let leads = 1; leads <= 8; leads++) {
      for (const judge of [false, true]) {
        const org = team(leads, judge);
        const at = plot(org);
        const ids = Object.keys(at.rooms);
        expect(ids).toEqual(expect.arrayContaining(['shareholders', 'ceo', 'board', 'signatory', 'archive', 'files', 'operations', ...org.executives.filter((e) => e.kind === 'lead').map((e) => `dept:${e.id}`)]));
        expect(ids.includes('judge')).toBe(judge);
        for (const id of ids) {
          const { rect } = at.rooms[id]!;
          expect(rect.x, id).toBeGreaterThan(0);
          expect(rect.y, id).toBeGreaterThan(0);
          expect(rect.x + rect.w, id).toBeLessThan(at.size.w);
          expect(rect.y + rect.h, id).toBeLessThan(at.size.h);
          for (const other of ids) if (other !== id) expect(overlap(rect, at.rooms[other]!.rect), `${id} on ${other} with ${leads} leads`).toBe(false);
        }
      }
    }
  });

  it('puts a door in each room’s own wall, on a corridor', () => {
    const at = plot(team(6, true));
    for (const [id, place] of Object.entries(at.rooms)) {
      const { rect, door } = place;
      if (place.doorIn === 'bottom') expect(door, id).toEqual({ x: rect.x + rect.w / 2, y: rect.y + rect.h });
      else if (place.doorIn === 'top') expect(door, id).toEqual({ x: rect.x + rect.w / 2, y: rect.y });
      else expect(door, id).toEqual({ x: rect.x, y: rect.y + rect.h / 2 });
      expect(at.halls[place.hall], id).toBeDefined();
    }
    // The executive floor opens on the corridor beneath it, and so does the first row of departments, from the other side.
    expect(at.rooms.ceo!.doorIn).toBe('bottom');
    expect(at.rooms.ceo!.door.y).toBe(at.halls[0]!.y);
    expect(at.rooms['dept:cto']!.door.y).toBe(at.halls[0]!.y + at.halls[0]!.h);
  });

  it('keeps up to four departments in one row and puts more in two', () => {
    const rowsOf = (leads: number) => new Set(Object.entries(plot(team(leads)).rooms).filter(([id]) => id.startsWith('dept:')).map(([, p]) => p.rect.y)).size;
    expect([1, 2, 3, 4].map(rowsOf)).toEqual([1, 1, 1, 1]);
    expect([5, 6, 7, 8].map(rowsOf)).toEqual([2, 2, 2, 2]);
    // The second row has a corridor of its own, and its doors open on that one.
    const at = plot(team(8));
    expect(at.halls).toHaveLength(2);
    expect(at.rooms['dept:cdo']!.hall).toBe(1);
    expect(at.rooms['dept:cto']!.hall).toBe(0);
  });

  it('stands what serves every department in a column beside them, as tall as they are together', () => {
    for (const leads of [2, 8]) {
      const at = plot(team(leads));
      const depts = Object.entries(at.rooms).filter(([id]) => id.startsWith('dept:')).map(([, p]) => p.rect);
      const top = Math.min(...depts.map((r) => r.y));
      const bottom = Math.max(...depts.map((r) => r.y + r.h));
      const right = Math.max(...depts.map((r) => r.x + r.w));
      expect(at.rooms.archive!.rect.y).toBe(top);
      expect(at.rooms.operations!.rect.y + at.rooms.operations!.rect.h).toBeCloseTo(bottom, 6);
      for (const id of ['archive', 'files', 'operations']) expect(at.rooms[id]!.rect.x).toBeGreaterThan(right);
    }
  });

  it('makes a building that is wider than it is tall, as a screen is, while its departments are in one row', () => {
    for (const leads of [1, 2, 3, 4]) {
      const { size } = plot(team(leads, true));
      expect(size.w / size.h, `${leads} leads`).toBeGreaterThan(1.8);
    }
  });

  it('gives a few departments the width the floor above has, and many the least a department can have', () => {
    const width = (leads: number) => plot(team(leads)).rooms['dept:cto']!.rect.w;
    expect(width(1)).toBe(330);
    expect(width(2)).toBe(330);
    expect(width(4)).toBe(240);
    expect(width(3)).toBeGreaterThan(width(4));
  });
});

describe('the way from one room to another', () => {
  const at = plot(team(8));

  it('runs along the corridor both doors open on', () => {
    const points = route(at, 'dept:cto', 'board');
    const hall = at.halls[0]!;
    expect(points[0]).toEqual(at.rooms['dept:cto']!.door);
    expect(points.at(-1)).toEqual(at.rooms.board!.door);
    expect(points).toHaveLength(4);
    for (const p of points.slice(1, -1)) {
      expect(p.y).toBeGreaterThan(hall.y);
      expect(p.y).toBeLessThan(hall.y + hall.h);
    }
    // It turns only at right angles.
    for (let i = 1; i < points.length; i++) expect(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y).toBe(true);
  });

  it('goes round the outside of the rooms between two corridors, by the nearer side', () => {
    const rects = Object.values(at.rooms).map((p) => p.rect);
    const leftmost = Math.min(...rects.map((r) => r.x));
    const rightmost = Math.max(...rects.map((r) => r.x + r.w));
    // The first department of the second row is on the left, and so is the signing desk.
    const first = Object.entries(at.rooms).filter(([id, p]) => id.startsWith('dept:') && p.hall === 1).sort((a, b) => a[1].rect.x - b[1].rect.x)[0]![0];
    const byLeft = route(at, first, 'signatory');
    expect(byLeft).toHaveLength(6);
    expect(byLeft[2]!.x).toBeLessThan(leftmost);
    expect(byLeft[2]!.x).toBeGreaterThan(0);
    const last = Object.entries(at.rooms).filter(([id, p]) => id.startsWith('dept:') && p.hall === 1).sort((a, b) => b[1].rect.x - a[1].rect.x)[0]![0];
    const byRight = route(at, last, 'board');
    expect(byRight[2]!.x).toBeGreaterThan(rightmost);
    expect(byRight[2]!.x).toBeLessThan(at.size.w);
    for (const points of [byLeft, byRight]) for (let i = 1; i < points.length; i++) expect(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y).toBe(true);
  });

  it('keeps flows that share a corridor apart, and has nothing to say of a room that is not there', () => {
    const a = route(at, 'dept:cto', 'board', -2);
    const b = route(at, 'dept:cto', 'board', 2);
    expect(b[1]!.y - a[1]!.y).toBe(20);
    expect(route(at, 'dept:cto', 'nowhere')).toEqual([]);
  });
});

describe('looking at the map', () => {
  const building = { x: 0, y: 0, w: 1200, h: 600 };

  it('shows the whole of a thing, centred in what the view has clear', () => {
    const cam = fit(building, { w: 1000, h: 560 }, { top: 60, right: 20, bottom: 20, left: 20 });
    expect(cam.k).toBeCloseTo(0.8, 6);
    // Its left and right edges are the same distance from the clear part's edges, and so are its top and bottom.
    expect(cam.x).toBeCloseTo(20, 6);
    expect(cam.y - 60).toBeCloseTo(560 - 20 - (cam.y + 600 * cam.k), 6);
  });

  it('shows all of a thing that is taller than the view is, as of one that is wider', () => {
    const cam = fit({ x: 0, y: 0, w: 600, h: 1200 }, { w: 1000, h: 600 });
    expect(cam.k).toBe(0.5);
    expect(cam.y).toBe(0);
    expect(cam.x).toBe(350);
  });

  it('goes no closer than it is told, and no closer or further than the map allows', () => {
    expect(fit({ x: 100, y: 100, w: 50, h: 50 }, { w: 1000, h: 600 }).k).toBe(1.25);
    expect(fit({ x: 100, y: 100, w: 50, h: 50 }, { w: 1000, h: 600 }, undefined, 9).k).toBe(ZOOM.max);
    expect(fit({ x: 0, y: 0, w: 90_000, h: 90_000 }, { w: 1000, h: 600 }).k).toBe(ZOOM.min);
    // A small thing is put in the middle.
    const cam = fit({ x: 100, y: 100, w: 50, h: 50 }, { w: 1000, h: 600 }, undefined, 2);
    expect(125 * cam.k + cam.x).toBe(500);
    expect(125 * cam.k + cam.y).toBe(300);
  });

  it('comes nearer and goes further about the point it is asked to keep still', () => {
    const cam = { k: 1, x: 40, y: 10 };
    const at = { x: 300, y: 200 };
    const nearer = zoomAt(cam, 2, at);
    expect(nearer.k).toBe(2);
    // The same point of the world is under the pointer before and after.
    expect((at.x - nearer.x) / nearer.k).toBe((at.x - cam.x) / cam.k);
    expect((at.y - nearer.y) / nearer.k).toBe((at.y - cam.y) / cam.k);
    expect(zoomAt(cam, 100, at).k).toBe(ZOOM.max);
    expect(zoomAt(cam, 0.001, at).k).toBe(ZOOM.min);
  });

  it('cannot be dragged so far that the building is lost', () => {
    const size = { w: 1200, h: 600 };
    const viewport = { w: 1000, h: 500 };
    for (const lost of [{ k: 1, x: 5000, y: 0 }, { k: 1, x: -5000, y: 0 }, { k: 1, x: 0, y: 5000 }, { k: 1, x: 0, y: -5000 }, { k: 0.4, x: -9000, y: 9000 }]) {
      const cam = keepInView(lost, size, viewport);
      const seen = inView(cam, viewport);
      const across = Math.min(seen.x + seen.w, size.w) - Math.max(seen.x, 0);
      const down = Math.min(seen.y + seen.h, size.h) - Math.max(seen.y, 0);
      expect(across * cam.k, JSON.stringify(lost)).toBeGreaterThanOrEqual(Math.min(viewport.w, size.w * cam.k) * 0.3 - 1e-6);
      expect(down * cam.k, JSON.stringify(lost)).toBeGreaterThanOrEqual(Math.min(viewport.h, size.h * cam.k) * 0.3 - 1e-6);
    }
    // One that shows the building is left where it is.
    expect(keepInView({ k: 1, x: -100, y: -50 }, size, viewport)).toEqual({ k: 1, x: -100, y: -50 });
  });

  it('says what part of the world a camera shows', () => {
    expect(inView({ k: 2, x: -200, y: -100 }, { w: 1000, h: 500 })).toEqual({ x: 100, y: 50, w: 500, h: 250 });
  });
});

describe('words cut to the room they have', () => {
  it('leaves alone what fits, and cuts what does not at its end', () => {
    expect(fitText('Spec', 200, 12)).toBe('Spec');
    const cut = fitText('Take engineering through Spec → Build → Test → Release', 150, 12);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(40);
    expect(textWidth(cut, 12)).toBeLessThanOrEqual(150);
    expect('Take engineering through Spec → Build → Test → Release'.startsWith(cut.slice(0, -1))).toBe(true);
    // No room for two letters and the mark: nothing, and not a mark by itself.
    expect(fitText('Engineering', 12, 12)).toBe('');
  });

  it('never ends a cut with a space before the mark, and reads runs of space as one', () => {
    expect(fitText('one   two\nthree', 500, 12)).toBe('one two three');
    for (let width = 20; width < 140; width += 7) expect(fitText('ab cd ef gh ij kl mn op', width, 12)).not.toMatch(/\s…$/);
  });

  it('counts wide letters as wide and narrow ones as narrow', () => {
    expect(textWidth('mmmm', 10)).toBeGreaterThan(textWidth('nnnn', 10));
    expect(textWidth('nnnn', 10)).toBeGreaterThan(textWidth('iiii', 10));
    expect(textWidth('→→', 10)).toBeGreaterThan(textWidth('nn', 10) * 1.5);
    expect(textWidth('Spec', 10, true)).toBeGreaterThan(textWidth('Spec', 10));
    expect(textWidth('Spec', 20)).toBe(textWidth('Spec', 10) * 2);
  });

  it('breaks at spaces into no more lines than it may have, every one of which fits', () => {
    const text = 'Research: a review against the success criteria of the plan';
    for (const lines of [1, 2, 3, 5]) {
      const out = wrapText(text, 90, 11, lines);
      expect(out.length).toBeLessThanOrEqual(lines);
      for (const line of out) expect(textWidth(line, 11)).toBeLessThanOrEqual(90);
    }
    // With room for all of it, all of it is there and nothing is cut.
    expect(wrapText(text, 90, 11, 9).join(' ')).toBe(text);
    // With less, the last line says that there is more.
    expect(wrapText(text, 90, 11, 2).at(-1)!.endsWith('…')).toBe(true);
    // A line takes as many whole words as fit, and the next word begins the next line.
    expect(wrapText(text, 90, 11, 2)[0]).toBe('Research: a');
    expect(textWidth('Research: a review', 11)).toBeGreaterThan(90);
    expect(wrapText(text, 90, 11, 3)[1]).toBe('review against');
    expect(wrapText('', 90, 11, 2)).toEqual([]);
    // A word longer than a line is cut and not left to run out of the room.
    const long = wrapText('Supercalifragilisticexpialidocious', 60, 11, 2);
    expect(long).toHaveLength(1);
    expect(textWidth(long[0]!, 11)).toBeLessThanOrEqual(60);
  });
});

describe('what is going on in the headquarters', () => {
  it('finds nothing going on in an organisation that has not been started, and says how to start it', () => {
    const scene = survey(view(organisation()));
    expect(scene.rooms.map((r) => r.lamp)).toEqual(scene.rooms.map(() => 'idle'));
    expect(scene.rooms.map((r) => r.id)).toEqual(['shareholders', 'ceo', 'board', 'signatory', 'dept:cto', 'dept:cmo', 'archive', 'files', 'operations']);
    expect(scene.alerts).toEqual([{ severity: 'you', title: 'Not started', detail: 'Start the organisation and the CEO opens the first cycle.', target: null }]);
    expect(scene.situation).toMatchObject({ state: 'idle', agents: { working: 0, total: 3 }, seats: 0, needsYou: 1, trouble: 0, decisions: 0 });
    expect(scene.flows).toEqual([]);
    expect(room<Office>(scene, 'ceo').line).toBe('Waiting to be started');
    // Each room stands where the plot puts it.
    const at = plot(organisation());
    for (const r of scene.rooms) expect(r.rect).toEqual(at.rooms[r.id]!.rect);
  });

  it('lights the desk of each agent that is at work, with what it is doing', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    p.phases[0]!.status = 'working';
    p.phases[0]!.tasks = [task('t1', { status: 'running', agent: 2, title: 'Write the spec' }), task('t2')];
    const scene = survey(view(org, [work('task', 'cto', { agent: 2, label: 'Write the spec', planId: 'p1' })]));
    const dept = room<Department>(scene, 'dept:cto');
    expect(dept.desks).toEqual([
      { id: 'dept:cto/agent/1', agent: 1, busy: false, label: null, planId: null, taskId: null },
      { id: 'dept:cto/agent/2', agent: 2, busy: true, label: 'Write the spec', planId: 'p1', taskId: 't1' },
    ]);
    expect(dept.lamp).toBe('working');
    expect(dept.line).toBe('Spec · 1 of 2 agents working');
    expect(dept.lead).toEqual([]);
    expect(scene.situation.agents).toEqual({ working: 1, total: 3 });
    expect(scene.situation.state).toBe('running');
    // An agent at work is not one of the executive team at work.
    expect(scene.situation.seats).toBe(0);
    // What the lead and its agents have spent is the department's.
    expect(dept.spendUsd).toBe(0);
    org.usageByExec.cto = { calls: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 1.5 };
    expect(room<Department>(survey(view(org)), 'dept:cto').spendUsd).toBe(1.5);
    expect(room<Department>(survey(view(org)), 'dept:cmo').spendUsd).toBe(0);
    // The other department has nothing to do, and says why.
    expect(room<Department>(scene, 'dept:cmo')).toMatchObject({ lamp: 'idle', line: 'No plan in progress', track: null, profile: ['Research', 'Position', 'Create', 'Launch'] });
  });

  it('says what a lead itself is doing when none of its agents is at work', () => {
    const org = running();
    const scene = survey(view(org, [work('plan', 'cmo', { label: 'Drafting a plan' }), work('review', 'cmo', { label: 'Reviewing other leads’ plans' })]));
    const dept = room<Department>(scene, 'dept:cmo');
    expect(dept.lamp).toBe('working');
    expect(dept.line).toBe('Drafting a plan');
    expect(dept.lead).toEqual(['Drafting a plan', 'Reviewing other leads’ plans']);
    expect(dept.desks.every((d) => !d.busy)).toBe(true);
    // One seat of the executive team has calls in flight, however many calls it has.
    expect(scene.situation.seats).toBe(1);
    expect(scene.situation.agents.working).toBe(0);
  });

  it('says what a department without a plan is waiting for', () => {
    const org = running();
    org.cycle.stage = 'consult';
    expect(room<Department>(survey(view(org)), 'dept:cto').line).toBe('Awaiting the CEO’s direction');
    org.cycle.stage = 'work';
    org.inbox.cto = ['r1', 'r2'];
    expect(room<Department>(survey(view(org)), 'dept:cto')).toMatchObject({ lamp: 'waiting', line: '2 board reports to read', inbox: 2 });
    org.inbox.cto = ['r1'];
    expect(room<Department>(survey(view(org)), 'dept:cto').line).toBe('1 board report to read');
  });

  it('draws a plan as the line of its phases, each with how it stands', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    p.phases[0]!.status = 'done';
    p.phases[0]!.tasks = [task('t1', { status: 'done' })];
    p.phases[1]!.status = 'working';
    p.phases[1]!.tasks = [task('t2', { status: 'done' }), task('t3', { status: 'running', agent: 1 }), task('t4', { status: 'failed' }), task('t5')];
    const track = room<Department>(survey(view(org)), 'dept:cto').track!;
    expect(track).toMatchObject({ id: 'dept:cto/plan/p1', planId: 'p1', objective: 'Open the shop', status: 'executing', label: 'Under way', held: [], session: null });
    expect(track.stations.map((s) => [s.id, s.name, s.status, s.line])).toEqual([
      ['dept:cto/phase/p1/0', 'Spec', 'done', 'Done'],
      ['dept:cto/phase/p1/1', 'Build', 'working', '1 of 4 tasks done'],
      ['dept:cto/phase/p1/2', 'Test', 'pending', 'Not started'],
      ['dept:cto/phase/p1/3', 'Release', 'pending', 'Not started'],
    ]);
    expect(track.stations[1]!.tasks).toEqual({ done: 1, running: 1, failed: 1, total: 4 });
    expect(track.stations.map((s) => s.gate)).toEqual([null, null, null, null]);
  });

  it('says where a phase under way has got to', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    const phase = p.phases[0]!;
    phase.status = 'working';
    const line = (active: ActiveWork[] = []) => room<Department>(survey(view(org, active)), 'dept:cto').track!.stations[0]!.line;
    expect(line()).toBe('Being handed out');
    phase.tasks = [task('t1', { status: 'done' })];
    expect(line()).toBe('At its gate');
    expect(line([work('phase_review', 'cto', { planId: 'p1' })])).toBe('Under review at its gate');
    // A review of another plan's phase is not a review of this one.
    expect(line([work('phase_review', 'cto', { planId: 'p2' })])).toBe('At its gate');
    phase.tasks = [task('t1', { status: 'done' }), task('t2', { status: 'failed' })];
    expect(line()).toBe('At its gate');
    phase.tasks = [task('t1')];
    expect(line()).toBe('0 of 1 task done');
    phase.reworkRounds = 2;
    expect(line()).toBe('0 of 1 task done · rework round 2');
    expect(room<Department>(survey(view(org)), 'dept:cto').track!.stations[0]!.rework).toBe(2);
  });

  it('shows a gate the system checks, and how the check stands', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    const gate = () => room<Department>(survey(view(org)), 'dept:cto').track!.stations.map((s) => s.gate);
    p.phases[1]!.gate = 'checks';
    p.phases[2]!.gate = 'run';
    expect(gate()).toEqual([null, { kind: 'checks', state: 'ahead' }, { kind: 'run', state: 'ahead' }, null]);
    const evidence = (state: 'waiting' | 'passed' | 'failed', kind: 'checks' | 'run') => ({ gate: kind, state, sha: null, summary: 'What the system found.', checks: [], waitedMs: 0, at: AT });
    p.phases[0]!.status = 'done';
    p.phases[1]!.status = 'working';
    p.phases[1]!.tasks = [task('t1', { status: 'done' })];
    p.phases[1]!.evidence = evidence('waiting', 'checks');
    expect(gate()[1]).toEqual({ kind: 'checks', state: 'waiting' });
    const dept = () => room<Department>(survey(view(org)), 'dept:cto');
    expect(dept().track!.stations[1]!.line).toBe('Waiting for the repository’s checks');
    expect(dept().line).toBe('Build · waiting for the repository’s checks');
    p.phases[1]!.evidence = evidence('failed', 'checks');
    expect(dept().track!.stations[1]!.line).toBe('The system’s check did not pass');
    p.phases[1]!.evidence = evidence('passed', 'checks');
    p.phases[1]!.status = 'done';
    expect(gate()[1]).toEqual({ kind: 'checks', state: 'passed' });
    // A phase that is done passed its gate, whether or not what the system found was kept.
    p.phases[1]!.evidence = null;
    expect(gate()[1]).toEqual({ kind: 'checks', state: 'passed' });
    p.phases[2]!.status = 'working';
    p.phases[2]!.tasks = [task('t2', { status: 'done' })];
    p.phases[2]!.evidence = evidence('waiting', 'run');
    expect(dept().track!.stations[2]!.line).toBe('The system is running its check');
  });

  it('says what a plan that is not being carried out is waiting for', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    const dept = () => room<Department>(survey(view(org)), 'dept:cto');
    for (const [status, line] of [['planning', 'Being drafted'], ['drafted', 'Awaiting the board'], ['in_review', 'Before the board'], ['contested', 'Contested: the board is deciding'], ['revising', 'Being revised after a ruling'], ['approved', 'Cleared'], ['reporting', 'Writing the board report']] as const) {
      p.status = status;
      expect(dept(), status).toMatchObject({ lamp: 'waiting', line });
    }
    p.status = 'executing';
    p.phases[0]!.status = 'working';
    p.phases[0]!.tasks = [task('t1', { status: 'done' }), task('t2')];
    expect(dept()).toMatchObject({ lamp: 'waiting', line: 'Spec · 1 of 2 tasks done' });
    p.status = 'done';
    expect(dept()).toMatchObject({ lamp: 'done', line: 'Reported to the board' });
    p.status = 'cancelled';
    expect(dept()).toMatchObject({ lamp: 'idle', line: 'The plan was cancelled' });
    p.status = 'failed';
    expect(dept()).toMatchObject({ lamp: 'idle', line: 'The plan failed' });
  });

  it('shows the plan being carried out before one that is waiting, and counts the rest', () => {
    const org = running();
    plan(org, 'cto', 'p1').status = 'drafted';
    plan(org, 'cto', 'p2');
    plan(org, 'cto', 'p3').status = 'planning';
    const dept = room<Department>(survey(view(org)), 'dept:cto');
    expect(dept.track!.planId).toBe('p2');
    expect(dept.queued).toBe(2);
    // With nothing left to do, how this cycle's last plan ended is shown, and a plan of an earlier cycle is not.
    for (const p of org.plans) p.status = 'done';
    org.plans[2]!.status = 'cancelled';
    expect(room<Department>(survey(view(org)), 'dept:cto')).toMatchObject({ queued: 0, line: 'The plan was cancelled' });
    org.cycle.number = 2;
    expect(room<Department>(survey(view(org)), 'dept:cto')).toMatchObject({ track: null, line: 'No plan in progress' });
  });

  it('reads who is at work in a hosted session from the plan, since no call on this machine says', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    p.execution = 'managed';
    p.managed = { sessionId: 's1', consoleUrl: null, budgetUsd: 5, spentUsd: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 }, state: 'running', runs: [], pendingReport: null, instructionsSent: 0, declined: 0, note: null, files: [], attempts: 0, synced: {}, agents: [], lastDeclined: null, cursor: null };
    p.phases[0]!.status = 'working';
    p.phases[0]!.tasks = [
      task('t1', { status: 'running', agent: 1, threadId: 'th1', title: 'Draft it' }),
      task('t2', { status: 'running', agent: 3, threadId: 'th3', title: 'Third hand' }),
      task('t3', { status: 'running', agent: null, threadId: 'th9', title: 'In a run' }),
      task('t4', { status: 'running', agent: 2, title: 'No thread' }),
    ];
    const dept = () => room<Department>(survey(view(org, [work('execute', 'cto', { label: 'Carrying out the plan with its team in a hosted session', planId: 'p1' })])), 'dept:cto');
    expect(dept().desks).toEqual([
      { id: 'dept:cto/agent/1', agent: 1, busy: true, label: 'Draft it', planId: 'p1', taskId: 't1' },
      { id: 'dept:cto/agent/2', agent: 2, busy: false, label: null, planId: null, taskId: null },
    ]);
    // One agent more than the lead was given, and one in a workflow run.
    expect(dept()).toMatchObject({ beyond: 1, inRuns: 1, lamp: 'working', line: 'Spec · 3 agents working' });
    expect(dept().track!.session).toBe('running');
    expect(survey(view(org)).situation.agents.working).toBe(3);
    // A session that is held has nobody at work in it, and the department says so.
    p.managed.state = 'paused';
    const held = room<Department>(survey(view(org)), 'dept:cto');
    expect(held.desks.every((d) => !d.busy)).toBe(true);
    expect(held).toMatchObject({ beyond: 0, inRuns: 0, lamp: 'waiting', line: 'Session held' });
  });

  it('marks nothing as waiting in an organisation that is paused, and moves nothing', () => {
    const org = running();
    plan(org, 'cto', 'p1').status = 'in_review';
    org.steers.push({ id: 's1', at: AT, text: 'Sell more ferns.', status: 'new', response: null, acknowledgedAt: null });
    const live = survey(view(org, [work('report', 'cmo')]));
    expect(room<Department>(live, 'dept:cto').lamp).toBe('waiting');
    expect(room<Office>(live, 'shareholders').lamp).toBe('waiting');
    expect(live.flows.find((f) => f.kind === 'report')!.state).toBe('moving');
    org.status = 'paused';
    org.pauseReason = 'user';
    const paused = survey(view(org, [work('report', 'cmo')]));
    expect(room<Department>(paused, 'dept:cto')).toMatchObject({ lamp: 'idle', line: 'Before the board' });
    expect(room<Office>(paused, 'shareholders').lamp).toBe('idle');
    expect(paused.flows.every((f) => f.state !== 'moving')).toBe(true);
    expect(paused.situation.state).toBe('paused');
    // While a pause lets the calls in flight finish, they are still at work.
    const draining = survey(view(org, [work('report', 'cmo')], { draining: true }));
    expect(draining.situation.state).toBe('pausing');
    expect(draining.flows.find((f) => f.kind === 'report')!.state).toBe('moving');
    expect(room<Department>(draining, 'dept:cto').lamp).toBe('waiting');
  });
});

describe('the rooms that are not departments', () => {
  it('says in the CEO’s office what the CEO is doing, and which stage the cycle is at', () => {
    const org = running();
    org.cycle.number = 3;
    org.cycle.stage = 'consult';
    org.cycle.consults.cto = { proposal: 'Build the shop.', rationale: 'r', needs: 'n' };
    const ceo = (active: ActiveWork[] = []) => room<Office>(survey(view(org, active)), 'ceo');
    expect(ceo()).toMatchObject({ lamp: 'idle', line: '1 of 2 proposals in', doing: [], figure: { value: 3, label: 'cycle' }, steps: { names: ['Consult', 'Direct', 'Work'], current: 0 } });
    org.cycle.stage = 'direct';
    expect(ceo()).toMatchObject({ line: 'Deciding what the shareholders want', steps: { current: 1 } });
    org.cycle.stage = 'work';
    expect(ceo()).toMatchObject({ line: 'The leads are at work on its direction', steps: { current: 2 } });
    expect(ceo([work('direct', 'ceo', { label: 'Deciding what the shareholders want now' })])).toMatchObject({ lamp: 'working', line: 'Deciding what the shareholders want now', doing: ['Deciding what the shareholders want now'] });
    org.business.waiting = true;
    expect(ceo()).toMatchObject({ lamp: 'waiting', line: 'Waiting for scheduled work' });
    expect(survey(view(org)).situation.state).toBe('waiting_schedule');
  });

  it('says in the shareholders’ room whether the CEO has taken up what they said', () => {
    const org = running();
    const you = () => room<Office>(survey(view(org)), 'shareholders');
    expect(you()).toMatchObject({ lamp: 'idle', line: 'No steer yet', figure: null });
    org.steers.push({ id: 's1', at: AT, text: 'Sell more ferns.', status: 'new', response: null, acknowledgedAt: null });
    expect(you()).toMatchObject({ lamp: 'waiting', line: '1 steer with the CEO', figure: { value: 1, label: 'steer' } });
    org.steers.push({ id: 's2', at: AT, text: 'And cacti.', status: 'new', response: null, acknowledgedAt: null });
    expect(you()).toMatchObject({ line: '2 steers with the CEO', figure: { value: 2, label: 'steers' } });
    for (const s of org.steers) s.status = 'acknowledged';
    expect(you()).toMatchObject({ lamp: 'idle', line: 'The CEO has answered your steer' });
  });

  const request = (id: string, fields: Partial<SignatoryRequest> = {}): SignatoryRequest => ({ id, cycle: 1, kind: 'payment', fromId: 'cto', planId: null, phase: null, title: 'Domain', detail: 'Register the domain.', amount: '12 GBP', party: 'Namecheap', files: [], status: 'pending', raisedAt: AT, ruling: null, outcome: null, ...fields });

  it('counts at the signing desk what waits for a person, and tells a person of each', () => {
    const org = running();
    org.signatory.requests.push(request('r1'), request('r2', { kind: 'signature', title: 'Lease', amount: '', party: 'Landlord', fromId: 'cmo' }), request('r3', { status: 'done' }));
    const scene = survey(view(org));
    expect(room<Office>(scene, 'signatory')).toMatchObject({ lamp: 'waiting', line: '2 requests waiting for you', figure: { value: 2, label: 'for you' }, pins: { you: 2, trouble: 0 } });
    expect(scene.alerts.filter((a) => a.severity === 'you')).toEqual([
      { severity: 'you', title: 'Pay: Domain (12 GBP, to Namecheap)', detail: 'Asked by the CTO. It waits for you to do it, or to turn it down.', target: 'signatory/request/r1' },
      { severity: 'you', title: 'Sign: Lease (with Landlord)', detail: 'Asked by the CMO. It waits for you to do it, or to turn it down.', target: 'signatory/request/r2' },
    ]);
    expect(scene.situation.needsYou).toBe(2);
    expect(scene.flows.filter((f) => f.kind === 'request').map((f) => [f.from, f.to, f.state, f.label])).toEqual([
      ['dept:cto', 'signatory', 'you', 'A payment the CTO asked for'],
      ['dept:cmo', 'signatory', 'you', 'A signature the CMO asked for'],
    ]);
    // What has been paid, signed, turned down or taken back is on its way nowhere.
    const over = running();
    over.signatory.requests.push(request('r4', { status: 'done' }), request('r5', { status: 'rejected' }), request('r6', { status: 'withdrawn' }));
    expect(survey(view(over)).flows).toEqual([]);
    expect(room<Office>(survey(view(over)), 'signatory')).toMatchObject({ lamp: 'idle', line: 'Nothing to sign or pay', figure: null });
  });

  it('leaves with an AI signatory what it has not ruled on, and gives a person what it has authorised', () => {
    const org = running();
    org.settings.signatory = 'ai';
    org.signatory.requests.push(request('r1'), request('r2', { status: 'authorised', ruling: { verdict: 'authorised', reason: 'Within budget.', at: AT } }));
    const scene = survey(view(org));
    expect(room<Office>(scene, 'signatory')).toMatchObject({ line: '1 request waiting for you', pins: { you: 1, trouble: 0 } });
    expect(scene.alerts.filter((a) => a.severity === 'you').map((a) => a.detail)).toEqual(['Asked by the CTO. The AI signatory authorised it, and it waits for you to carry it out.']);
    // Both came from the same department, so they are one line on the map; nothing on it is moving.
    expect(scene.flows.filter((f) => f.kind === 'request').map((f) => f.state)).toEqual(['waiting']);
    org.signatory.requests.pop();
    const withAi = survey(view(org, [work('authorise', 'signatory', { label: 'Deciding on a payment: Domain' })]));
    expect(room<Office>(withAi, 'signatory')).toMatchObject({ lamp: 'working', line: 'Deciding on a payment: Domain', figure: null, pins: { you: 0, trouble: 0 } });
    expect(room<Office>(survey(view(org)), 'signatory')).toMatchObject({ lamp: 'waiting', line: '1 request with the AI signatory' });
  });

  it('seats a judge only where the organisation has one', () => {
    expect(survey(view(organisation())).rooms.some((r) => r.id === 'judge')).toBe(false);
    const org = team(2, true);
    org.status = 'running';
    const judge = org.executives.find((e) => e.kind === 'judge')!;
    expect(room<Office>(survey(view(org)), 'judge')).toMatchObject({ kind: 'judge', seatId: judge.id, lamp: 'idle', line: 'Rules when leads disagree' });
    expect(room<Office>(survey(view(org, [work('signoff', judge.id, { label: 'Signing off a board decision' })])), 'judge')).toMatchObject({ lamp: 'working', line: 'Signing off a board decision' });
  });

  it('counts how often the memory was put to use this cycle, and what this cycle’s work has written', () => {
    const org = running();
    org.cycle.number = 2;
    const use = (cycle: number) => ({ at: AT, cycle, seatId: 'cto', by: 'shown' as const, about: 'Drafting a plan', items: [] });
    const scene = () => survey(view(org));
    expect(room<Office>(scene(), 'archive')).toMatchObject({ line: 'Not used yet this cycle', figure: null });
    org.memoryUses = [use(1), use(2)];
    expect(room<Office>(scene(), 'archive')).toMatchObject({ line: 'Used once this cycle', figure: { value: 1, label: 'use' } });
    org.memoryUses.push(use(2));
    expect(room<Office>(scene(), 'archive')).toMatchObject({ line: 'Used 2 times this cycle', figure: { value: 2, label: 'uses' } });

    expect(room<Office>(scene(), 'files')).toMatchObject({ line: 'Nothing written yet this cycle', figure: null });
    const old = plan(org, 'cto', 'p0');
    old.phases[0]!.tasks = [task('t0', { files: ['old.md'] })];
    const p = plan(org, 'cto', 'p1');
    p.cycle = 2;
    p.phases[0]!.tasks = [task('t1', { files: ['spec.md', 'notes.md'] }), task('t2', { files: ['spec.md'] })];
    expect(room<Office>(scene(), 'files')).toMatchObject({ line: '2 files written this cycle', figure: { value: 2, label: 'files' } });
  });

  const job = (id: string, fields: Partial<BusinessJob> = {}): BusinessJob => ({
    id, revision: 1, createdAt: AT, updatedAt: AT, updatedBy: 'cto', title: `Job ${id}`, description: '', ownerId: 'cto', nextAction: 'Ship it', status: 'open', blockedReason: '', notBefore: null, dueAt: null,
    recurrenceDays: null, dependsOn: [], customerId: null, metricId: null, reviewerId: null, plan: null, evidence: '', verification: null, previousJobId: null, nextJobId: null, notifiedAt: null, ...fields,
  });

  it('counts the commitments that are open, asks a person to verify what is delivered, and says what is overdue', () => {
    const org = running();
    const now = Date.parse(AT);
    org.business.jobs.push(job('j1'), job('j2', { status: 'review' }), job('j3', { dueAt: '2026-11-07T12:00:00.000Z', nextAction: '' }), job('j4', { dueAt: '2026-11-09T12:00:00.000Z' }), job('j5', { status: 'done', dueAt: '2026-11-01T12:00:00.000Z' }), job('j6', { status: 'cancelled' }));
    // What is overdue says what it is waiting on, where that is known: why it is blocked, or else what comes next.
    const late = running();
    late.business.jobs.push(job('j7', { dueAt: '2026-11-07T12:00:00.000Z' }), job('j8', { dueAt: '2026-11-07T12:00:00.000Z', blockedReason: 'No supplier yet' }));
    expect(survey(view(late), now).alerts.map((a) => a.detail)).toEqual(['Ship it', 'No supplier yet']);
    const scene = survey(view(org), now);
    expect(room<Office>(scene, 'operations')).toMatchObject({ line: '4 open commitments · 1 overdue · 1 to verify', figure: { value: 4, label: 'open' }, pins: { you: 1, trouble: 1 } });
    expect(scene.alerts.filter((a) => a.target === 'operations')).toEqual([
      { severity: 'you', title: 'Verify: Job j2', detail: 'The work is reported as delivered. It counts as done once you have checked it.', target: 'operations' },
      { severity: 'trouble', title: 'Overdue: Job j3', detail: 'Past its date.', target: 'operations' },
    ]);
    // A day later the other one is overdue as well.
    expect(room<Office>(survey(view(org), now + 2 * 86_400_000), 'operations').pins.trouble).toBe(2);
    org.business.jobs = [];
    expect(room<Office>(survey(view(org), now), 'operations')).toMatchObject({ line: 'No open commitments', figure: null, pins: { you: 0, trouble: 0 } });
  });
});

describe('the boardroom', () => {
  const decision = (id: string, fields: Partial<Decision> = {}): Decision => ({ id, cycle: 1, at: AT, kind: 'contested', title: `Decision ${id}`, context: 'c', raisedById: 'cmo', planId: 'p1', issues: [], participantIds: ['cto', 'cmo'], positions: {}, status: 'open', outcome: null, ...fields });

  it('is not sitting when nothing is before it', () => {
    const board = room<Boardroom>(survey(view(running())), 'board');
    expect(board).toMatchObject({ lamp: 'idle', line: 'Not sitting', matters: [] });
    // Every seat but the one that signs and pays has a place at the table, the CEO first.
    expect(board.seats.map((s) => [s.seatId, s.short, s.label, s.mark])).toEqual([['ceo', 'CEO', null, null], ['cto', 'CTO', null, null], ['cmo', 'CMO', null, null]]);
  });

  it('shows a decision that is open, who has said what and who is waited for', () => {
    const org = running();
    plan(org, 'cto', 'p1').status = 'contested';
    org.decisions.push(decision('d1', { positions: { cmo: { stance: 'back_objection', argument: 'a' } } }), decision('d0', { status: 'resolved' }), decision('d9', { kind: 'in_remit' }));
    const scene = survey(view(org));
    const board = room<Boardroom>(scene, 'board');
    expect(board.matters).toEqual([{ id: 'board/decision/d1', kind: 'decision', title: 'Decision d1', line: 'Waiting for CTO', planIds: ['p1'], marks: { cmo: 'back_objection', cto: 'awaited' } }]);
    expect(board).toMatchObject({ lamp: 'waiting', line: 'Decision d1' });
    expect(board.seats.map((s) => s.mark)).toEqual([null, 'awaited', 'back_objection']);
    expect(scene.situation.decisions).toBe(1);
    expect(scene.alerts.find((a) => a.target === 'board/decision/d1')).toEqual({ severity: 'held', title: 'Before the board: Decision d1', detail: 'Waiting for CTO. The plan does not start until it is settled.', target: 'board/decision/d1' });
  });

  it('says what each stage of a decision waits for', () => {
    const org = running();
    plan(org, 'cto', 'p1').status = 'contested';
    const d = decision('d1', { status: 'answering' });
    org.decisions.push(d);
    const matter = () => room<Boardroom>(survey(view(org)), 'board').matters[0]!;
    // First only the plan's owner is asked.
    expect(matter()).toMatchObject({ line: 'Waiting for the CTO to answer', marks: { cto: 'awaited' } });
    d.status = 'open';
    d.positions = { cto: { stance: 'back_plan', argument: 'a' }, cmo: { stance: 'compromise', argument: 'b' } };
    expect(matter()).toMatchObject({ line: 'Positions are in', marks: { cto: 'back_plan', cmo: 'compromise' } });
    d.status = 'deliberated';
    expect(matter().line).toBe('Waiting for the ruling');
  });

  it('shows plans that are being reviewed, and who has reviewed them', () => {
    const org = running();
    plan(org, 'cto', 'p1').status = 'in_review';
    org.reviewRounds.push({ id: 'rr1', cycle: 1, planIds: ['p1'], reviewerIds: ['cmo', 'ceo'], reviews: { cmo: [{ planId: 'p1', byId: 'cmo', concern: 'Too slow.', proposal: 'Go faster.' }] }, status: 'open' }, { id: 'rr0', cycle: 1, planIds: ['p0'], reviewerIds: ['cmo'], reviews: {}, status: 'closed' });
    const board = () => room<Boardroom>(survey(view(org, [work('review', 'ceo', { label: 'Reviewing other leads’ plans' })])), 'board');
    expect(board().matters).toEqual([{ id: 'board/round/rr1', kind: 'round', title: '1 plan before the board', line: '1 of 2 reviews in', planIds: ['p1'], marks: { cmo: 'objects', ceo: 'awaited' } }]);
    // A review is not a decision: nothing is contested until someone objects and the owner does not give way.
    expect(survey(view(org)).situation.decisions).toBe(0);
    expect(survey(view(org)).alerts).toEqual([]);
    expect(board()).toMatchObject({ lamp: 'working', line: '1 plan before the board' });
    expect(board().seats.map((s) => [s.seatId, s.label, s.mark])).toEqual([['ceo', 'Reviewing other leads’ plans', 'awaited'], ['cto', null, null], ['cmo', null, 'objects']]);
    org.reviewRounds[0]!.reviews.ceo = [];
    expect(board().matters[0]).toMatchObject({ line: '2 of 2 reviews in', marks: { cmo: 'objects', ceo: 'no_objection' } });
    // With a decision open as well, the room names the first matter and counts the rest.
    org.decisions.push(decision('d1'));
    expect(board().line).toBe('Decision d1 · and 1 more');
    expect(board().matters.map((m) => m.kind)).toEqual(['decision', 'round']);
  });
});

describe('what is on its way between rooms', () => {
  it('draws a line for a steer the CEO has yet to take up, moving once the CEO has it in hand', () => {
    const org = running();
    org.steers.push({ id: 's1', at: AT, text: 'Sell more ferns.', status: 'new', response: null, acknowledgedAt: null }, { id: 's2', at: AT, text: 'And cacti.', status: 'new', response: null, acknowledgedAt: null });
    const flow = (active: ActiveWork[] = []) => survey(view(org, active)).flows.filter((f) => f.kind === 'steer');
    expect(flow().map((f) => [f.id, f.from, f.to, f.label, f.state])).toEqual([['steer:shareholders>ceo', 'shareholders', 'ceo', '2 steers for the CEO', 'waiting']]);
    expect(flow([work('steer_review', 'ceo')])[0]!.state).toBe('moving');
    org.steers.forEach((s) => (s.status = 'acknowledged'));
    expect(flow()).toEqual([]);
  });

  it('draws what each lead and the CEO are doing with the board and with each other', () => {
    const org = running();
    const scene = survey(view(org, [work('consult', 'cto'), work('review', 'cmo', { label: 'Reviewing other leads’ plans' }), work('signoff', 'ceo', { label: 'Signing off a board decision' }), work('report', 'cto'), work('react', 'cmo'), work('plan', 'cto'), work('task', 'cto', { agent: 1 })]));
    expect(scene.flows.map((f) => [f.kind, f.from, f.to, f.state, f.label])).toEqual([
      ['proposal', 'dept:cto', 'ceo', 'moving', 'The CTO’s proposal for the CEO'],
      ['board', 'dept:cmo', 'board', 'moving', 'CMO: Reviewing other leads’ plans'],
      ['board', 'ceo', 'board', 'moving', 'CEO: Signing off a board decision'],
      ['report', 'dept:cto', 'board', 'moving', 'The CTO’s report to the board'],
      ['reports', 'board', 'dept:cmo', 'moving', 'Board reports for the CMO'],
    ]);
    // Each starts at its first room's door and ends at its second's.
    for (const f of scene.flows) {
      expect(f.points[0], f.id).toEqual(scene.plot.rooms[f.from]!.door);
      expect(f.points.at(-1), f.id).toEqual(scene.plot.rooms[f.to]!.door);
    }
    // Lines that share a corridor are kept apart.
    expect(new Set(scene.flows.map((f) => f.points[1]!.y)).size).toBe(scene.flows.length);
  });

  it('draws a plan that is before the board, and a report that is being written, as standing until taken up', () => {
    const org = running();
    plan(org, 'cto', 'p1').status = 'in_review';
    plan(org, 'cto', 'p2').status = 'contested';
    plan(org, 'cmo', 'p3').status = 'reporting';
    const flows = (active: ActiveWork[] = []) => survey(view(org, active)).flows.map((f) => [f.id, f.state, f.label]);
    // Two plans of one lead are one line.
    expect(flows()).toEqual([
      ['plan:dept:cto>board', 'waiting', 'The CTO’s plan is before the board'],
      ['report:dept:cmo>board', 'waiting', 'The CMO’s report to the board'],
    ]);
    // A report being written now is the same line, moving.
    expect(flows([work('report', 'cmo')])).toEqual([
      ['report:dept:cmo>board', 'moving', 'The CMO’s report to the board'],
      ['plan:dept:cto>board', 'waiting', 'The CTO’s plan is before the board'],
    ]);
  });

  it('draws what one lead’s plan waits for in another’s, and says so in the department', () => {
    const org = running();
    const theirs = plan(org, 'cto', 'p1');
    theirs.phases[0]!.status = 'working';
    const mine = plan(org, 'cmo', 'p2');
    mine.phases[0]!.waitsFor = [{ leadId: 'cto', phase: 'Spec', planId: 'p1', phaseIndex: 0, phaseId: theirs.phases[0]!.sopPhaseId, released: null }];
    const scene = survey(view(org));
    expect(scene.flows.map((f) => [f.kind, f.from, f.to, f.state, f.label])).toEqual([['wait', 'dept:cto', 'dept:cmo', 'waiting', 'The CMO waits for CTO: Spec']]);
    const dept = room<Department>(scene, 'dept:cmo');
    expect(dept).toMatchObject({ lamp: 'waiting', line: 'Waits for CTO: Spec' });
    expect(dept.track!.held).toEqual(['CTO: Spec']);
    expect(dept.track!.stations.map((s) => s.line)).toEqual(['Waits for CTO: Spec', 'Not started', 'Not started', 'Not started']);
    expect(scene.alerts).toContainEqual({ severity: 'held', title: 'CMO waits for CTO: Spec', detail: 'Open the shop', target: 'dept:cmo/plan/p2' });
    // Once what it waited for is done, nothing holds it.
    theirs.phases[0]!.status = 'done';
    const after = survey(view(org));
    expect(after.flows).toEqual([]);
    expect(room<Department>(after, 'dept:cmo').track!.held).toEqual([]);
  });
});

describe('what a person should know of', () => {
  it('says why an organisation is paused, and what would set it going', () => {
    const org = running();
    org.status = 'paused';
    const whole = () => survey(view(org)).alerts.filter((a) => a.target === null);
    org.pauseReason = 'error';
    org.lastError = 'The provider refused the key.';
    expect(whole()).toEqual([{ severity: 'trouble', title: 'Paused: an operation failed', detail: 'The provider refused the key. Nothing was lost: put the cause right, then resume.', target: null }]);
    org.pauseReason = 'budget';
    expect(whole()).toEqual([{ severity: 'you', title: 'Paused: the budget is spent', detail: 'Raise the budget in the settings to let it continue.', target: null }]);
    org.pauseReason = 'cycle_limit';
    expect(whole()).toEqual([{ severity: 'you', title: 'Paused: the cycle limit is reached', detail: 'Raise or remove the limit in the settings to let it continue.', target: null }]);
    org.pauseReason = 'restart';
    expect(whole()).toEqual([{ severity: 'you', title: 'Paused: the server restarted', detail: 'Resume and it carries on from where it stopped.', target: null }]);
    // A person paused it, and knows.
    org.pauseReason = 'user';
    expect(whole()).toEqual([]);
  });

  it('says when it is waiting for a person to move it on a step', () => {
    const org = running();
    org.settings.pace = 'step';
    const next = { next: [{ kind: 'plan' as const, execId: 'cto', label: 'Drafting a plan' }], nextAt: null };
    const scene = survey(view(org, [], { pace: next }));
    expect(scene.alerts[0]).toEqual({ severity: 'you', title: 'Waiting for your next step', detail: 'Next: CTO · Drafting a plan', target: null });
    expect(scene.situation.state).toBe('waiting_step');
    // Not while the step it was moved on by is still being taken, nor with nothing to start, nor at another pace.
    expect(survey(view(org, [work('plan', 'cmo')], { pace: next })).situation.state).toBe('running');
    expect(survey(view(org)).situation.state).toBe('running');
    // A hosted session that is being followed is not a call that is waited for.
    expect(survey(view(org, [work('execute', 'cmo')], { pace: next })).situation.state).toBe('waiting_step');
    org.settings.pace = 'slow';
    expect(survey(view(org, [], { pace: next })).alerts).toEqual([]);
  });

  it('says what has gone wrong in the work that is under way, and pins it to the room it is in', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    p.phases[0]!.status = 'done';
    p.phases[0]!.tasks = [task('t0', { status: 'failed', error: 'An old failure' })];
    p.phases[1]!.status = 'working';
    p.phases[1]!.tasks = [task('t1', { status: 'failed', error: 'The build broke' }), task('t2', { status: 'failed' }), task('t3', { status: 'done' })];
    p.phases[1]!.reworkRounds = 1;
    p.phases[1]!.summary = 'Fix the build.';
    const scene = survey(view(org));
    const mine = scene.alerts.filter((a) => a.target !== null && roomOf(a.target) === 'dept:cto');
    expect(mine).toEqual([
      { severity: 'trouble', title: 'CTO Build: 2 tasks failed', detail: 'Task t1: The build broke · Task t2: no reason given', target: 'dept:cto/phase/p1/1' },
      { severity: 'held', title: 'CTO Build: sent back for rework', detail: 'Fix the build.', target: 'dept:cto/phase/p1/1' },
    ]);
    expect(room<Department>(scene, 'dept:cto').pins).toEqual({ you: 0, trouble: 1 });
    expect(room<Department>(scene, 'dept:cmo').pins).toEqual({ you: 0, trouble: 0 });
    expect(scene.situation.trouble).toBe(1);
    // A check of the system's own that did not pass is trouble, and says what the system found.
    p.phases[1]!.tasks = [task('t3', { status: 'done' })];
    p.phases[1]!.gate = 'run';
    p.phases[1]!.evidence = { gate: 'run', state: 'failed', sha: null, summary: 'npm test exited with 1.', checks: [], waitedMs: 0, at: AT };
    expect(survey(view(org)).alerts.filter((a) => a.severity === 'trouble')).toEqual([{ severity: 'trouble', title: 'CTO Build: the system’s check did not pass', detail: 'npm test exited with 1.', target: 'dept:cto/phase/p1/1' }]);
  });

  it('says when a plan has failed, and when a hosted session is in trouble', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    p.status = 'failed';
    expect(survey(view(org)).alerts).toEqual([{ severity: 'trouble', title: 'CTO: the plan failed', detail: 'Open the shop', target: 'dept:cto/plan/p1' }]);
    p.status = 'executing';
    p.execution = 'managed';
    p.managed = { sessionId: 's1', consoleUrl: null, budgetUsd: 5, spentUsd: 5, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 }, state: 'at_budget', runs: [], pendingReport: null, instructionsSent: 0, declined: 0, note: null, files: [], attempts: 0, synced: {}, agents: [], lastDeclined: null, cursor: null };
    expect(survey(view(org)).alerts.map((a) => a.title)).toEqual(['CTO: the session is at its spend cap']);
    expect(room<Department>(survey(view(org)), 'dept:cto').line).toBe('Session at its spend cap');
    p.managed.state = 'running';
    p.managed.adrift = true;
    expect(survey(view(org)).alerts.map((a) => [a.severity, a.title, a.target])).toEqual([['trouble', 'CTO: a session is running unwatched', 'dept:cto/plan/p1']]);
  });

  it('puts what needs a person first, then what has gone wrong, then what is held up', () => {
    const org = running();
    const p = plan(org, 'cto', 'p1');
    p.phases[0]!.status = 'working';
    p.phases[0]!.tasks = [task('t1', { status: 'failed' })];
    p.phases[0]!.reworkRounds = 1;
    org.signatory.requests.push({ id: 'r1', cycle: 1, kind: 'payment', fromId: 'cto', planId: null, phase: null, title: 'Domain', detail: 'd', amount: '', party: '', files: [], status: 'pending', raisedAt: AT, ruling: null, outcome: null });
    org.status = 'paused';
    org.pauseReason = 'budget';
    const scene = survey(view(org));
    expect(scene.alerts.map((a) => a.severity)).toEqual(['you', 'you', 'trouble', 'held']);
    // What stands in the way of the whole organisation is the first of what needs a person.
    expect(scene.alerts[0]!.title).toBe('Paused: the budget is spent');
    expect(scene.situation).toMatchObject({ needsYou: 2, trouble: 1 });
    // A failure that stopped everything is the first of what has gone wrong, and still comes after what needs a person.
    org.pauseReason = 'error';
    org.lastError = 'The provider refused the key.';
    expect(survey(view(org)).alerts.map((a) => [a.severity, a.title])).toEqual([
      ['you', 'Pay: Domain'],
      ['trouble', 'Paused: an operation failed'],
      ['trouble', 'CTO Spec: 1 task failed'],
      ['held', 'CTO Spec: sent back for rework'],
    ]);
  });

  it('counts the plans by how far they have got, and the phases of this cycle that are done', () => {
    const org = running();
    org.cycle.number = 2;
    const add = (id: string, status: Parameters<typeof plan>[2] extends string ? Organisation['plans'][number]['status'] : never, cycle = 2, done = 0) => {
      const p = plan(org, 'cto', id);
      p.status = status;
      p.cycle = cycle;
      p.phases.slice(0, done).forEach((ph) => (ph.status = 'done'));
    };
    add('a', 'planning');
    add('b', 'drafted');
    add('c', 'contested');
    add('d', 'approved');
    add('e', 'executing', 2, 1);
    add('f', 'reporting', 2, 4);
    add('g', 'done', 2, 4);
    add('h', 'cancelled', 2, 2);
    add('i', 'failed', 2, 1);
    add('old', 'done', 1, 4);
    const { plans, phases } = survey(view(org)).situation;
    expect(plans).toEqual({ live: 6, drafting: 1, beforeBoard: 2, underWay: 3, reported: 1 });
    // Every plan of this cycle that was not cancelled: nine of them, of four phases each.
    expect(phases).toEqual({ done: 10, total: 32 });
  });
});

describe('the latest of what was said and done', () => {
  it('lists what was said at the board and what agents finished, newest first, each with the room it leads to', () => {
    const org = running();
    org.board = [];
    const p = plan(org, 'cto', 'p1');
    p.phases[0]!.tasks = [task('t1', { status: 'done', agent: 2, title: 'Write the spec', finishedAt: '2026-11-08T12:04:00.000Z' }), task('t2', { status: 'failed', agent: null, title: 'Check it', finishedAt: '2026-11-08T12:06:00.000Z' }), task('t3', { status: 'running', agent: 1 }), task('t4', { status: 'done', agent: 7, title: 'By a seventh', finishedAt: '2026-11-08T12:07:00.000Z' })];
    org.decisions.push({ id: 'd1', cycle: 1, at: AT, kind: 'contested', title: 'D', context: '', raisedById: 'cmo', planId: 'p1', issues: [], participantIds: [], positions: {}, status: 'open', outcome: null }, { id: 'd2', cycle: 1, at: AT, kind: 'contested', title: 'D2', context: '', raisedById: 'cmo', planId: 'p1', issues: [], participantIds: [], positions: {}, status: 'resolved', outcome: null });
    org.signatory.requests.push({ id: 'r1', cycle: 1, kind: 'payment', fromId: 'cto', planId: null, phase: null, title: 'Domain', detail: 'd', amount: '', party: '', files: [], status: 'pending', raisedAt: AT, ruling: null, outcome: null });
    const say = (minute: number, type: Organisation['board'][number]['type'], fromId: string, fields: Partial<Organisation['board'][number]> = {}) =>
      org.board.push({ id: `m${minute}`, at: `2026-11-08T12:${String(minute).padStart(2, '0')}:00.000Z`, cycle: 1, type, fromId, title: `Said at ${minute}`, body: '', ...fields });
    say(1, 'steer', 'shareholders');
    say(2, 'direction', 'ceo');
    say(3, 'plan', 'cto', { planId: 'p1' });
    say(5, 'decision', 'ceo', { decisionId: 'd1', planId: 'p1' });
    say(8, 'decision', 'ceo', { decisionId: 'd2', planId: 'p1' });
    say(9, 'signatory', 'cto', { requestId: 'r1' });
    say(10, 'signatory', 'cto', { requestId: 'gone' });
    say(11, 'consult', 'cmo');
    say(12, 'report', 'cmo', { planId: 'gone' });
    say(13, 'system', 'system');
    say(14, 'review', 'cmo', { planId: 'p1' });
    expect(survey(view(org)).dispatches.map((d) => [d.at.slice(14, 16), d.seatId, d.label, d.title, d.target, d.tone])).toEqual([
      ['14', 'cmo', 'Review', 'Said at 14', 'board', 'plain'],
      ['13', 'system', 'Notice', 'Said at 13', 'board', 'plain'],
      ['12', 'cmo', 'Report', 'Said at 12', 'dept:cmo', 'plain'],
      ['11', 'cmo', 'Proposal', 'Said at 11', 'dept:cmo', 'plain'],
      ['10', 'cto', 'Signing and paying', 'Said at 10', 'signatory', 'plain'],
      ['09', 'cto', 'Signing and paying', 'Said at 9', 'signatory/request/r1', 'plain'],
      ['08', 'ceo', 'Decision', 'Said at 8', 'board', 'plain'],
      ['07', 'cto', 'Agent 7 finished', 'By a seventh', 'dept:cto/plan/p1', 'good'],
      ['06', 'cto', 'Task failed', 'Check it', 'dept:cto/plan/p1', 'trouble'],
      ['05', 'ceo', 'Decision', 'Said at 5', 'board/decision/d1', 'plain'],
      ['04', 'cto', 'Agent 2 finished', 'Write the spec', 'dept:cto/agent/2', 'good'],
      ['03', 'cto', 'Plan', 'Said at 3', 'dept:cto/plan/p1', 'plain'],
      ['02', 'ceo', 'Direction', 'Said at 2', 'ceo', 'plain'],
      ['01', 'shareholders', 'Steer', 'Said at 1', 'shareholders', 'plain'],
    ]);
  });

  it('keeps the latest eighty, and leaves out what agents finished in earlier cycles', () => {
    const org = running();
    org.board = [];
    org.cycle.number = 2;
    const old = plan(org, 'cto', 'p0');
    old.phases[0]!.tasks = [task('t0', { status: 'done', agent: 1, finishedAt: '2026-11-08T23:00:00.000Z' })];
    for (let i = 0; i < 120; i++) org.board.push({ id: `m${i}`, at: new Date(Date.parse(AT) + i * 1000).toISOString(), cycle: 2, type: 'system', fromId: 'system', title: `Notice ${i}`, body: '' });
    const list = survey(view(org)).dispatches;
    expect(list).toHaveLength(80);
    expect(list[0]!.title).toBe('Notice 119');
    expect(list.at(-1)!.title).toBe('Notice 40');
    expect(list.some((d) => d.id.startsWith('task:'))).toBe(false);
    // With this cycle's tasks among them there are still eighty, the latest of both.
    const now = plan(org, 'cto', 'p1');
    now.cycle = 2;
    now.phases[0]!.tasks = Array.from({ length: 30 }, (_, i) => task(`n${i}`, { status: 'done', agent: 1, finishedAt: new Date(Date.parse(AT) + (100 + i) * 1000 + 500).toISOString() }));
    const both = survey(view(org)).dispatches;
    expect(both).toHaveLength(80);
    expect(both.filter((d) => d.id.startsWith('task:'))).toHaveLength(30);
    expect(both.at(-1)!.title).toBe('Notice 70');
  });
});
