import type { Organisation, SignatoryHolder, SignatoryRequest } from './types';

// Reading the signatory's desk: which requests are still open, and which of those are waiting for a person.
// Used by the server to decide what to tell the organisation and by the browser to decide what to show.

/** Still to be decided or carried out. */
export function isOpen(request: SignatoryRequest): boolean {
  return request.status === 'pending' || request.status === 'authorised';
}

/** Still for an AI signatory to decide: nothing has been ruled on it yet. */
export function waitsOnAi(request: SignatoryRequest, holder: SignatoryHolder): boolean {
  return holder === 'ai' && request.status === 'pending' && !request.ruling;
}

/**
 * Waiting for a person to do something: everything open when a person holds the seat. When an AI holds it,
 * what the AI has authorised, and anything the person took back from the AI to decide for themselves.
 */
export function waitsOnPerson(request: SignatoryRequest, holder: SignatoryHolder): boolean {
  return isOpen(request) && !waitsOnAi(request, holder);
}

export function waitingOnPerson(org: Pick<Organisation, 'signatory' | 'settings'>): SignatoryRequest[] {
  return org.signatory.requests.filter((r) => waitsOnPerson(r, org.settings.signatory));
}

type Described = Pick<SignatoryRequest, 'kind' | 'title' | 'amount' | 'party'>;

/** What a request is for, and on what terms: "Domain registration (12 GBP a year, to Namecheap)". */
export function requestSubject(request: Described): string {
  const terms =
    request.kind === 'payment'
      ? [request.amount, request.party ? `to ${request.party}` : ''].filter(Boolean).join(', ')
      : request.party
        ? `with ${request.party}`
        : '';
  return `${request.title}${terms ? ` (${terms})` : ''}`;
}

/** A request in a line: "Pay: Domain registration (12 GBP a year, to Namecheap)". */
export function describeRequest(request: Described): string {
  return `${request.kind === 'payment' ? 'Pay' : 'Sign'}: ${requestSubject(request)}`;
}
