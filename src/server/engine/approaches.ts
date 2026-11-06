import { approachAllowed, approachesOf } from '../../shared/approaches';
import type { Organisation } from '../../shared/types';
import { ValidationError, postToBoard } from './state';

/** Open or close a work approach to a role, on the word of a person. Plans already drawn up carry on as they are. */
export function changeApproach(org: Organisation, seatId: unknown, approachId: unknown, allowed: unknown): boolean {
  const seat = org.executives.find((e) => e.id === seatId);
  if (!seat) throw new ValidationError('There is no such role in this organisation.');
  const approach = approachesOf(seat).find((a) => a.id === approachId);
  if (!approach) throw new ValidationError(`That work approach is not one the ${seat.title} can use.`);
  if (typeof allowed !== 'boolean') throw new ValidationError('Say whether the approach is allowed.');
  if (approachAllowed(org, seat.id, approach.id) === allowed) return false;
  (org.workApproaches[seat.id] ??= {})[approach.id] = allowed;
  postToBoard(org, 'system', 'system', `How the ${seat.short} may work has changed`, `${approach.label} is ${allowed ? 'now open to' : 'no longer open to'} this role.`);
  return true;
}
