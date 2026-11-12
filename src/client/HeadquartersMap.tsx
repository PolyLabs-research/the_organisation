import { Bell, CalendarDays, Check, FolderOpen, Gavel, Hourglass, Library, Lock, Maximize2, Megaphone, Minimize2, Minus, PenLine, Plus, Scale, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  ZOOM,
  fit,
  fitText,
  inView,
  keepInView,
  roomOf,
  wrapText,
  zoomAt,
  textWidth,
  type AgentDesk,
  type Boardroom,
  type Camera,
  type Department,
  type Flow,
  type Lamp,
  type Office,
  type Point,
  type Rect,
  type Room,
  type Scene,
  type SeatMark,
  type Station,
} from './headquarters';

// The headquarters drawn as a map. The building keeps its shape at every distance and its words keep their size:
// seen from afar a room shows its name, whether anyone is at work in it and what needs a person, and the nearer it
// is looked at the more of what is written there it has room for. What the words are cut from is in the panel beside it.

/** Below this, a room is seen from afar, and shows only what can be read from there. */
const FAR = 0.62;
/** From this, what a desk is working on has room to be read. */
const NEAR = 1.55;
/** How long the map takes to move to something that was asked for. */
const FLIGHT_MS = 340;
/** What is kept clear round the building when the whole of it is shown: at the top, room for what lies over the map. */
const EDGE = { top: 52, right: 14, bottom: 16, left: 14 };
/** How long a room is marked for after something has happened in it. */
export const FLASH_MS = 2400;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const scale = (rect: Rect, k: number): Rect => ({ x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k });
const domId = (id: string): string => 'hq-' + id.replace(/[^A-Za-z0-9]+/g, '-');
const hue = (h: number): CSSProperties => ({ '--h': String(h) }) as CSSProperties;

export type MapLevel = 'building' | 'rooms' | 'desks';
export const levelOf = (k: number): MapLevel => (k < FAR ? 'building' : k < NEAR ? 'rooms' : 'desks');

type Select = (target: string, zoom?: boolean) => void;

/** A line through `points` with its corners rounded, as an SVG path. */
function trace(points: Point[], radius: number): string {
  if (points.length < 2) return '';
  let d = `M${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const into = Math.hypot(b.x - a.x, b.y - a.y);
    const out = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, into / 2, out / 2);
    if (r < 0.5) {
      d += ` L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      continue;
    }
    d += ` L${(b.x - ((b.x - a.x) / into) * r).toFixed(1)} ${(b.y - ((b.y - a.y) / into) * r).toFixed(1)} Q${b.x.toFixed(1)} ${b.y.toFixed(1)} ${(b.x + ((c.x - b.x) / out) * r).toFixed(1)} ${(b.y + ((c.y - b.y) / out) * r).toFixed(1)}`;
  }
  const last = points[points.length - 1]!;
  return d + ` L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}

const LAMP_WORDS: Record<Lamp, string> = { working: 'At work', waiting: 'Waiting', done: 'Finished', idle: '' };

function LampGlyph({ lamp, x, y, size }: { lamp: Lamp; x: number; y: number; size: number }) {
  if (lamp === 'working') {
    return (
      <g className="hq-lamp hq-lamp-working">
        <circle className="hq-lamp-ring" cx={x} cy={y} r={size * 0.5} />
        <circle cx={x} cy={y} r={size * 0.28} />
      </g>
    );
  }
  if (lamp === 'waiting') return <Hourglass className="hq-lamp hq-lamp-waiting" x={x - size / 2} y={y - size / 2} width={size} height={size} aria-hidden="true" />;
  if (lamp === 'done') return <Check className="hq-lamp hq-lamp-done" x={x - size / 2} y={y - size / 2} width={size} height={size} strokeWidth={3} aria-hidden="true" />;
  return null;
}

/** Someone at the place: a head and shoulders, seen from the front. `u` is its size, where 1 is about a text line high. */
function Person({ x, y, u, busy, lead = false }: { x: number; y: number; u: number; busy: boolean; lead?: boolean }) {
  return (
    <g className={`hq-person${busy ? ' is-busy' : ''}${lead ? ' is-lead' : ''}`}>
      <path d={`M${x - 5.6 * u} ${y} a${5.6 * u} ${6.8 * u} 0 0 1 ${11.2 * u} 0 z`} />
      <circle cx={x} cy={y - 10.4 * u} r={3.3 * u} />
    </g>
  );
}

/** A desk with whoever sits at it, and a screen that is lit while they work. `(x, y)` is the middle of the desk's top edge. */
function Desk({ x, y, u, busy, lead = false }: { x: number; y: number; u: number; busy: boolean; lead?: boolean }) {
  return (
    <g className="hq-desk">
      <Person x={x - 2.5 * u} y={y} u={u} busy={busy} lead={lead} />
      <rect className={`hq-screen${busy ? ' is-busy' : ''}`} x={x + 3.5 * u} y={y - 6.4 * u} width={7.4 * u} height={5.6 * u} rx={u} />
      <rect className="hq-desk-lip" x={x - 11.5 * u} y={y + 3.6 * u} width={23 * u} height={2.2 * u} rx={u * 0.8} />
      <rect className="hq-desk-top" x={x - 11.5 * u} y={y - 0.4 * u} width={23 * u} height={4.4 * u} rx={u * 1.2} />
    </g>
  );
}

function Pins({ room, r }: { room: Room; r: Rect }) {
  const pins: Array<{ kind: 'you' | 'trouble'; count: number }> = [];
  if (room.pins.trouble) pins.push({ kind: 'trouble', count: room.pins.trouble });
  if (room.pins.you) pins.push({ kind: 'you', count: room.pins.you });
  let x = r.x + r.w + 5;
  return (
    <>
      {pins.map((pin) => {
        const text = String(pin.count);
        const w = 23 + textWidth(text, 11, true);
        x -= w + 3;
        const Icon = pin.kind === 'you' ? Bell : TriangleAlert;
        return (
          <g key={pin.kind} className={`hq-pin hq-pin-${pin.kind}`}>
            <rect x={x} y={r.y - 10} width={w} height={19} rx={9.5} />
            <Icon x={x + 6} y={r.y - 6} width={11} height={11} strokeWidth={2.6} aria-hidden="true" />
            <text x={x + 19.5} y={r.y - 0.2} fontSize={11} dominantBaseline="central">
              {text}
            </text>
          </g>
        );
      })}
    </>
  );
}

const MARK_GLYPH: Record<SeatMark, LucideIcon> = { back_plan: Check, no_objection: Check, back_objection: X, objects: X, compromise: Scale, awaited: Hourglass };
const MARK_TONE: Record<SeatMark, string> = { back_plan: 'for', no_objection: 'for', back_objection: 'against', objects: 'against', compromise: 'between', awaited: 'awaited' };

const STATION_WORDS = { done: 'done', working: 'under way', pending: 'not started' } as const;

function StationMark({ station, x, y, radius, selected, onSelect, live }: { station: Station; x: number; y: number; radius: number; selected: boolean; onSelect: Select | null; live: boolean }) {
  const failed = station.gate?.state === 'failed' || (station.status === 'working' && station.tasks.failed > 0);
  const share = station.tasks.total ? (station.tasks.done + station.tasks.failed) / station.tasks.total : 0;
  const around = 2 * Math.PI * radius;
  const GateIcon = station.gate ? (station.gate.state === 'passed' ? Check : station.gate.state === 'failed' ? X : station.gate.state === 'waiting' ? Hourglass : Lock) : null;
  const g = Math.max(4.6, radius * 0.62);
  return (
    <g
      className={`hq-station is-${station.status}${failed ? ' is-failed' : ''}${selected ? ' is-selected' : ''}${onSelect ? ' is-pressable' : ''}`}
      data-hq={onSelect ? station.id : undefined}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              onSelect(station.id);
            }
          : undefined
      }
    >
      <title>{`${station.name}: ${station.line}`}</title>
      {onSelect ? <circle className="hq-hit" cx={x} cy={y} r={Math.max(13, radius + 5)} /> : null}
      {selected ? <circle className="hq-chosen" cx={x} cy={y} r={radius + 4.5} /> : null}
      <circle className="hq-station-disc" cx={x} cy={y} r={radius} />
      {station.status === 'working' && !failed ? (
        <>
          {share > 0 ? <circle className="hq-station-share" cx={x} cy={y} r={radius} strokeDasharray={`${(around * share).toFixed(1)} ${around.toFixed(1)}`} transform={`rotate(-90 ${x} ${y})`} /> : null}
          <circle className={`hq-station-core${live && station.tasks.running ? ' is-live' : ''}`} cx={x} cy={y} r={radius * 0.36} />
        </>
      ) : null}
      {station.status === 'done' ? <Check className="hq-station-glyph" x={x - radius * 0.62} y={y - radius * 0.62} width={radius * 1.24} height={radius * 1.24} strokeWidth={3.4} aria-hidden="true" /> : null}
      {failed ? <X className="hq-station-glyph" x={x - radius * 0.6} y={y - radius * 0.6} width={radius * 1.2} height={radius * 1.2} strokeWidth={3.4} aria-hidden="true" /> : null}
      {station.gate && GateIcon ? (
        <g className={`hq-gate is-${station.gate.state}`}>
          <circle cx={x + radius * 0.95} cy={y - radius * 0.95} r={g} />
          <GateIcon x={x + radius * 0.95 - g * 0.62} y={y - radius * 0.95 - g * 0.62} width={g * 1.24} height={g * 1.24} strokeWidth={3} aria-hidden="true" />
        </g>
      ) : null}
    </g>
  );
}

/** A plan as the line of phases it runs through, drawn in the box given. With no plan, the lead's operating profile as an empty line. */
function TrackLine({ room, box, k, selected, onSelect, live }: { room: Department; box: Rect; k: number; selected: string | null; onSelect: Select; live: boolean }) {
  const far = k < FAR;
  const stations: Station[] =
    room.track?.stations ??
    room.profile.map((name, index) => ({ id: '', index, name, status: 'pending' as const, tasks: { done: 0, running: 0, failed: 0, total: 0 }, gate: null, rework: 0, line: 'No plan in progress' }));
  if (!stations.length) return null;
  const radius = far ? clamp(5.5 * k, 3, 5) : clamp(7 * k, 5.5, 11);
  const fs = clamp(10 * k, 9.5, 12);
  const span = box.w - radius * 2 - (stations.some((s) => s.gate) ? radius : 0);
  const at = (i: number) => box.x + radius + (stations.length === 1 ? span / 2 : (span * i) / (stations.length - 1));
  // Each phase is named under its station, the first and last moved in so as to stay inside the room. They are all
  // named or none is: a name cut short, or run into the next, says less than the line without it.
  const nameW = stations.map((s) => textWidth(s.name, fs));
  const nameX = stations.map((_, i) => clamp(at(i), box.x + nameW[i]! / 2, box.x + box.w - nameW[i]! / 2));
  const named = !far && nameX.every((x, i) => nameW[i]! <= box.w && (i === 0 || x - nameW[i]! / 2 - (nameX[i - 1]! + nameW[i - 1]! / 2) >= 4));
  const objective = !far && room.track ? fitText(room.track.objective, box.w - (room.queued ? 30 : 0), clamp(11 * k, 10, 12.5)) : '';
  const titleH = objective ? clamp(11 * k, 10, 12.5) * 1.5 : 0;
  const cy = far ? box.y + box.h / 2 : box.y + titleH + radius + (named ? 3 : (box.h - titleH) / 2 - radius);
  const ofPlan = room.track ? selected === room.track.id : false;
  return (
    <g className={`hq-track${room.track ? '' : ' is-empty'}`}>
      {objective ? (
        <g
          className={`hq-objective is-pressable${ofPlan ? ' is-selected' : ''}`}
          data-hq={room.track!.id}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(room.track!.id);
          }}
        >
          <title>{room.track!.objective}</title>
          <rect className="hq-hit" x={box.x - 3} y={box.y - 3} width={box.w + 6} height={titleH + 4} rx={4} />
          <text className="hq-t1" x={box.x} y={box.y + titleH * 0.42} fontSize={clamp(11 * k, 10, 12.5)} dominantBaseline="central">
            {objective}
          </text>
          {room.queued ? (
            <text className="hq-t3" x={box.x + box.w} y={box.y + titleH * 0.42} fontSize={clamp(10 * k, 9.5, 11.5)} textAnchor="end" dominantBaseline="central">
              +{room.queued}
            </text>
          ) : null}
        </g>
      ) : null}
      {stations.slice(1).map((s, i) => (
        <line key={s.index} className={`hq-rail${stations[i]!.status === 'done' ? ' is-done' : ''}`} x1={at(i) + radius} y1={cy} x2={at(i + 1) - radius} y2={cy} />
      ))}
      {stations.map((s, i) => (
        <g key={s.index}>
          <StationMark station={s} x={at(i)} y={cy} radius={radius} selected={!!s.id && selected === s.id} onSelect={!far && s.id ? onSelect : null} live={live} />
          {named ? (
            <text className={s.status === 'working' ? 'hq-t1' : 'hq-t3'} x={nameX[i]} y={cy + radius + fs * 0.95} fontSize={fs} textAnchor="middle" dominantBaseline="central">
              {s.name}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  );
}

function DeskCell({ desk, box, k, selected, onSelect }: { desk: AgentDesk; box: Rect; k: number; selected: boolean; onSelect: Select | null }) {
  const u = clamp(k * 1.1, 0.82, 1.7);
  const fs = clamp(10 * k, 9.5, 12.5);
  const wide = box.w >= DESK_WITH_WORDS;
  const artW = 25 * u;
  const cx = wide ? box.x + artW / 2 + 2 : box.x + box.w / 2;
  // The desk stands in the upper part of its cell, so that its number has room below it.
  const deskY = wide ? box.y + Math.min(box.h / 2 + 4 * u, 17 * u) : box.y + Math.min(box.h * 0.55, 16 * u);
  const textX = box.x + artW + 9;
  const textW = box.x + box.w - textX - 2;
  const lines = wide ? Math.max(1, Math.min(4, Math.floor((box.h - fs * 1.35) / (fs * 1.22)))) : 0;
  const label = wide ? (desk.busy && desk.label ? wrapText(desk.label, textW, fs, lines) : []) : [];
  return (
    <g
      className={`hq-cell${desk.busy ? ' is-busy' : ''}${selected ? ' is-selected' : ''}${onSelect ? ' is-pressable' : ''}`}
      data-hq={onSelect ? desk.id : undefined}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              onSelect(desk.id);
            }
          : undefined
      }
    >
      <title>{`Agent ${desk.agent}: ${desk.busy ? (desk.label ?? 'working') : 'idle'}`}</title>
      {onSelect ? <rect className="hq-hit" x={box.x} y={box.y} width={box.w} height={box.h} rx={5} /> : null}
      {selected ? <rect className="hq-chosen" x={box.x + 1} y={box.y + 1} width={box.w - 2} height={box.h - 2} rx={5} /> : null}
      <Desk x={cx} y={deskY} u={u} busy={desk.busy} />
      {wide ? (
        <>
          <text className="hq-t2 hq-strong" x={textX} y={box.y + fs * 0.8} fontSize={fs} dominantBaseline="central">
            Agent {desk.agent}
          </text>
          {label.length ? (
            label.map((line, i) => (
              <text key={i} className="hq-t1" x={textX} y={box.y + fs * 0.8 + fs * 1.22 * (i + 1)} fontSize={fs} dominantBaseline="central">
                {line}
              </text>
            ))
          ) : (
            <text className="hq-t3" x={textX} y={box.y + fs * 0.8 + fs * 1.22} fontSize={fs} dominantBaseline="central">
              {desk.busy ? 'Working' : 'Idle'}
            </text>
          )}
        </>
      ) : (
        <text className={desk.busy ? 'hq-t1 hq-strong' : 'hq-t3'} x={cx} y={deskY + 6 * u + fs * 0.95} fontSize={fs} textAnchor="middle" dominantBaseline="central">
          {desk.agent}
        </text>
      )}
    </g>
  );
}

/** How wide a desk's place must be for what its agent is doing to be written beside it. */
const DESK_WITH_WORDS = 104;

/**
 * The columns a department's desks stand in. As few as leave every agent's work readable beside it, where the room
 * has the height for that many rows; otherwise a grid of desks with their numbers, and the words are a step nearer.
 */
function deskColumns(count: number, width: number, height: number, rowHeight: number): number {
  for (let cols = 1; cols <= 4; cols++) {
    if (width / cols >= DESK_WITH_WORDS && Math.ceil(count / cols) * rowHeight <= height) return cols;
  }
  return count <= 2 ? Math.max(1, count) : count <= 4 ? 2 : count <= 6 ? 3 : 4;
}

function DepartmentBody({ room, r, top, k, selected, onSelect, live }: { room: Department; r: Rect; top: number; k: number; selected: string | null; onSelect: Select; live: boolean }) {
  const far = k < FAR;
  const pad = clamp(10 * k, 5, 14);
  const x0 = r.x + pad;
  const w0 = r.w - pad * 2;
  const bottom = r.y + r.h - pad * 0.9;
  const fs = clamp(11.5 * k, 9.5, 12.5);
  const lineY = top + clamp(5 * k, 3, 7);
  const trackH = far ? clamp(20 * k, 10, 14) : clamp(58 * k, 44, 100);
  const trackBox = { x: x0, y: bottom - trackH, w: w0, h: trackH };
  const leadH = far ? 0 : clamp(34 * k, 27, 50);
  const leadY = lineY + fs * 1.5;
  const desksTop = leadY + leadH + (far ? 0 : clamp(4 * k, 2, 8));
  const desksH = Math.max(0, trackBox.y - clamp(6 * k, 3, 10) - desksTop);
  const cols = deskColumns(room.desks.length, w0, desksH, Math.max(24 * clamp(k * 1.1, 0.82, 1.7), clamp(10 * k, 9.5, 12.5) * 2.7));
  const rows = Math.max(1, Math.ceil(room.desks.length / cols));
  const cellW = w0 / cols;
  const cellH = Math.min(desksH / rows, 130 * k);
  const lu = clamp(k * 1.18, 0.9, 1.8);
  // From afar: the lead and then its agents, as people in a row or two, lit where they are at work.
  const pu = clamp(k * 1.9, 0.7, 1.25);
  const perLine = Math.max(1, Math.floor((w0 - 19 * pu) / (13.5 * pu)));
  const crowdH = (Math.ceil(room.desks.length / perLine) - 1) * 18 * pu + 15 * pu;
  const crowdY = Math.max(leadY, leadY + (trackBox.y - leadY - crowdH) / 2 - 2);
  const said = room.lead.length ? room.lead[0]! + (room.lead.length > 1 ? ` (and ${room.lead.length - 1} more)` : '') : room.inbox ? `${room.inbox} board report${room.inbox === 1 ? '' : 's'} to read` : '';
  const bubbleX = x0 + 30 * lu + 6;
  const bubbleW = x0 + w0 - bubbleX;
  const bubbleLines = said ? wrapText(said, bubbleW - 14, fs, leadH >= 40 ? 2 : 1) : [];
  const bubbleH = Math.min(leadH - 2, bubbleLines.length * fs * 1.25 + 9);
  const more = room.beyond + room.inRuns;
  return (
    <>
      <text className="hq-t2" x={x0} y={lineY + fs * 0.55} fontSize={fs} dominantBaseline="central">
        {fitText(room.line, w0, fs)}
      </text>
      {!far ? (
        <g className="hq-lead">
          <Desk x={x0 + 14 * lu} y={leadY + Math.min(leadH - 7 * lu, 15.5 * lu)} u={lu} busy={room.lead.length > 0} lead />
          {bubbleLines.length ? (
            <g className={`hq-bubble${room.lead.length ? ' is-live' : ''}`}>
              <path d={`M${bubbleX - 6} ${leadY + bubbleH / 2 + 1} l7 -4.5 v9 z`} />
              <rect x={bubbleX} y={leadY + 1} width={Math.min(bubbleW, Math.max(...bubbleLines.map((l) => textWidth(l, fs))) + 16)} height={bubbleH} rx={6} />
              {bubbleLines.map((line, i) => (
                <text key={i} className="hq-t1" x={bubbleX + 8} y={leadY + 1 + 4.5 + fs * 0.62 + i * fs * 1.25} fontSize={fs} dominantBaseline="central">
                  {line}
                </text>
              ))}
            </g>
          ) : (
            <text className="hq-t3" x={bubbleX - 2} y={leadY + Math.min(leadH - 7 * lu, 15.5 * lu) - 4 * lu} fontSize={fs} dominantBaseline="central">
              The lead
            </text>
          )}
        </g>
      ) : (
        <g className="hq-crowd">
          <Person x={x0 + 6 * pu} y={crowdY + 15 * pu} u={pu} busy={room.lead.length > 0} lead />
          {room.desks.map((desk, i) => (
            <Person key={desk.id} x={x0 + 25 * pu + (i % perLine) * 13.5 * pu} y={crowdY + 15 * pu + Math.floor(i / perLine) * 18 * pu} u={pu} busy={desk.busy} />
          ))}
        </g>
      )}
      {far
        ? null
        : room.desks.map((desk, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            return <DeskCell key={desk.id} desk={desk} k={k} selected={selected === desk.id} onSelect={onSelect} box={{ x: x0 + col * cellW, y: desksTop + row * cellH, w: cellW, h: cellH }} />;
          })}
      {more && !far ? (
        <text className="hq-t2" x={x0 + w0} y={desksTop + rows * cellH - fs * 0.6} fontSize={fs} textAnchor="end" dominantBaseline="central">
          +{more} in the session
        </text>
      ) : null}
      <TrackLine room={room} box={trackBox} k={k} selected={selected} onSelect={onSelect} live={live} />
    </>
  );
}

function BoardBody({ room, r, top, k, selected, onSelect }: { room: Boardroom; r: Rect; top: number; k: number; selected: string | null; onSelect: Select }) {
  const far = k < FAR;
  const pad = clamp(10 * k, 5, 14);
  const fs = clamp(11.5 * k, 9.5, 12.5);
  const lineY = top + clamp(5 * k, 3, 7);
  const bodyTop = lineY + fs * 1.5;
  const bodyH = r.y + r.h - pad * 0.6 - bodyTop;
  const cx = r.x + r.w / 2;
  const cy = bodyTop + bodyH * (far ? 0.5 : 0.47);
  const u = far ? clamp(k * 1.1, 0.45, 0.8) : clamp(k * 0.95, 0.72, 2.1);
  const tableRx = Math.min(r.w * 0.2, bodyH * 0.62);
  const tableRy = Math.min(bodyH * 0.2, tableRx * 0.5);
  const ringRx = Math.min(r.w / 2 - pad - (far ? 8 : 34) * u, tableRx + 30 * u);
  const ringRy = Math.min(bodyH / 2 - 5 * u, tableRy + 19 * u);
  const first = room.matters[0];
  const labelled = !far;
  const sfs = clamp(9.5 * k, 9, 11.5);
  return (
    <>
      <text className="hq-t2" x={r.x + pad} y={lineY + fs * 0.55} fontSize={fs} dominantBaseline="central">
        {fitText(room.line, r.w - pad * 2, fs)}
      </text>
      <ellipse className="hq-table-lip" cx={cx} cy={cy + 3 * u} rx={tableRx} ry={tableRy} />
      <ellipse className="hq-table" cx={cx} cy={cy} rx={tableRx} ry={tableRy} />
      {first ? (
        <g
          className={`hq-paper is-pressable${selected === first.id ? ' is-selected' : ''}`}
          data-hq={far ? undefined : first.id}
          onClick={
            far
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onSelect(first.id);
                }
          }
        >
          <title>{`${first.title}: ${first.line}`}</title>
          <rect className="hq-hit" x={cx - tableRx} y={cy - tableRy} width={tableRx * 2} height={tableRy * 2} rx={tableRy} />
          <rect className="hq-sheet" x={cx - 7.5 * u} y={cy - 5.4 * u} width={15 * u} height={10.5 * u} rx={1.4 * u} />
          <path className="hq-sheet-lines" d={`M${cx - 4.5 * u} ${cy - 2.2 * u} h${9 * u} M${cx - 4.5 * u} ${cy + 0.4 * u} h${9 * u} M${cx - 4.5 * u} ${cy + 3 * u} h${5.5 * u}`} />
          {room.matters.length > 1 && !far ? (
            <text className="hq-t2 hq-strong" x={cx + 11 * u} y={cy} fontSize={sfs} dominantBaseline="central">
              +{room.matters.length - 1}
            </text>
          ) : null}
        </g>
      ) : null}
      {room.seats.map((seat, i) => {
        // The first seat, which is the CEO's, is at the head of the table.
        const angle = Math.PI + (i * 2 * Math.PI) / room.seats.length;
        const x = cx + Math.cos(angle) * ringRx;
        const y = cy + Math.sin(angle) * ringRy + 5 * u;
        const onLeft = Math.cos(angle) < -0.01;
        const Glyph = seat.mark ? MARK_GLYPH[seat.mark] : null;
        return (
          <g key={seat.seatId} className="hq-seat" style={hue(seat.hue)}>
            <title>{`${seat.short}${seat.label ? ': ' + seat.label : ''}${seat.mark ? ' (' + MARK_WORDS[seat.mark] + ')' : ''}`}</title>
            <Person x={x} y={y} u={u} busy={!!seat.label} lead />
            {seat.mark && Glyph ? (
              <g className={`hq-mark is-${MARK_TONE[seat.mark]}`}>
                <circle cx={x + 6 * u} cy={y - 12 * u} r={Math.max(4.6, 4.4 * u)} />
                <Glyph x={x + 6 * u - Math.max(2.9, 2.8 * u)} y={y - 12 * u - Math.max(2.9, 2.8 * u)} width={Math.max(5.8, 5.6 * u)} height={Math.max(5.8, 5.6 * u)} strokeWidth={3.2} aria-hidden="true" />
              </g>
            ) : null}
            {labelled ? (
              <text className="hq-t2 hq-strong" x={onLeft ? x - 8 * u : x + 8 * u + (seat.mark ? 3 : 0)} y={y - 4.5 * u} fontSize={sfs} textAnchor={onLeft ? 'end' : 'start'} dominantBaseline="central">
                {seat.short}
              </text>
            ) : null}
          </g>
        );
      })}
    </>
  );
}

export const MARK_WORDS: Record<SeatMark, string> = {
  back_plan: 'backs the plan',
  back_objection: 'backs the objection',
  compromise: 'proposes a compromise',
  objects: 'objects',
  no_objection: 'no objection',
  awaited: 'yet to answer',
};

const OFFICE_ICON: Record<Office['kind'], LucideIcon> = { shareholders: Megaphone, ceo: Megaphone, signatory: PenLine, judge: Gavel, archive: Library, files: FolderOpen, operations: CalendarDays };
const SEATED: ReadonlySet<Office['kind']> = new Set(['shareholders', 'ceo', 'signatory', 'judge']);

function OfficeBody({ room, r, top, k }: { room: Office; r: Rect; top: number; k: number }) {
  const far = k < FAR;
  const pad = clamp(10 * k, 5, 14);
  const x0 = r.x + pad;
  const w0 = r.w - pad * 2;
  const fs = clamp(11.5 * k, 9.5, 12.5);
  const lineY = top + clamp(5 * k, 3, 7);
  const bodyTop = lineY + fs * 1.55;
  const bodyH = r.y + r.h - pad * 0.7 - bodyTop;
  const seated = SEATED.has(room.kind);
  const u = far ? clamp(k * 1.25, 0.5, 0.86) : clamp(k * 1.12, 0.86, 1.8);
  const busy = room.doing.length > 0;
  const big = clamp(24 * k, 14, 30);
  const figureY = bodyTop + Math.max(big * 0.55, bodyH - big * 0.6);
  const Icon = OFFICE_ICON[room.kind];
  const iconSize = clamp(bodyH * 0.72, 12, 34);
  const sr = clamp(4.5 * k, 3.4, 6.5);
  const sfs = clamp(9.5 * k, 9, 11.5);
  const steps = room.steps && !far && bodyH > 44 ? room.steps : null;
  const stepSpan = steps ? w0 - sr - textWidth(steps.names[steps.names.length - 1] ?? '', sfs, true) / 2 - 2 : 0;
  return (
    <>
      <text className="hq-t2" x={x0} y={lineY + fs * 0.55} fontSize={fs} dominantBaseline="central">
        {fitText(room.line, w0, fs)}
      </text>
      {seated && bodyH > 14 ? (
        far ? (
          <Person x={x0 + 7 * u} y={bodyTop + Math.min(bodyH, 15 * u)} u={u} busy={busy} lead />
        ) : (
          <Desk x={x0 + 14 * u} y={bodyTop + Math.min(bodyH - 7 * u, 16 * u)} u={u} busy={busy} lead />
        )
      ) : null}
      {!seated && bodyH > 12 ? <Icon className="hq-room-icon" x={r.x + r.w - pad - iconSize} y={bodyTop + (bodyH - iconSize) / 2} width={iconSize} height={iconSize} strokeWidth={1.5} aria-hidden="true" /> : null}
      {room.figure && steps ? (
        <text className="hq-t1 hq-strong" x={r.x + r.w - pad} y={bodyTop + fs * 0.6} fontSize={fs} textAnchor="end" dominantBaseline="central">
          {room.figure.label.replace(/^./, (c) => c.toUpperCase())} {room.figure.value}
        </text>
      ) : room.figure && bodyH > big * 0.9 ? (
        <g className="hq-figure">
          <text className="hq-t1 hq-strong" x={seated ? r.x + r.w - pad : x0} y={figureY} fontSize={big} textAnchor={seated ? 'end' : 'start'} dominantBaseline="central">
            {room.figure.value}
          </text>
          {!far ? (
            <text
              className="hq-t3"
              x={seated ? r.x + r.w - pad - textWidth(String(room.figure.value), big, true) - 5 : x0 + textWidth(String(room.figure.value), big, true) + 5}
              y={figureY + big * 0.14}
              fontSize={sfs}
              textAnchor={seated ? 'end' : 'start'}
              dominantBaseline="central"
            >
              {room.figure.label}
            </text>
          ) : null}
        </g>
      ) : null}
      {steps ? (
        <g className="hq-steps">
          {steps.names.map((name, i) => {
            const x = x0 + sr + (stepSpan * i) / Math.max(1, steps.names.length - 1);
            const y = r.y + r.h - pad - sfs * 1.5;
            return (
              <g key={name} className={i < steps.current ? 'is-done' : i === steps.current ? 'is-current' : ''}>
                {i ? <line className="hq-rail" x1={x - stepSpan / Math.max(1, steps.names.length - 1) + sr} y1={y} x2={x - sr} y2={y} /> : null}
                <circle cx={x} cy={y} r={sr} />
                <text className={i === steps.current ? 'hq-t1 hq-strong' : 'hq-t3'} x={i === 0 ? x - sr : x} y={y + sr + sfs * 0.85} fontSize={sfs} textAnchor={i === 0 ? 'start' : 'middle'} dominantBaseline="central">
                  {name}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
    </>
  );
}

const ROOM_ICON: Partial<Record<Room['kind'], LucideIcon>> = { archive: Library, files: FolderOpen, operations: CalendarDays, board: Scale };

function RoomMark({ room, k, selected, onSelect, live, flash }: { room: Room; k: number; selected: string | null; onSelect: Select; live: boolean; flash: number }) {
  const r = scale(room.rect, k);
  const radius = clamp(7 * k, 3, 10);
  const lip = clamp(5 * k, 2, 7);
  const hh = clamp(30 * k, 17, 34);
  const fs = clamp(12.5 * k, 9.5, 14);
  const pad = clamp(9 * k, 5, 12);
  const mid = r.y + hh / 2;
  const Icon = ROOM_ICON[room.kind];
  const badgeFs = fs * 0.84;
  const badgeW = Icon ? fs * 1.15 : textWidth(room.short, badgeFs, true) + badgeFs * 1.1;
  const badgeH = Math.min(hh - 6, badgeFs * 1.75);
  const lampSize = clamp(12 * k, 10, 14);
  const titleX = r.x + pad + badgeW + pad * 0.7;
  const titleW = r.x + r.w - pad - (room.lamp === 'idle' ? 0 : lampSize + 5) - titleX;
  const chosen = selected !== null && roomOf(selected) === room.id;
  const clip = domId('clip-' + room.id);
  const doorW = clamp(24 * k, 10, 32);
  const said = [room.title, room.line, LAMP_WORDS[room.lamp], room.pins.you ? `${room.pins.you} waiting for you` : '', room.pins.trouble ? `${room.pins.trouble} gone wrong` : ''].filter(Boolean).join('. ');
  const press = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(room.id);
  };
  return (
    <g
      className={`hq-room hq-room-${room.kind} is-${room.lamp}${chosen ? ' is-selected' : ''}${selected === room.id ? ' is-chosen' : ''}`}
      style={hue(room.hue)}
      data-hq={room.id}
      role="button"
      tabIndex={0}
      aria-label={said}
      aria-pressed={chosen}
      onClick={() => onSelect(room.id)}
      onDoubleClick={() => onSelect(room.id, true)}
      onKeyDown={press}
    >
      <rect className="hq-lip" x={r.x} y={r.y + lip} width={r.w} height={r.h} rx={radius} />
      <rect className="hq-floor" x={r.x} y={r.y} width={r.w} height={r.h} rx={radius} />
      <clipPath id={clip}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={radius} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect className="hq-band" x={r.x} y={r.y} width={r.w} height={hh} />
        {Icon ? (
          <Icon className="hq-band-icon" x={r.x + pad} y={mid - fs * 0.575} width={fs * 1.15} height={fs * 1.15} strokeWidth={2} aria-hidden="true" />
        ) : (
          <>
            <rect className="hq-badge" x={r.x + pad} y={mid - badgeH / 2} width={badgeW} height={badgeH} rx={3.5} />
            <text className="hq-badge-text" x={r.x + pad + badgeW / 2} y={mid + 0.4} fontSize={badgeFs} textAnchor="middle" dominantBaseline="central">
              {room.short}
            </text>
          </>
        )}
        <text className="hq-title" x={titleX} y={mid + 0.4} fontSize={fs} dominantBaseline="central">
          {fitText(room.title, titleW, fs, true)}
        </text>
        <LampGlyph lamp={room.lamp} x={r.x + r.w - pad - lampSize / 2} y={mid} size={lampSize} />
        {room.kind === 'department' ? (
          <DepartmentBody room={room} r={r} top={r.y + hh} k={k} selected={selected} onSelect={onSelect} live={live} />
        ) : room.kind === 'board' ? (
          <BoardBody room={room} r={r} top={r.y + hh} k={k} selected={selected} onSelect={onSelect} />
        ) : (
          <OfficeBody room={room} r={r} top={r.y + hh} k={k} />
        )}
      </g>
      <rect className="hq-wall" x={r.x} y={r.y} width={r.w} height={r.h} rx={radius} />
      {room.doorIn === 'left' ? <rect className="hq-door" x={room.door.x * k - 2.5} y={room.door.y * k - doorW / 2} width={5} height={doorW} rx={2} /> : <rect className="hq-door" x={room.door.x * k - doorW / 2} y={room.door.y * k - 2.5} width={doorW} height={5} rx={2} />}
      {flash ? <rect key={flash} className="hq-flash" x={r.x} y={r.y} width={r.w} height={r.h} rx={radius} /> : null}
      <Pins room={room} r={r} />
    </g>
  );
}

function FlowMark({ flow, k, onSelect }: { flow: Flow; k: number; onSelect: Select }) {
  const points = flow.points.map((p) => ({ x: p.x * k, y: p.y * k }));
  if (points.length < 2) return null;
  // It stops short of the door it leads to, so that its arrow stands in the corridor.
  const end = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const run = Math.hypot(end.x - before.x, end.y - before.y) || 1;
  const back = Math.min(run * 0.6, 7);
  points[points.length - 1] = { x: end.x - ((end.x - before.x) / run) * back, y: end.y - ((end.y - before.y) / run) * back };
  const d = trace(points, clamp(9 * k, 4, 12));
  return (
    <g
      className={`hq-flow is-${flow.state} hq-flow-${flow.kind}`}
      data-hq-flow={flow.id}
      role="img"
      aria-label={flow.label}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(flow.state === 'you' ? flow.to : flow.kind === 'wait' ? flow.to : flow.from);
      }}
    >
      <title>{flow.label}</title>
      <path className="hq-flow-hit" d={d} />
      <path className="hq-flow-line" d={d} markerEnd={`url(#hq-arrow-${flow.state})`} />
      {flow.state === 'moving' ? <circle className="hq-flow-dot" r={3.4} style={{ offsetPath: `path("${d}")` } as CSSProperties} /> : null}
    </g>
  );
}

/** Everything that is drawn of the building, at one distance. Moving the map about draws none of it again. */
const Scenery = memo(function Scenery({ scene, k, selected, onSelect, live, flash }: { scene: Scene; k: number; selected: string | null; onSelect: Select; live: boolean; flash: MapFlash | null }) {
  const w = scene.plot.size.w * k;
  const h = scene.plot.size.h * k;
  const lip = clamp(9 * k, 4, 12);
  return (
    <>
      <rect className="hq-shadow" x={5} y={lip + 6} width={w} height={h} rx={clamp(14 * k, 6, 18)} />
      <rect className="hq-slab-lip" x={0} y={lip} width={w} height={h} rx={clamp(14 * k, 6, 18)} />
      <rect className="hq-slab" x={0} y={0} width={w} height={h} rx={clamp(14 * k, 6, 18)} />
      {scene.plot.halls.map((hall, i) => (
        <rect key={i} className="hq-hall" x={hall.x * k} y={hall.y * k} width={hall.w * k} height={hall.h * k} rx={clamp(6 * k, 2, 8)} />
      ))}
      <g className="hq-flows">
        {scene.flows.map((flow) => (
          <FlowMark key={flow.id} flow={flow} k={k} onSelect={onSelect} />
        ))}
      </g>
      {scene.rooms.map((room) => (
        <RoomMark key={room.id} room={room} k={k} selected={selected} onSelect={onSelect} live={live} flash={flash?.room === room.id ? flash.seq : 0} />
      ))}
    </>
  );
});

function MiniMap({ scene, camera, view, onMove }: { scene: Scene; camera: Camera; view: { w: number; h: number }; onMove: (centre: Point) => void }) {
  const W = 156;
  const s = W / scene.plot.size.w;
  const H = scene.plot.size.h * s;
  const seen = inView(camera, view);
  const pressed = useRef(false);
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    onMove({ x: (e.clientX - box.left) / s, y: (e.clientY - box.top) / s });
  };
  return (
    <svg
      className="hq-mini"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="The whole building, with the part the map shows marked"
      onPointerDown={(e) => {
        pressed.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => pressed.current && move(e)}
      onPointerUp={() => (pressed.current = false)}
      onPointerCancel={() => (pressed.current = false)}
    >
      <rect className="hq-mini-slab" x={0.5} y={0.5} width={W - 1} height={H - 1} rx={3} />
      {scene.rooms.map((room) => (
        <g key={room.id} style={hue(room.hue)}>
          <rect className={`hq-mini-room is-${room.lamp}`} x={room.rect.x * s} y={room.rect.y * s} width={room.rect.w * s} height={room.rect.h * s} rx={1.5} />
          {/* A dot where a person is needed, and a square on its corner where something has gone wrong: told apart by shape as well as by colour. */}
          {room.pins.you ? (
            <circle className="hq-mini-pin is-you" cx={(room.rect.x + room.rect.w) * s - 2.5} cy={room.rect.y * s + 2.5} r={3} />
          ) : room.pins.trouble ? (
            <rect className="hq-mini-pin is-trouble" x={(room.rect.x + room.rect.w) * s - 5} y={room.rect.y * s} width={5} height={5} transform={`rotate(45 ${(room.rect.x + room.rect.w) * s - 2.5} ${room.rect.y * s + 2.5})`} />
          ) : null}
        </g>
      ))}
      <rect className="hq-mini-view" x={clamp(seen.x * s, 0, W)} y={clamp(seen.y * s, 0, H)} width={Math.max(4, Math.min(W, (seen.x + seen.w) * s) - clamp(seen.x * s, 0, W))} height={Math.max(4, Math.min(H, (seen.y + seen.h) * s) - clamp(seen.y * s, 0, H))} rx={2} />
    </svg>
  );
}

const reducedMotion = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A room where something has just happened, to be marked for a moment. */
export interface MapFlash {
  room: string;
  seq: number;
}

export interface MapFocus {
  /** What to bring into view. */
  target: string;
  /** Counts up each time it is asked for, so that asking twice for the same thing moves the map twice. */
  seq: number;
  /** Go close enough to read it, even when it can already be seen. */
  close?: boolean;
}

export function HeadquartersMap({
  scene,
  selected,
  onSelect,
  camera,
  onCamera,
  focus,
  flash,
  expanded,
  onExpand,
  children,
}: {
  scene: Scene;
  selected: string | null;
  onSelect: (target: string | null) => void;
  /** Where the map is looked at from. Null shows the whole building, whatever size the map is. */
  camera: Camera | null;
  onCamera: (camera: Camera | null) => void;
  focus: MapFocus | null;
  flash: MapFlash | null;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 1040, h: 560 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setView((was) => (was.w === el.clientWidth && was.h === el.clientHeight ? was : { w: Math.max(120, el.clientWidth), h: Math.max(120, el.clientHeight) }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const whole = useMemo(() => fit({ x: 0, y: 0, ...scene.plot.size }, view, EDGE), [scene.plot.size.w, scene.plot.size.h, view]);
  const cam = camera ?? whole;
  const live = scene.situation.state === 'running' || scene.situation.state === 'pausing';

  // The latest of each, for what listens to the page itself and for a flight under way.
  const now = useRef({ cam, view, size: scene.plot.size, onCamera });
  now.current = { cam, view, size: scene.plot.size, onCamera };
  const flight = useRef(0);
  const land = useCallback((to: Camera | null) => {
    cancelAnimationFrame(flight.current);
    now.current.onCamera(to);
  }, []);
  const fly = useCallback((to: Camera) => {
    cancelAnimationFrame(flight.current);
    const from = now.current.cam;
    if (reducedMotion() || typeof requestAnimationFrame === 'undefined') return now.current.onCamera(to);
    const started = performance.now();
    const step = (at: number) => {
      const t = Math.min(1, (at - started) / FLIGHT_MS);
      const e = 1 - (1 - t) ** 3;
      now.current.onCamera({ k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      if (t < 1) flight.current = requestAnimationFrame(step);
    };
    flight.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(flight.current), []);

  /** The camera that shows one room with a little of what is round it. */
  const toRoom = useCallback(
    (id: string, closest: number): Camera | null => {
      const room = scene.rooms.find((r) => r.id === roomOf(id));
      if (!room) return null;
      const around = { x: room.rect.x - 26, y: room.rect.y - 30, w: room.rect.w + 52, h: room.rect.h + 56 };
      return keepInView(fit(around, now.current.view, EDGE, closest), scene.plot.size, now.current.view);
    },
    [scene],
  );

  // Something was asked for from outside the map: bring it into view, and near enough to read.
  const asked = useRef(0);
  useEffect(() => {
    if (!focus || focus.seq === asked.current) return;
    asked.current = focus.seq;
    const room = scene.rooms.find((r) => r.id === roomOf(focus.target));
    if (!room) return;
    const seen = inView(now.current.cam, now.current.view);
    const inside = room.rect.x >= seen.x && room.rect.y >= seen.y && room.rect.x + room.rect.w <= seen.x + seen.w && room.rect.y + room.rect.h <= seen.y + seen.h;
    if (inside && now.current.cam.k >= FAR && !focus.close) return;
    const to = toRoom(focus.target, focus.close ? 2.2 : Math.max(1, Math.min(1.5, now.current.cam.k)));
    if (to) fly(to);
  }, [focus, scene, toRoom, fly]);

  const select: Select = useCallback(
    (target, zoom) => {
      onSelect(target);
      // From afar a room cannot be read, so choosing one goes to it. Asked for twice in a row, it is gone to from anywhere.
      if (zoom || now.current.cam.k < FAR) {
        const to = toRoom(target, zoom ? 2.2 : 1.25);
        if (to) fly(to);
      }
    },
    [onSelect, toRoom, fly],
  );

  const zoomBy = (factor: number) => fly(keepInView(zoomAt(now.current.cam, factor, { x: view.w / 2, y: view.h / 2 }), scene.plot.size, view));
  const toLevel = (level: MapLevel) => {
    if (level === 'building') return land(null);
    const k = level === 'rooms' ? 1 : 2;
    const chosen = selected ? toRoom(selected, k) : null;
    fly(chosen ? { ...chosen, ...keepInView(zoomAt(chosen, k / chosen.k, { x: view.w / 2, y: view.h / 2 }), scene.plot.size, view) } : keepInView(zoomAt(now.current.cam, k / now.current.cam.k, { x: view.w / 2, y: view.h / 2 }), scene.plot.size, view));
  };

  // The wheel moves the map nearer and further. It is listened for on the element itself: only there can it be kept from scrolling the page as well.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.0019));
      cancelAnimationFrame(flight.current);
      now.current.onCamera(keepInView(zoomAt(now.current.cam, factor, { x: e.clientX - box.left, y: e.clientY - box.top }), now.current.size, now.current.view));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Dragging moves the map, with one finger or the mouse; two fingers move it nearer and further.
  const fingers = useRef(new Map<number, Point>());
  const drag = useRef<{ from: Point; cam: Camera; moved: boolean; spread: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const swallow = useRef(false);
  const where = (e: ReactPointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const centre = () => {
    const all = [...fingers.current.values()];
    return { x: all.reduce((s, p) => s + p.x, 0) / all.length, y: all.reduce((s, p) => s + p.y, 0) / all.length };
  };
  const spread = () => {
    const all = [...fingers.current.values()];
    return all.length < 2 ? 0 : Math.hypot(all[0]!.x - all[1]!.x, all[0]!.y - all[1]!.y);
  };
  const begin = () => (drag.current = { from: centre(), cam: now.current.cam, moved: drag.current?.moved ?? false, spread: spread() });
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('.hq-overlay')) return;
    fingers.current.set(e.pointerId, where(e));
    begin();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!fingers.current.has(e.pointerId) || !drag.current) return;
    fingers.current.set(e.pointerId, where(e));
    const d = drag.current;
    const at = centre();
    if (!d.moved && fingers.current.size === 1 && Math.hypot(at.x - d.from.x, at.y - d.from.y) < 4) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      ref.current!.setPointerCapture(e.pointerId);
      cancelAnimationFrame(flight.current);
    }
    let next: Camera = { k: d.cam.k, x: d.cam.x + at.x - d.from.x, y: d.cam.y + at.y - d.from.y };
    if (d.spread > 0 && spread() > 0) next = zoomAt(next, spread() / d.spread, at);
    onCamera(keepInView(next, scene.plot.size, view));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!fingers.current.delete(e.pointerId)) return;
    if (fingers.current.size) return void begin();
    // A press that moved the map is not also a press on whatever was under it.
    if (drag.current?.moved) {
      swallow.current = true;
      setTimeout(() => (swallow.current = false), 0);
    }
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.target as Element).closest('input, textarea, select')) return;
    const by = 70;
    // Moved by hand, the map stops going wherever it was on its way to.
    const move = (dx: number, dy: number) => land(keepInView({ k: cam.k, x: cam.x + dx, y: cam.y + dy }, scene.plot.size, view));
    if (e.key === '+' || e.key === '=') zoomBy(ZOOM.step);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM.step);
    else if (e.key === '0') land(null);
    else if (e.key === 'ArrowLeft') move(by, 0);
    else if (e.key === 'ArrowRight') move(-by, 0);
    else if (e.key === 'ArrowUp') move(0, by);
    else if (e.key === 'ArrowDown') move(0, -by);
    else if (e.key === 'Escape' && selected) onSelect(null);
    else return;
    e.preventDefault();
  };

  // Shown whole, the building is what is looked at, however much of each room there is room to draw.
  const level = camera === null ? 'building' : levelOf(cam.k);
  const dots = 26 * cam.k * (cam.k < 0.6 ? 2 : 1);
  return (
    <div
      ref={ref}
      className={`hq-map${live ? ' is-live' : ''}${dragging ? ' is-dragging' : ''}`}
      tabIndex={0}
      role="group"
      aria-label="Map of the headquarters. Arrow keys move it, plus and minus bring it nearer and further, and 0 shows the whole building."
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(e) => {
        if (!swallow.current) return;
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={(e) => {
        // A press on the ground lets go of whatever was chosen.
        if (!(e.target as Element).closest('.hq-room, .hq-flow, .hq-overlay') && selected) onSelect(null);
      }}
    >
      <svg className="hq-svg" width={view.w} height={view.h}>
        <defs>
          <pattern id="hq-dots" width={dots} height={dots} patternUnits="userSpaceOnUse" patternTransform={`translate(${cam.x % dots} ${cam.y % dots})`}>
            <circle className="hq-dot" cx={1.4} cy={1.4} r={1.1} />
          </pattern>
          {(['moving', 'waiting', 'you'] as const).map((state) => (
            <marker key={state} id={`hq-arrow-${state}`} className={`hq-arrow is-${state}`} viewBox="0 0 10 10" refX={7} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M1 1.5 L8.5 5 L1 8.5 z" />
            </marker>
          ))}
        </defs>
        <rect className="hq-ground" x={0} y={0} width={view.w} height={view.h} fill="url(#hq-dots)" />
        <g transform={`translate(${cam.x.toFixed(2)} ${cam.y.toFixed(2)})`}>
          <Scenery scene={scene} k={cam.k} selected={selected} onSelect={select} live={live} flash={flash} />
        </g>
      </svg>
      {children}
      <div className="hq-overlay hq-controls">
        <div className="hq-levels" role="group" aria-label="How near the map is">
          {(
            [
              ['building', 'Building', 'The whole building'],
              ['rooms', 'Rooms', 'Near enough to see each desk'],
              ['desks', 'Desks', 'Near enough to read what each agent is doing'],
            ] as const
          ).map(([id, label, title]) => (
            <button key={id} type="button" className={level === id ? 'is-on' : ''} aria-pressed={level === id} title={title} onClick={() => toLevel(id)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="hq-tool" aria-label="Nearer" title="Nearer (+)" disabled={cam.k >= ZOOM.max - 0.001} onClick={() => zoomBy(ZOOM.step)}>
          <Plus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="hq-tool" aria-label="Further" title="Further (−)" disabled={cam.k <= ZOOM.min + 0.001} onClick={() => zoomBy(1 / ZOOM.step)}>
          <Minus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="hq-tool" aria-label={expanded ? 'Back to the page' : 'Fill the window'} title={expanded ? 'Back to the page (Esc)' : 'Fill the window'} aria-pressed={expanded} onClick={() => onExpand(!expanded)}>
          {expanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
        </button>
      </div>
      {/* The whole building in small, once part of it is out of view: that is when there is something to find the way in. */}
      {cam.x > 0.5 && cam.y > 0.5 && cam.x + scene.plot.size.w * cam.k < view.w && cam.y + scene.plot.size.h * cam.k < view.h ? null : (
        <div className="hq-overlay hq-mini-wrap">
          <MiniMap scene={scene} camera={cam} view={view} onMove={(centre) => land(keepInView({ k: cam.k, x: view.w / 2 - centre.x * cam.k, y: view.h / 2 - centre.y * cam.k }, scene.plot.size, view))} />
        </div>
      )}
    </div>
  );
}
