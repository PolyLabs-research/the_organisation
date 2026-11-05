import { describeRequest, isOpen, requestSubject } from '../../shared/signatory';
import type { BoardMessage, Executive, Organisation, Plan, SignatoryMessage, SignatoryRequest } from '../../shared/types';
import { clean, now } from './records';
import { ValidationError, execById, nextId, postToBoard } from './state';

// The signatory's desk. An organisation of agents cannot sign a document or
// move money, so anything of that kind is put to one seat, the Authorised
// Signatory, as a request. A person holds the seat unless the organisation is
// set otherwise; an AI in the seat can agree or refuse, but what it agrees to
// still has to be carried out by a person, outside this system, who then says
// here that it was done. Until a request is done, it has not happened.

/** How many requests one gate review may raise. */
export const MAX_REQUESTS_PER_GATE = 3;
/** How many requests one lead may have open at a time. More than this is noise, not need. */
export const MAX_OPEN_PER_LEAD = 10;
/** A backstop on the length of the conversation kept in live state. */
const MAX_MESSAGES = 800;

/** What a lead gives when asking for a payment or a signature. */
export interface RequestSpec {
  kind: string;
  title: string;
  detail: string;
  amount: string;
  party: string;
  files: string[];
}

export function signatoryOf(org: Organisation): Executive {
  const seat = org.executives.find((e) => e.kind === 'signatory');
  if (!seat) throw new Error(`organisation ${org.id} has no signatory`);
  return seat;
}

function findRequest(org: Organisation, requestId: string): SignatoryRequest {
  const request = org.signatory.requests.find((r) => r.id === requestId);
  if (!request) throw new ValidationError('There is no such request.');
  return request;
}

/** Add a line to the conversation between the organisation and whoever signs and pays for it. */
function say(org: Organisation, fromId: string, kind: SignatoryMessage['kind'], text: string, requestId?: string): void {
  const { messages } = org.signatory;
  messages.push({ id: nextId(org, 'n'), at: now(), cycle: org.cycle.number, fromId, kind, text, ...(requestId ? { requestId } : {}) });
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
}

const refsOf = (request: SignatoryRequest): Pick<BoardMessage, 'planId' | 'requestId'> => ({ requestId: request.id, ...(request.planId ? { planId: request.planId } : {}) });
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** For a board title, which has to say at a glance whether the thing has happened: "paid" or "signed". */
const did = (request: SignatoryRequest) => (request.kind === 'payment' ? 'paid' : 'signed');

/**
 * File what a lead asks of the signatory at a phase gate, and tell the board. A request the lead already has
 * open under the same title is the same request and is not filed twice. Returns what was filed.
 */
export function raiseRequests(org: Organisation, lead: Executive, plan: Plan, phase: string | null, specs: RequestSpec[]): SignatoryRequest[] {
  const filed: SignatoryRequest[] = [];
  for (const spec of specs) {
    if (filed.length >= MAX_REQUESTS_PER_GATE) break;
    const title = clean(String(spec.title ?? ''), 160);
    if (!title) continue;
    const open = org.signatory.requests.filter((r) => r.fromId === lead.id && isOpen(r));
    if (open.some((r) => sameTitle(r.title, title))) continue;
    if (open.length >= MAX_OPEN_PER_LEAD) break;
    const kind = spec.kind === 'signature' ? 'signature' : 'payment';
    const request: SignatoryRequest = {
      id: nextId(org, 'q'),
      cycle: org.cycle.number,
      kind,
      fromId: lead.id,
      planId: plan.id,
      phase,
      title,
      detail: clean(String(spec.detail ?? ''), 2000),
      amount: kind === 'payment' ? clean(String(spec.amount ?? ''), 80) : '',
      party: clean(String(spec.party ?? ''), 160),
      files: (Array.isArray(spec.files) ? spec.files : [])
        .filter((f): f is string => typeof f === 'string' && !!f.trim())
        .map((f) => f.trim().slice(0, 240))
        .slice(0, 5),
      status: 'pending',
      raisedAt: now(),
      ruling: null,
      outcome: null,
    };
    org.signatory.requests.push(request);
    say(org, lead.id, 'request', describeRequest(request), request.id);
    const files = request.files.length ? `\n\nTo read first: ${request.files.join(', ')}` : '';
    postToBoard(org, 'signatory', lead.id, `${lead.short} asks the signatory to ${kind === 'payment' ? 'pay' : 'sign'}: ${requestSubject(request)}`, `${request.detail || 'No reason was given.'}${files}`, refsOf(request));
    filed.push(request);
  }
  return filed;
}

/** Record what an AI signatory decided. A request it agrees to then waits for a person to carry it out. */
export function ruleOnRequest(org: Organisation, request: SignatoryRequest, verdict: 'authorise' | 'decline', reason: string): void {
  if (request.status !== 'pending' || request.ruling) return;
  const seat = signatoryOf(org);
  const at = now();
  const why = clean(reason, 1200) || (verdict === 'authorise' ? 'Within what the shareholders want.' : 'No reason was given.');
  if (verdict === 'authorise') {
    request.ruling = { verdict: 'authorised', reason: why, at };
    request.status = 'authorised';
    say(org, seat.id, 'authorised', why, request.id);
    postToBoard(org, 'signatory', seat.id, `Authorised, not yet ${did(request)}: ${requestSubject(request)}`, `${why}\n\nIt has not happened yet: a person has to carry it out and confirm it.`, refsOf(request));
  } else {
    request.ruling = { verdict: 'declined', reason: why, at };
    request.status = 'rejected';
    request.outcome = { result: 'rejected', by: 'ai', note: why, at, cycle: org.cycle.number };
    say(org, seat.id, 'declined', why, request.id);
    postToBoard(org, 'signatory', seat.id, `Declined, not ${did(request)}: ${requestSubject(request)}`, why, refsOf(request));
  }
}

/** The person says a request has been carried out, or refuses it and says why. */
export function settleRequest(org: Organisation, requestId: string, result: 'done' | 'rejected', note: string): SignatoryRequest {
  const request = findRequest(org, requestId);
  if (!isOpen(request)) throw new ValidationError(`This request is already ${request.status}.`);
  const text = clean(note, 2000);
  if (result === 'rejected' && !text) throw new ValidationError('Say why it is rejected. The organisation is told the reason and plans around it.');
  const seat = signatoryOf(org);
  request.status = result;
  request.outcome = { result, by: 'person', note: text, at: now(), cycle: org.cycle.number };
  say(org, 'person', result, text, request.id);
  if (result === 'done') {
    postToBoard(org, 'signatory', seat.id, `${request.kind === 'payment' ? 'Paid' : 'Signed'}: ${requestSubject(request)}`, text ? `Carried out by a person. They add: ${text}` : 'Carried out by a person.', refsOf(request));
  } else {
    postToBoard(org, 'signatory', seat.id, `Rejected, not ${did(request)}: ${requestSubject(request)}`, `It will not be done. The reason given: ${text}`, refsOf(request));
  }
  return request;
}

/**
 * Take back what was said about a request: one marked done or rejected by mistake, or one the AI signatory
 * declined that the person wants to decide for themselves. It waits for the person again.
 */
export function reopenRequest(org: Organisation, requestId: string): SignatoryRequest {
  const request = findRequest(org, requestId);
  if (request.status !== 'done' && request.status !== 'rejected') {
    throw new ValidationError(request.status === 'withdrawn' ? 'The organisation has withdrawn this request, so there is nothing to reopen.' : 'This request is still open.');
  }
  const seat = signatoryOf(org);
  // Back to where it stood: agreed by the AI and waiting to be carried out, or waiting to be decided. One the
  // AI declined keeps that ruling on record, which is also what stops the AI from being asked a second time.
  request.status = request.ruling?.verdict === 'authorised' ? 'authorised' : 'pending';
  request.outcome = null;
  say(org, 'person', 'reopened', '', request.id);
  postToBoard(org, 'signatory', seat.id, `Reopened, not yet ${did(request)}: ${requestSubject(request)}`, 'What was recorded about this request has been taken back. It is open again and has not happened.', refsOf(request));
  return request;
}

/** A plan that is cancelled no longer needs what it asked for. Nobody should pay for work that has been stopped. */
export function withdrawRequests(org: Organisation, plan: Plan, reason: string): void {
  const open = org.signatory.requests.filter((r) => r.planId === plan.id && isOpen(r));
  if (!open.length) return;
  const why = clean(reason, 600) || 'The plan it was for was cancelled.';
  for (const request of open) {
    request.status = 'withdrawn';
    request.outcome = { result: 'withdrawn', by: 'organisation', note: why, at: now(), cycle: org.cycle.number };
    say(org, 'system', 'withdrawn', `The plan this was for has been cancelled: ${why}`, request.id);
  }
  const owner = execById(org, plan.ownerId);
  postToBoard(
    org,
    'signatory',
    'system',
    `Withdrawn from the signatory: ${open.length} request${open.length === 1 ? '' : 's'} of the ${owner?.short ?? plan.ownerId} plan`,
    `${open.map((r) => `- ${describeRequest(r)}`).join('\n')}\n\nThe plan was cancelled, so these are no longer wanted and must not be carried out.`,
    { planId: plan.id },
  );
}

/** Something the person wants the organisation to know that is not an answer to one request. */
export function addNote(org: Organisation, text: string): void {
  const note = clean(text, 4000);
  if (!note) throw new ValidationError('The message is empty.');
  say(org, 'person', 'note', note);
  postToBoard(org, 'signatory', signatoryOf(org).id, 'Note from the signatory', note);
}
