import { PRIVILEGES, PRIVILEGE_BY_ID, allows, applies, type Privilege } from '../../shared/privileges';
import type { Organisation } from '../../shared/types';
import { ValidationError, postToBoard } from './state';

/**
 * Set what a role may do, on the word of a person. Nothing a seat or an agent can call reaches this. A privilege
 * brings in what it needs, and removing one removes what depends on it. The board is told what changed, and the
 * return value says whether anything was taken away, so that work relying on it can be stopped.
 */
export function changePrivilege(org: Organisation, seatId: unknown, privilege: unknown, allowed: unknown): { changed: boolean; removed: boolean } {
  const seat = org.executives.find((e) => e.id === seatId);
  if (!seat) throw new ValidationError('There is no such role in this organisation.');
  const spec = PRIVILEGES.find((p) => p.id === privilege);
  if (!spec) throw new ValidationError('There is no such privilege.');
  if (typeof allowed !== 'boolean') throw new ValidationError('Say whether the privilege is allowed.');
  if (!applies(seat, spec)) throw new ValidationError(`This privilege does not apply to the ${seat.title}, which has no agents.`);

  const wanted = new Map<Privilege, boolean>([[spec.id, allowed]]);
  if (allowed && spec.needs) wanted.set(spec.needs, true);
  if (!allowed) for (const other of PRIVILEGES) if (other.needs === spec.id) wanted.set(other.id, false);
  const changes = [...wanted].filter(([id, value]) => allows(org, seat.id, id) !== value);
  if (!changes.length) return { changed: false, removed: false };

  const role = (org.privileges[seat.id] ??= {});
  for (const [id, value] of changes) role[id] = value;
  const said = changes.map(([id, value]) => `- ${PRIVILEGE_BY_ID[id].label}: ${value ? 'now allowed' : 'no longer allowed'}`).join('\n');
  postToBoard(org, 'system', 'system', `What the ${seat.short} may do has changed`, `The shareholders have changed this role's privileges:\n${said}`);
  return { changed: true, removed: changes.some(([, value]) => !value) };
}
