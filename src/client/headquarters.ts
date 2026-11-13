import { describeRequest, isOpen, waitingOnPerson, waitsOnAi } from '../shared/signatory';
import { describeWait, heldBy } from '../shared/waits';
import type { ActiveWork, BoardMessage, Executive, ManagedSession, Organisation, OrgView, PhaseGate, PhaseStatus, Plan, PlanPhase, PlanStatus, Stance, Task } from '../shared/types';
import { MESSAGE_LABEL, PLAN_STATUS, SESSION_STATE, STAGES } from './labels';

// The organisation as a place: a headquarters seen from above, with a room for every seat, a desk for every agent
// and a corridor for whatever is on its way between them. Everything here is worked out from the organisation as the
// server last sent it, and nothing here draws: what is drawn, and how large, is for the map to decide.

// ---- where things are ----

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

/** Between the building's outer wall and its rooms. Wide enough for a flow to run round the rooms. */
const MARGIN = 26;
/** Between two rooms in a row. */
const GAP = 18;
/** How wide a corridor is. */
const HALL = 46;
const EXECUTIVE_H = 156;
const DEPARTMENT_H = 276;
const DEPARTMENT_W = { min: 240, max: 330 };
const ROOM_W = { signatory: 190, shareholders: 216, ceo: 250, board: 330, judge: 178 } as const;
/** The rooms that serve every department stand in a column beside them, this wide. */
const SERVICE_W = 190;
const SERVICES = ['archive', 'files', 'operations'] as const;
/** Departments in one row. More leads than this and they are put in two rows. */
const PER_ROW = 4;

export type RoomKind = 'shareholders' | 'ceo' | 'board' | 'signatory' | 'judge' | 'department' | 'archive' | 'files' | 'operations';

export interface Place {
  rect: Rect;
  /** The middle of its door, on the wall the door is in. */
  door: Point;
  doorIn: 'top' | 'bottom' | 'left';
  /** The corridor the door opens on. */
  hall: number;
}

export interface Plot {
  /** The whole building, from its outer wall. */
  size: { w: number; h: number };
  /** The corridors, top to bottom: under the executive floor, and between rows of departments. */
  halls: Rect[];
  rooms: Record<string, Place>;
}

export const departmentId = (seatId: string): string => `dept:${seatId}`;

/**
 * Where every room of the headquarters stands, for the team an organisation has. The executive floor is along the
 * top, the departments are beneath it in one row or two, and what serves them all is in a column at their side: a
 * screen is wider than it is tall, and so is the building.
 */
export function plot(org: Pick<Organisation, 'executives'>): Plot {
  const leads = org.executives.filter((e) => e.kind === 'lead');
  const judge = org.executives.some((e) => e.kind === 'judge');
  const top: Array<keyof typeof ROOM_W> = ['signatory', 'shareholders', 'ceo', 'board', ...(judge ? (['judge'] as const) : [])];
  const topW = top.reduce((sum, id) => sum + ROOM_W[id], 0) + GAP * (top.length - 1);
  const perRow = leads.length <= PER_ROW ? Math.max(1, leads.length) : Math.ceil(leads.length / 2);
  const rows = Math.max(1, Math.ceil(leads.length / perRow));
  // A few departments are given the width the floor above them has; many are as narrow as a department can be.
  const departmentW = Math.min(DEPARTMENT_W.max, Math.max(DEPARTMENT_W.min, Math.floor((topW - SERVICE_W - GAP * perRow) / perRow)));
  const blockW = perRow * departmentW + GAP * perRow + SERVICE_W;
  const inner = Math.max(topW, blockW);

  const rooms: Plot['rooms'] = {};
  const halls: Rect[] = [];
  let x = MARGIN + (inner - topW) / 2;
  for (const id of top) {
    const rect = { x, y: MARGIN, w: ROOM_W[id], h: EXECUTIVE_H };
    rooms[id] = { rect, door: { x: x + rect.w / 2, y: rect.y + rect.h }, doorIn: 'bottom', hall: 0 };
    x += rect.w + GAP;
  }
  const left = MARGIN + (inner - blockW) / 2;
  let y = MARGIN + EXECUTIVE_H;
  const blockTop = y + HALL;
  for (let r = 0; r < rows; r++) {
    halls.push({ x: MARGIN, y, w: inner, h: HALL });
    y += HALL;
    leads.slice(r * perRow, (r + 1) * perRow).forEach((lead, i) => {
      const rect = { x: left + i * (departmentW + GAP), y, w: departmentW, h: DEPARTMENT_H };
      rooms[departmentId(lead.id)] = { rect, door: { x: rect.x + rect.w / 2, y }, doorIn: 'top', hall: r };
    });
    y += DEPARTMENT_H;
  }
  const serviceH = (y - blockTop - GAP * (SERVICES.length - 1)) / SERVICES.length;
  SERVICES.forEach((id, i) => {
    const rect = { x: left + blockW - SERVICE_W, y: blockTop + i * (serviceH + GAP), w: SERVICE_W, h: serviceH };
    rooms[id] = { rect, door: { x: rect.x, y: rect.y + rect.h / 2 }, doorIn: 'left', hall: 0 };
  });
  return { size: { w: inner + MARGIN * 2, h: y + MARGIN }, halls, rooms };
}

/** The way from one room's door to another's, along the corridors. `lane` keeps flows that share a corridor apart. */
export function route(at: Plot, from: string, to: string, lane = 0): Point[] {
  const a = at.rooms[from];
  const b = at.rooms[to];
  if (!a || !b) return [];
  const shift = lane * 5;
  const along = (hall: number) => at.halls[hall]!.y + HALL / 2 + shift;
  if (a.hall === b.hall) return [a.door, { x: a.door.x, y: along(a.hall) }, { x: b.door.x, y: along(a.hall) }, b.door];
  // Two corridors are joined round the outside of the rooms, by whichever side is the shorter way.
  const left = MARGIN / 2 + shift;
  const right = at.size.w - MARGIN / 2 - shift;
  const side = a.door.x - left + (b.door.x - left) <= right - a.door.x + (right - b.door.x) ? left : right;
  return [a.door, { x: a.door.x, y: along(a.hall) }, { x: side, y: along(a.hall) }, { x: side, y: along(b.hall) }, { x: b.door.x, y: along(b.hall) }, b.door];
}

// ---- how it is looked at ----

/** Where the map is looked at from: a point of the world is drawn at world × k + (x, y). */
export interface Camera {
  k: number;
  x: number;
  y: number;
}

export const ZOOM = { min: 0.22, max: 3.2, step: 1.35 } as const;

export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/** The camera that shows the whole of `rect`, centred in what `inset` leaves of the view, and no closer than `closest`. */
export function fit(rect: Rect, view: { w: number; h: number }, inset: Inset = NO_INSET, closest = 1.25): Camera {
  const w = Math.max(40, view.w - inset.left - inset.right);
  const h = Math.max(40, view.h - inset.top - inset.bottom);
  const k = Math.min(ZOOM.max, closest, Math.max(ZOOM.min, Math.min(w / rect.w, h / rect.h)));
  return { k, x: inset.left + (w - rect.w * k) / 2 - rect.x * k, y: inset.top + (h - rect.h * k) / 2 - rect.y * k };
}

/** Nearer or further by `factor`, keeping whatever is under `at` (a point of the view) where it is. */
export function zoomAt(camera: Camera, factor: number, at: Point): Camera {
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, camera.k * factor));
  const ratio = k / camera.k;
  return { k, x: at.x - (at.x - camera.x) * ratio, y: at.y - (at.y - camera.y) * ratio };
}

/** The camera moved no further than leaves a good part of the building in view: a map dragged right off the screen is hard to find again. */
export function keepInView(camera: Camera, size: { w: number; h: number }, view: { w: number; h: number }): Camera {
  const keep = (offset: number, world: number, across: number) => {
    const shown = Math.min(across, world) * 0.3;
    return Math.min(across - shown, Math.max(shown - world, offset));
  };
  return { k: camera.k, x: keep(camera.x, size.w * camera.k, view.w), y: keep(camera.y, size.h * camera.k, view.h) };
}

/** The part of the world a camera shows. */
export function inView(camera: Camera, view: { w: number; h: number }): Rect {
  return { x: -camera.x / camera.k, y: -camera.y / camera.k, w: view.w / camera.k, h: view.h / camera.k };
}

// ---- words on a map ----

const NARROW = new Set("iljtfrI.,:;'!|()[] ");
const WIDE = new Set('mwMW@%');

/**
 * Roughly how wide a run of text is in the interface's font. A label on the map is cut to the room it has before
 * it is drawn, where nothing can measure it, and whatever this gets wrong is clipped by the room's own wall.
 */
export function textWidth(text: string, size: number, bold = false): number {
  let em = 0;
  // An arrow, a dash, a letter of another script: anything beyond plain Latin is counted as wide, which errs towards cutting.
  for (const char of text) em += NARROW.has(char) ? 0.31 : WIDE.has(char) ? 0.88 : char > '\u024f' ? 1 : char >= 'A' && char <= 'Z' ? 0.68 : char >= '0' && char <= '9' ? 0.6 : 0.56;
  return em * size * (bold ? 1.07 : 1);
}

/** `text`, or as much of it as `width` has room for, ending in an ellipsis. Empty when there is not room for two letters. */
export function fitText(text: string, width: number, size: number, bold = false): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (textWidth(clean, size, bold) <= width) return clean;
  const room = width - textWidth('…', size, bold);
  let cut = '';
  for (const char of clean) {
    if (textWidth(cut + char, size, bold) > room) break;
    cut += char;
  }
  cut = cut.trimEnd();
  return cut.length < 2 ? '' : cut + '…';
}

/** `text` broken at its spaces into at most `lines` lines of `width`, the last of them cut short if there is more. */
export function wrapText(text: string, width: number, size: number, lines: number, bold = false): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let line = '';
  while (words.length && out.length < lines) {
    const next = line ? line + ' ' + words[0] : words[0]!;
    if (!line || textWidth(next, size, bold) <= width) {
      line = next;
      words.shift();
    } else {
      out.push(line);
      line = '';
    }
  }
  if (line && out.length < lines) out.push(line);
  else if (line || words.length) out[out.length - 1] = fitText([out[out.length - 1], line, ...words].filter(Boolean).join(' '), width, size, bold);
  // A single word longer than a line is cut too.
  return out.map((l) => fitText(l, width, size, bold)).filter(Boolean);
}

// ---- what is going on ----

/** Whether anything is being done there now, is waited for, has been finished, or there is nothing to do. */
export type Lamp = 'working' | 'waiting' | 'done' | 'idle';

/**
 * Something a person should know of. `you`: nothing more happens to it until a person acts. `trouble`: it failed, or
 * is stuck. `held`: it waits on something else in the organisation, which will see to it.
 */
export interface Alert {
  severity: 'you' | 'trouble' | 'held';
  title: string;
  detail: string;
  /** What to show for it: a room, or a thing in a room. Null for what concerns the whole organisation. */
  target: string | null;
}

export interface Station {
  /** What selects it. */
  id: string;
  index: number;
  name: string;
  status: PhaseStatus;
  tasks: { done: number; running: number; failed: number; total: number };
  /** A gate the system checks for itself, and how that stands. `ahead`: not reached yet. */
  gate: { kind: PhaseGate; state: 'ahead' | 'waiting' | 'passed' | 'failed' } | null;
  rework: number;
  /** In a line, where the phase stands. */
  line: string;
}

export interface Track {
  id: string;
  planId: string;
  objective: string;
  status: PlanStatus;
  label: string;
  stations: Station[];
  /** What the plan waits on in other leads' plans before its next phase can start. */
  held: string[];
  session: ManagedSession['state'] | null;
}

export interface AgentDesk {
  id: string;
  agent: number;
  busy: boolean;
  /** What the agent is doing, when it is doing something. */
  label: string | null;
  planId: string | null;
  taskId: string | null;
}

interface RoomBase {
  id: string;
  rect: Rect;
  door: Point;
  doorIn: Place['doorIn'];
  title: string;
  /** The seat's short code, for a badge. */
  short: string;
  hue: number;
  lamp: Lamp;
  /** One line on what is happening there. */
  line: string;
  /** How many things there need a person, and how many have gone wrong. */
  pins: { you: number; trouble: number };
}

export interface Department extends RoomBase {
  kind: 'department';
  seatId: string;
  /** What the lead itself is doing now, apart from its agents. */
  lead: string[];
  desks: AgentDesk[];
  /** Agents at work in a hosted session beyond the number the lead was given, and agents working in workflow runs. */
  beyond: number;
  inRuns: number;
  track: Track | null;
  /** The phases of the lead's operating profile, which every plan of its runs through. */
  profile: string[];
  /** The lead's other plans that are not over. */
  queued: number;
  /** Board reports it has yet to read. */
  inbox: number;
  spendUsd: number;
}

/** What a seat at the board table has said on the matter in front of the board. `awaited`: nothing yet, and it is asked. */
export type SeatMark = Stance | 'objects' | 'no_objection' | 'awaited';

export interface Matter {
  id: string;
  kind: 'decision' | 'round';
  title: string;
  /** What it waits for. */
  line: string;
  planIds: string[];
  marks: Record<string, SeatMark>;
}

export interface BoardSeat {
  seatId: string;
  short: string;
  hue: number;
  /** What the seat is doing at the board now. */
  label: string | null;
  mark: SeatMark | null;
}

export interface Boardroom extends RoomBase {
  kind: 'board';
  seats: BoardSeat[];
  matters: Matter[];
}

export interface Office extends RoomBase {
  kind: Exclude<RoomKind, 'department' | 'board'>;
  /** The seat that sits there, where one does. */
  seatId: string | null;
  /** What the seat is doing now. */
  doing: string[];
  /** A figure worth a glance, and what it counts. */
  figure: { value: number; label: string } | null;
  /** Steps the place goes through in order, and which it is at: the stages of a cycle, in the CEO's office. */
  steps?: { names: string[]; current: number };
}

export type Room = Department | Boardroom | Office;

export type FlowKind = 'steer' | 'proposal' | 'plan' | 'board' | 'report' | 'reports' | 'request' | 'wait';

/** Something on its way from one room to another, or waited for from it. */
export interface Flow {
  id: string;
  kind: FlowKind;
  from: string;
  to: string;
  label: string;
  /** `moving`: it is being worked on now. `waiting`: it stands until someone in the organisation takes it up. `you`: it stands until a person does. */
  state: 'moving' | 'waiting' | 'you';
  points: Point[];
}

export interface Dispatch {
  id: string;
  at: string;
  seatId: string;
  /** What kind of thing happened. */
  label: string;
  title: string;
  target: string;
  tone: 'plain' | 'good' | 'trouble';
}

export interface Situation {
  /** In a few words, what the organisation as a whole is doing. */
  state: 'running' | 'pausing' | 'paused' | 'idle' | 'waiting_schedule' | 'waiting_step';
  agents: { working: number; total: number };
  /** Seats other than agents with a model call in flight. */
  seats: number;
  plans: { live: number; drafting: number; beforeBoard: number; underWay: number; reported: number };
  /** Phases of this cycle's plans. */
  phases: { done: number; total: number };
  decisions: number;
  needsYou: number;
  trouble: number;
}

export interface Scene {
  plot: Plot;
  rooms: Room[];
  flows: Flow[];
  alerts: Alert[];
  situation: Situation;
  dispatches: Dispatch[];
}

const live = (plan: Plan): boolean => plan.status !== 'done' && plan.status !== 'cancelled' && plan.status !== 'failed';
const BEFORE_BOARD: ReadonlySet<PlanStatus> = new Set(['drafted', 'in_review', 'contested', 'revising']);
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/** The room a thing is in: `dept:cto/agent/2` is in `dept:cto`. */
export const roomOf = (target: string): string => target.split('/')[0]!;

const tally = (phase: PlanPhase): Station['tasks'] => {
  const count = (status: Task['status']) => phase.tasks.filter((t) => t.status === status).length;
  return { done: count('done'), running: count('running'), failed: count('failed'), total: phase.tasks.length };
};

/** In a line, where a phase stands. `held`: what it waits on in other leads' plans. `reviewing`: its lead is at its gate now. */
function phaseLine(phase: PlanPhase, held: string[], reviewing: boolean): string {
  if (phase.status === 'done') return 'Done';
  if (phase.status === 'pending') return held.length ? `Waits for ${held.join('; ')}` : 'Not started';
  const tasks = tally(phase);
  let line: string;
  if (phase.evidence?.state === 'failed') line = 'The system’s check did not pass';
  else if (phase.evidence?.state === 'waiting') line = phase.gate === 'run' ? 'The system is running its check' : 'Waiting for the repository’s checks';
  else if (!tasks.total) line = 'Being handed out';
  else if (tasks.done + tasks.failed === tasks.total) line = reviewing ? 'Under review at its gate' : 'At its gate';
  else line = `${tasks.done} of ${plural(tasks.total, 'task')} done`;
  return phase.reworkRounds > 0 ? `${line} · rework round ${phase.reworkRounds}` : line;
}

function track(org: Organisation, plan: Plan, active: ActiveWork[]): Track {
  const reviewing = active.some((a) => a.kind === 'phase_review' && a.planId === plan.id);
  const held = heldBy(org, plan).map((w) => describeWait(org, w));
  // What holds a plan up holds its next phase up.
  const next = plan.phases.find((p) => p.status !== 'done');
  return {
    id: `${departmentId(plan.ownerId)}/plan/${plan.id}`,
    planId: plan.id,
    objective: plan.objective,
    status: plan.status,
    label: PLAN_STATUS[plan.status],
    stations: plan.phases.map((phase, index) => ({
      id: `${departmentId(plan.ownerId)}/phase/${plan.id}/${index}`,
      index,
      name: phase.name,
      status: phase.status,
      tasks: tally(phase),
      gate: phase.gate ? { kind: phase.gate, state: phase.evidence?.state ?? (phase.status === 'done' ? 'passed' : 'ahead') } : null,
      rework: phase.reworkRounds,
      line: phaseLine(phase, phase === next ? held : [], reviewing),
    })),
    held,
    session: plan.execution === 'managed' && plan.managed ? plan.managed.state : null,
  };
}

function department(org: Organisation, lead: Executive, active: ActiveWork[], place: Place, running: boolean): Department {
  const mine = active.filter((a) => a.execId === lead.id);
  const thinking = mine.filter((a) => a.kind !== 'task');
  const tasks = mine.filter((a) => a.kind === 'task');
  const plans = org.plans.filter((p) => p.ownerId === lead.id);
  const open = plans.filter(live);
  // The plan being carried out, or else the next one; with none of those, how this cycle's last one ended.
  const plan = open.find((p) => p.status === 'executing') ?? open[0] ?? plans.filter((p) => p.cycle === org.cycle.number).at(-1) ?? null;
  // In a hosted session the agents work on the provider's side: who is busy is read from the plan, not from this machine's calls.
  const session = plan?.status === 'executing' && plan.execution === 'managed' ? plan.managed : null;
  const hosted = plan && session?.state === 'running' ? plan.phases.flatMap((p) => p.tasks).filter((t) => t.status === 'running' && t.threadId) : [];
  const own = hosted.filter((t) => t.agent !== null);
  const desks: AgentDesk[] = Array.from({ length: lead.agentCount }, (_, i) => {
    const agent = i + 1;
    const call = tasks.find((t) => t.agent === agent);
    const inSession = own.find((t) => t.agent === agent);
    const taskOf = call?.planId ? org.plans.find((p) => p.id === call.planId)?.phases.flatMap((p) => p.tasks).find((t) => t.agent === agent && t.status === 'running') : undefined;
    return {
      id: `${departmentId(lead.id)}/agent/${agent}`,
      agent,
      busy: !!(call || inSession),
      label: call?.label ?? inSession?.title ?? null,
      planId: call?.planId ?? (inSession ? plan!.id : null),
      taskId: taskOf?.id ?? inSession?.id ?? null,
    };
  });
  const beyond = own.filter((t) => (t.agent ?? 0) > lead.agentCount).length;
  const inRuns = hosted.length - own.length;
  const working = desks.filter((d) => d.busy).length + beyond + inRuns;
  const inbox = (org.inbox[lead.id] ?? []).length;
  const current = plan && live(plan) ? plan.phases.find((p) => p.status !== 'done') : undefined;

  let lamp: Lamp = 'idle';
  let line: string;
  if (working) {
    lamp = 'working';
    line = `${current ? current.name + ' · ' : ''}${working > lead.agentCount ? plural(working, 'agent') : `${working} of ${plural(lead.agentCount, 'agent')}`} working`;
  } else if (thinking.length) {
    lamp = 'working';
    line = thinking[0]!.label;
  } else if (!plan) {
    lamp = inbox ? 'waiting' : 'idle';
    line = inbox ? `${plural(inbox, 'board report')} to read` : org.cycle.stage === 'work' ? 'No plan in progress' : 'Awaiting the CEO’s direction';
  } else if (plan.status === 'done') {
    lamp = 'done';
    line = 'Reported to the board';
  } else if (plan.status === 'failed' || plan.status === 'cancelled') {
    line = plan.status === 'failed' ? 'The plan failed' : 'The plan was cancelled';
  } else if (plan.status === 'executing') {
    lamp = 'waiting';
    const held = heldBy(org, plan);
    if (held.length) line = `Waits for ${held.map((w) => describeWait(org, w)).join('; ')}`;
    else if (session && session.state !== 'running') line = `Session ${SESSION_STATE[session.state].toLowerCase()}`;
    else if (current) line = `${current.name} · ${phaseLine(current, [], false).replace(/^./, (c) => c.toLowerCase())}`;
    else line = PLAN_STATUS.executing;
  } else {
    lamp = 'waiting';
    line = PLAN_STATUS[plan.status];
  }
  // A paused organisation waits on nothing but being resumed.
  if (!running && lamp === 'waiting') lamp = 'idle';

  return {
    kind: 'department',
    id: departmentId(lead.id),
    seatId: lead.id,
    rect: place.rect,
    door: place.door,
    doorIn: place.doorIn,
    title: lead.function,
    short: lead.short,
    hue: lead.hue,
    lamp,
    line,
    pins: { you: 0, trouble: 0 },
    lead: thinking.map((a) => a.label),
    desks,
    beyond,
    inRuns,
    track: plan ? track(org, plan, active) : null,
    profile: lead.phases.map((p) => p.name),
    queued: Math.max(0, open.length - (plan && live(plan) ? 1 : 0)),
    inbox,
    spendUsd: org.usageByExec[lead.id]?.costUsd ?? 0,
  };
}

function boardroom(org: Organisation, active: ActiveWork[], place: Place, running: boolean): Boardroom {
  const short = (id: string) => org.executives.find((e) => e.id === id)?.short ?? id;
  const matters: Matter[] = [];
  for (const d of org.decisions) {
    if (d.kind !== 'contested' || d.status === 'resolved') continue;
    const owner = org.plans.find((p) => p.id === d.planId)?.ownerId;
    const awaited = d.status === 'answering' ? (owner ? [owner] : []) : d.status === 'open' ? d.participantIds.filter((id) => !d.positions[id]) : [];
    const marks: Record<string, SeatMark> = {};
    for (const [id, position] of Object.entries(d.positions)) marks[id] = position.stance;
    for (const id of awaited) marks[id] = 'awaited';
    matters.push({
      id: `board/decision/${d.id}`,
      kind: 'decision',
      title: d.title,
      line: d.status === 'answering' ? `Waiting for the ${owner ? short(owner) : 'plan’s owner'} to answer` : d.status === 'deliberated' ? 'Waiting for the ruling' : awaited.length ? `Waiting for ${awaited.map(short).join(', ')}` : 'Positions are in',
      planIds: d.planId ? [d.planId] : [],
      marks,
    });
  }
  for (const round of org.reviewRounds) {
    if (round.status !== 'open') continue;
    const marks: Record<string, SeatMark> = {};
    for (const id of round.reviewerIds) marks[id] = round.reviews[id] ? (round.reviews[id]!.length ? 'objects' : 'no_objection') : 'awaited';
    const reviewed = round.reviewerIds.filter((id) => round.reviews[id]).length;
    matters.push({
      id: `board/round/${round.id}`,
      kind: 'round',
      title: `${plural(round.planIds.length, 'plan')} before the board`,
      line: `${reviewed} of ${plural(round.reviewerIds.length, 'review')} in`,
      planIds: round.planIds,
      marks,
    });
  }
  const atBoard = active.filter((a) => a.kind === 'review' || a.kind === 'answer' || a.kind === 'position' || a.kind === 'signoff');
  const first = matters[0];
  const seats: BoardSeat[] = org.executives
    .filter((e) => e.kind !== 'signatory')
    .map((e) => ({ seatId: e.id, short: e.short, hue: e.hue, label: atBoard.find((a) => a.execId === e.id)?.label ?? null, mark: first?.marks[e.id] ?? null }));
  const lamp: Lamp = atBoard.length ? 'working' : matters.length && running ? 'waiting' : 'idle';
  return {
    kind: 'board',
    id: 'board',
    rect: place.rect,
    door: place.door,
    doorIn: place.doorIn,
    title: 'Boardroom',
    short: 'Board',
    hue: 220,
    lamp,
    line: first ? (matters.length > 1 ? `${first.title} · and ${matters.length - 1} more` : first.title) : 'Not sitting',
    pins: { you: 0, trouble: 0 },
    seats,
    matters,
  };
}

/** What happened lately, newest first: what was said at the board, and what agents finished. */
function dispatches(org: Organisation): Dispatch[] {
  const target = (m: BoardMessage): string => {
    if (m.requestId) return org.signatory.requests.some((r) => r.id === m.requestId) ? `signatory/request/${m.requestId}` : 'signatory';
    if (m.decisionId && org.decisions.some((d) => d.id === m.decisionId && d.status !== 'resolved')) return `board/decision/${m.decisionId}`;
    if (m.type === 'steer' || m.type === 'steer_response') return 'shareholders';
    if (m.type === 'decision' || m.type === 'review') return 'board';
    const plan = m.planId ? org.plans.find((p) => p.id === m.planId) : undefined;
    if (plan) return `${departmentId(plan.ownerId)}/plan/${plan.id}`;
    const from = org.executives.find((e) => e.id === m.fromId);
    return from?.kind === 'lead' ? departmentId(from.id) : from?.kind === 'ceo' ? 'ceo' : from?.kind === 'judge' ? 'judge' : from?.kind === 'signatory' ? 'signatory' : 'board';
  };
  const list: Dispatch[] = org.board.slice(-80).map((m) => ({ id: m.id, at: m.at, seatId: m.fromId, label: MESSAGE_LABEL[m.type], title: m.title, target: target(m), tone: 'plain' }));
  for (const plan of org.plans) {
    if (plan.cycle !== org.cycle.number) continue;
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        if (!task.finishedAt || (task.status !== 'done' && task.status !== 'failed')) continue;
        list.push({
          id: `task:${task.id}:${task.finishedAt}`,
          at: task.finishedAt,
          seatId: plan.ownerId,
          label: task.status === 'done' ? (task.agent ? `Agent ${task.agent} finished` : 'Task finished') : task.agent ? `Agent ${task.agent} failed` : 'Task failed',
          title: task.title,
          target: task.agent && task.agent <= (org.executives.find((e) => e.id === plan.ownerId)?.agentCount ?? 0) ? `${departmentId(plan.ownerId)}/agent/${task.agent}` : `${departmentId(plan.ownerId)}/plan/${plan.id}`,
          tone: task.status === 'done' ? 'good' : 'trouble',
        });
      }
    }
  }
  return list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80);
}

/** The whole headquarters as it stands: every room and what is happening in it, what is on its way, and what needs a person. */
export function survey(view: OrgView, now = Date.now()): Scene {
  const { org, active, draining, pace } = view;
  const at = plot(org);
  const running = org.status === 'running' || draining;
  const seat = (kind: Executive['kind']) => org.executives.find((e) => e.kind === kind);
  const ceo = seat('ceo');
  const judge = seat('judge');
  const signatory = seat('signatory');
  const leads = org.executives.filter((e) => e.kind === 'lead');
  const short = (id: string) => org.executives.find((e) => e.id === id)?.short ?? id;
  const doing = (id: string | undefined) => (id ? active.filter((a) => a.execId === id).map((a) => a.label) : []);
  const office = (id: Office['kind'], fields: Omit<Office, 'kind' | 'id' | 'rect' | 'door' | 'doorIn' | 'pins'>): Office => ({
    kind: id,
    id,
    rect: at.rooms[id]!.rect,
    door: at.rooms[id]!.door,
    doorIn: at.rooms[id]!.doorIn,
    pins: { you: 0, trouble: 0 },
    ...fields,
    // A paused organisation waits on nothing but being resumed.
    lamp: !running && fields.lamp === 'waiting' ? 'idle' : fields.lamp,
  });

  const rooms: Room[] = [];
  const alerts: Alert[] = [];

  // The shareholders: what they last said, and whether the CEO has taken it up.
  const fresh = org.steers.filter((s) => s.status === 'new');
  rooms.push(
    office('shareholders', {
      title: 'Shareholders',
      short: 'You',
      hue: 40,
      seatId: null,
      doing: [],
      lamp: fresh.length ? 'waiting' : 'idle',
      line: fresh.length ? `${plural(fresh.length, 'steer')} with the CEO` : org.steers.length ? 'The CEO has answered your steer' : 'No steer yet',
      figure: org.steers.length ? { value: org.steers.length, label: org.steers.length === 1 ? 'steer' : 'steers' } : null,
    }),
  );

  if (ceo) {
    const mine = doing(ceo.id);
    const heard = leads.filter((l) => org.cycle.consults[l.id]).length;
    rooms.push(
      office('ceo', {
        title: 'CEO’s office',
        short: ceo.short,
        hue: ceo.hue,
        seatId: ceo.id,
        doing: mine,
        lamp: mine.length ? 'working' : org.status === 'running' && org.business.waiting ? 'waiting' : 'idle',
        line: mine[0] ?? (org.status === 'idle' ? 'Waiting to be started' : org.status === 'running' && org.business.waiting ? 'Waiting for scheduled work' : org.cycle.stage === 'consult' ? `${heard} of ${plural(leads.length, 'proposal')} in` : org.cycle.stage === 'direct' ? 'Deciding what the shareholders want' : 'The leads are at work on its direction'),
        figure: { value: org.cycle.number, label: 'cycle' },
        steps: { names: STAGES.map((s) => s.label), current: STAGES.findIndex((s) => s.id === org.cycle.stage) },
      }),
    );
  }

  rooms.push(boardroom(org, active, at.rooms.board!, running));

  if (signatory) {
    const mine = doing(signatory.id);
    const forYou = waitingOnPerson(org);
    const withAi = org.signatory.requests.filter((r) => waitsOnAi(r, org.settings.signatory)).length;
    rooms.push(
      office('signatory', {
        title: 'Signing desk',
        short: signatory.short,
        hue: signatory.hue,
        seatId: signatory.id,
        doing: mine,
        lamp: mine.length ? 'working' : forYou.length || withAi ? 'waiting' : 'idle',
        line: mine[0] ?? (forYou.length ? `${plural(forYou.length, 'request')} waiting for you` : withAi ? `${plural(withAi, 'request')} with the AI signatory` : 'Nothing to sign or pay'),
        figure: forYou.length ? { value: forYou.length, label: 'for you' } : null,
      }),
    );
    for (const r of forYou) {
      alerts.push({ severity: 'you', title: describeRequest(r), detail: `Asked by the ${short(r.fromId)}. ${r.status === 'authorised' ? 'The AI signatory authorised it, and it waits for you to carry it out.' : 'It waits for you to do it, or to turn it down.'}`, target: `signatory/request/${r.id}` });
    }
  }

  if (judge) {
    const mine = doing(judge.id);
    rooms.push(office('judge', { title: 'Chambers', short: judge.short, hue: judge.hue, seatId: judge.id, doing: mine, lamp: mine.length ? 'working' : 'idle', line: mine[0] ?? 'Rules when leads disagree', figure: null }));
  }

  const departments = leads.map((lead) => department(org, lead, active, at.rooms[departmentId(lead.id)]!, running));
  rooms.push(...departments);

  // The memory: how often it has been put to use this cycle.
  const uses = (org.memoryUses ?? []).filter((u) => u.cycle === org.cycle.number);
  rooms.push(
    office('archive', {
      title: 'Memory',
      short: 'Memory',
      hue: 265,
      seatId: null,
      doing: [],
      lamp: 'idle',
      line: uses.length ? `Used ${uses.length === 1 ? 'once' : `${uses.length} times`} this cycle` : 'Not used yet this cycle',
      figure: uses.length ? { value: uses.length, label: uses.length === 1 ? 'use' : 'uses' } : null,
    }),
  );

  // The workspace: what this cycle's work has written.
  const written = new Set<string>();
  for (const plan of org.plans) if (plan.cycle === org.cycle.number) for (const phase of plan.phases) for (const task of phase.tasks) for (const file of task.files) written.add(file);
  rooms.push(
    office('files', {
      title: 'Files',
      short: 'Files',
      hue: 175,
      seatId: null,
      doing: [],
      lamp: 'idle',
      line: written.size ? `${plural(written.size, 'file')} written this cycle` : 'Nothing written yet this cycle',
      figure: written.size ? { value: written.size, label: written.size === 1 ? 'file' : 'files' } : null,
    }),
  );

  // Operations: the commitments on the calendar.
  const jobs = org.business.jobs.filter((j) => j.status !== 'done' && j.status !== 'cancelled');
  const toVerify = jobs.filter((j) => j.status === 'review');
  const overdue = jobs.filter((j) => j.dueAt && Date.parse(j.dueAt) < now);
  rooms.push(
    office('operations', {
      title: 'Operations',
      short: 'Ops',
      hue: 200,
      seatId: null,
      doing: [],
      lamp: 'idle',
      line: jobs.length ? [plural(jobs.length, 'open commitment'), overdue.length ? `${overdue.length} overdue` : '', toVerify.length ? `${toVerify.length} to verify` : ''].filter(Boolean).join(' · ') : 'No open commitments',
      figure: jobs.length ? { value: jobs.length, label: 'open' } : null,
    }),
  );
  for (const job of toVerify) alerts.push({ severity: 'you', title: `Verify: ${job.title}`, detail: 'The work is reported as delivered. It counts as done once you have checked it.', target: 'operations' });
  for (const job of overdue) alerts.push({ severity: 'trouble', title: `Overdue: ${job.title}`, detail: job.blockedReason || job.nextAction || 'Past its date.', target: 'operations' });

  // What stands in the way of the whole organisation comes first.
  const calls = active.filter((a) => a.kind !== 'execute').length;
  const awaitingStep = org.status === 'running' && org.settings.pace === 'step' && calls === 0 && pace.next.length > 0;
  const whole: Alert[] = [];
  if (org.status === 'paused' && org.pauseReason === 'error') whole.push({ severity: 'trouble', title: 'Paused: an operation failed', detail: `${org.lastError ?? ''} Nothing was lost: put the cause right, then resume.`.trim(), target: null });
  else if (org.status === 'paused' && org.pauseReason === 'budget') whole.push({ severity: 'you', title: 'Paused: the budget is spent', detail: 'Raise the budget in the settings to let it continue.', target: null });
  else if (org.status === 'paused' && org.pauseReason === 'cycle_limit') whole.push({ severity: 'you', title: 'Paused: the cycle limit is reached', detail: 'Raise or remove the limit in the settings to let it continue.', target: null });
  else if (org.status === 'paused' && org.pauseReason === 'restart') whole.push({ severity: 'you', title: 'Paused: the server restarted', detail: 'Resume and it carries on from where it stopped.', target: null });
  else if (org.status === 'idle') whole.push({ severity: 'you', title: 'Not started', detail: 'Start the organisation and the CEO opens the first cycle.', target: null });
  else if (awaitingStep) whole.push({ severity: 'you', title: 'Waiting for your next step', detail: `Next: ${short(pace.next[0]!.execId)} · ${pace.next[0]!.label}`, target: null });
  alerts.unshift(...whole);

  for (const room of departments) {
    for (const plan of org.plans.filter((p) => p.ownerId === room.seatId && live(p))) {
      for (const [index, phase] of plan.phases.entries()) {
        if (phase.status !== 'working') continue;
        const where = `${room.id}/phase/${plan.id}/${index}`;
        const failed = phase.tasks.filter((t) => t.status === 'failed');
        if (failed.length) alerts.push({ severity: 'trouble', title: `${room.short} ${phase.name}: ${plural(failed.length, 'task')} failed`, detail: failed.map((t) => `${t.title}: ${t.error ?? 'no reason given'}`).join(' · '), target: where });
        if (phase.evidence?.state === 'failed') alerts.push({ severity: 'trouble', title: `${room.short} ${phase.name}: the system’s check did not pass`, detail: phase.evidence.summary, target: where });
        else if (phase.reworkRounds > 0) alerts.push({ severity: 'held', title: `${room.short} ${phase.name}: sent back for rework`, detail: phase.summary ?? plan.objective, target: where });
      }
      if (plan.managed?.state === 'at_budget') alerts.push({ severity: 'trouble', title: `${room.short}: the session is at its spend cap`, detail: plan.objective, target: `${room.id}/plan/${plan.id}` });
      if (plan.managed?.adrift) alerts.push({ severity: 'trouble', title: `${room.short}: a session is running unwatched`, detail: 'The server stopped while it was followed. It is held as soon as the provider can be reached.', target: `${room.id}/plan/${plan.id}` });
      const held = heldBy(org, plan);
      if (held.length) alerts.push({ severity: 'held', title: `${room.short} waits for ${held.map((w) => describeWait(org, w)).join('; ')}`, detail: plan.objective, target: `${room.id}/plan/${plan.id}` });
    }
    if (room.track?.status === 'failed') alerts.push({ severity: 'trouble', title: `${room.short}: the plan failed`, detail: room.track.objective, target: room.track.id });
  }
  const board = rooms.find((r): r is Boardroom => r.kind === 'board')!;
  for (const matter of board.matters) if (matter.kind === 'decision') alerts.push({ severity: 'held', title: `Before the board: ${matter.title}`, detail: `${matter.line}. The plan does not start until it is settled.`, target: matter.id });

  // What is on its way between rooms. One line for each pair of rooms and kind of thing, whatever number of them there is.
  const flows: Flow[] = [];
  const flow = (kind: FlowKind, from: string, to: string, label: string, state: Flow['state']) => {
    const id = `${kind}:${from}>${to}`;
    // What is being worked on is drawn before what stands, so the first of a pair is the one that says most.
    if (flows.some((f) => f.id === id) || !at.rooms[from] || !at.rooms[to]) return;
    flows.push({ id, kind, from, to, label, state, points: [] });
  };
  if (fresh.length && ceo) flow('steer', 'shareholders', 'ceo', `${plural(fresh.length, 'steer')} for the CEO`, active.some((a) => a.kind === 'steer_review') ? 'moving' : 'waiting');
  for (const a of active) {
    const from = org.executives.find((e) => e.id === a.execId);
    const home = from?.kind === 'lead' ? departmentId(from.id) : from?.kind === 'ceo' ? 'ceo' : from?.kind === 'judge' ? 'judge' : null;
    if (!home) continue;
    if (a.kind === 'consult') flow('proposal', home, 'ceo', `The ${from!.short}’s proposal for the CEO`, 'moving');
    else if (a.kind === 'review' || a.kind === 'answer' || a.kind === 'position' || a.kind === 'signoff') flow('board', home, 'board', `${from!.short}: ${a.label}`, 'moving');
    else if (a.kind === 'report') flow('report', home, 'board', `The ${from!.short}’s report to the board`, 'moving');
    else if (a.kind === 'react') flow('reports', 'board', home, `Board reports for the ${from!.short}`, 'moving');
  }
  for (const plan of org.plans) {
    if (BEFORE_BOARD.has(plan.status)) flow('plan', departmentId(plan.ownerId), 'board', `The ${short(plan.ownerId)}’s plan is before the board`, 'waiting');
    else if (plan.status === 'reporting') flow('report', departmentId(plan.ownerId), 'board', `The ${short(plan.ownerId)}’s report to the board`, 'waiting');
    for (const wait of heldBy(org, plan)) flow('wait', departmentId(wait.leadId), departmentId(plan.ownerId), `The ${short(plan.ownerId)} waits for ${describeWait(org, wait)}`, 'waiting');
  }
  for (const r of org.signatory.requests.filter(isOpen)) {
    flow('request', departmentId(r.fromId), 'signatory', `${r.kind === 'payment' ? 'A payment' : 'A signature'} the ${short(r.fromId)} asked for`, waitsOnAi(r, org.settings.signatory) ? 'waiting' : 'you');
  }
  // A paused organisation moves nothing.
  flows.forEach((f, i) => {
    if (!running && f.state === 'moving') f.state = 'waiting';
    f.points = route(at, f.from, f.to, (i % 5) - 2);
  });

  const cyclePlans = org.plans.filter((p) => p.cycle === org.cycle.number && p.status !== 'cancelled');
  const open = org.plans.filter(live);
  const situation: Situation = {
    state: org.status === 'running' ? (org.business.waiting ? 'waiting_schedule' : awaitingStep ? 'waiting_step' : 'running') : draining ? 'pausing' : org.status === 'idle' ? 'idle' : 'paused',
    agents: { working: departments.reduce((sum, d) => sum + d.desks.filter((k) => k.busy).length + d.beyond + d.inRuns, 0), total: leads.reduce((sum, l) => sum + l.agentCount, 0) },
    seats: new Set(active.filter((a) => a.kind !== 'task').map((a) => a.execId)).size,
    plans: {
      live: open.length,
      drafting: open.filter((p) => p.status === 'planning').length,
      beforeBoard: open.filter((p) => BEFORE_BOARD.has(p.status)).length,
      underWay: open.filter((p) => p.status === 'approved' || p.status === 'executing' || p.status === 'reporting').length,
      reported: cyclePlans.filter((p) => p.status === 'done').length,
    },
    phases: { done: cyclePlans.reduce((sum, p) => sum + p.phases.filter((ph) => ph.status === 'done').length, 0), total: cyclePlans.reduce((sum, p) => sum + p.phases.length, 0) },
    decisions: board.matters.filter((m) => m.kind === 'decision').length,
    needsYou: alerts.filter((a) => a.severity === 'you').length,
    trouble: alerts.filter((a) => a.severity === 'trouble').length,
  };

  const order = { you: 0, trouble: 1, held: 2 } as const;
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  // A room is pinned with what in it needs a person, and what in it has gone wrong.
  for (const room of rooms) {
    const here = alerts.filter((a) => a.target !== null && roomOf(a.target) === room.id);
    room.pins = { you: here.filter((a) => a.severity === 'you').length, trouble: here.filter((a) => a.severity === 'trouble').length };
  }
  return { plot: at, rooms, flows, alerts, situation, dispatches: dispatches(org) };
}
