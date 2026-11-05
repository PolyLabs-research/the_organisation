import { FileText, PenLine, Send, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isOpen, waitsOnAi, waitsOnPerson } from '../shared/signatory';
import type { Organisation, OrgView, SignatoryMessage, SignatoryRequest } from '../shared/types';
import { api, useAction } from './api';
import { REQUEST_STATUS } from './labels';
import { Empty, ErrorNote, SeatBadge, clock, seatFor, seatName } from './ui';

// The signatory's window on the organisation. On the left of the conversation, what the organisation asks for
// and what an AI in the seat decides; on the right, what the person says back. Under it, whatever is waiting
// for the person, each with the two answers there are: it is done, or it is refused and why.

const YOU = { short: 'You', hue: 40, title: 'You' };

function Terms({ request }: { request: SignatoryRequest }) {
  const terms =
    request.kind === 'payment'
      ? [request.amount || 'amount not stated', request.party ? `to ${request.party}` : 'payee not stated']
      : [request.party ? `with ${request.party}` : 'other party not stated'];
  return <span className="request-terms">{terms.join(' · ')}</span>;
}

/** What is being asked for, in full: who asked, for which plan, how much and to whom, why, and what to read first. */
function RequestBody({
  org,
  request,
  withRuling,
  onOpenPlan,
  onOpenFile,
}: {
  org: Organisation;
  request: SignatoryRequest;
  /** In the conversation an AI's ruling is a line of its own, so it is only repeated where the request stands alone. */
  withRuling?: boolean;
  onOpenPlan: (planId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const plan = org.plans.find((p) => p.id === request.planId);
  return (
    <>
      <p className="request-title">
        {request.kind === 'payment' ? <Wallet size={15} aria-hidden="true" /> : <PenLine size={15} aria-hidden="true" />}
        <span className="tag">{request.kind === 'payment' ? 'Payment' : 'Signature'}</span>
        <strong>{request.title}</strong>
      </p>
      <p>
        <Terms request={request} />
      </p>
      {/* Written by a model: shown as plain text, so that nothing in it can pass for a link or a button. */}
      {request.detail ? <p className="pre-wrap">{request.detail}</p> : null}
      {withRuling && request.ruling ? (
        <p className="muted">
          {request.ruling.verdict === 'authorised' ? 'Authorised' : 'Declined'} by the AI signatory: {request.ruling.reason}
        </p>
      ) : null}
      <p className="request-foot muted">
        Asked by the {seatName(org, request.fromId)}
        {request.phase ? ` at the ${request.phase} gate` : ''}
        {plan ? (
          <>
            {' of '}
            <button type="button" className="link" onClick={() => onOpenPlan(plan.id)}>
              its plan
            </button>
          </>
        ) : null}
        {request.files.map((path) => (
          <button key={path} type="button" className="link" onClick={() => onOpenFile(path)} title={`Open ${path}`}>
            <FileText size={12} aria-hidden="true" /> {path.split('/').pop()}
          </button>
        ))}
      </p>
    </>
  );
}

/** The two answers a person can give, and room to say more. A refusal needs its reason: the organisation plans around it. */
function Answer({ orgId, request, onView }: { orgId: string; request: SignatoryRequest; onView: (view: OrgView) => void }) {
  const [mode, setMode] = useState<'done' | 'rejected' | null>(null);
  const [note, setNote] = useState('');
  const act = useAction();
  const did = request.kind === 'payment' ? 'I have paid this' : 'I have signed this';

  if (!mode) {
    return (
      <div className="row">
        <button type="button" className="button button-primary" onClick={() => setMode('done')}>
          {did}
        </button>
        <button type="button" className="button" onClick={() => setMode('rejected')}>
          Reject it
        </button>
      </div>
    );
  }
  return (
    <form
      className="answer"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => onView(await api.answerRequest(orgId, request.id, mode, note)));
      }}
    >
      <label className="field">
        <span className="field-label">{mode === 'done' ? 'Anything the organisation should know (optional)' : 'Why? The organisation is told, and plans around it'}</span>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
          placeholder={mode === 'done' ? 'e.g. Paid by card today, reference 12345' : 'e.g. Too much for a first month: find one under 20 a month'}
        />
      </label>
      <div className="row">
        <button type="submit" className={`button ${mode === 'done' ? 'button-primary' : 'button-danger'}`} disabled={act.busy || (mode === 'rejected' && !note.trim())}>
          {mode === 'done' ? 'Tell the organisation it is done' : 'Tell the organisation it is rejected'}
        </button>
        <button type="button" className="button" onClick={() => setMode(null)} disabled={act.busy}>
          Back
        </button>
      </div>
      <ErrorNote onDismiss={act.clearError}>{act.error}</ErrorNote>
    </form>
  );
}

function Line({
  org,
  message,
  onView,
  onOpenPlan,
  onOpenFile,
}: {
  org: Organisation;
  message: SignatoryMessage;
  onView: (view: OrgView) => void;
  onOpenPlan: (planId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const request = message.requestId ? org.signatory.requests.find((r) => r.id === message.requestId) : undefined;
  const reopen = useAction();
  const mine = message.fromId === 'person';
  const about = request ? request.title : 'a request that has since been archived';

  if (message.fromId === 'system') {
    return (
      <li className="chat-line chat-system">
        <span className="muted">
          {request ? `“${request.title}”: ` : ''}
          {message.text} <span className="num">{clock(message.at)}</span>
        </span>
      </li>
    );
  }

  let body: React.ReactNode;
  if (message.kind === 'request') {
    body = request ? (
      <>
        <RequestBody org={org} request={request} onOpenPlan={onOpenPlan} onOpenFile={onOpenFile} />
        <p className="request-state">
          <span className={`tag request-${request.status}`}>{REQUEST_STATUS[request.status]}</span>
          {/* What a person said can be taken back, in case it was said of the wrong request. So can an AI's refusal, to decide it oneself. */}
          {request.status === 'done' || request.status === 'rejected' ? (
            <button type="button" className="link" disabled={reopen.busy} onClick={() => void reopen.run(async () => onView(await api.answerRequest(org.id, request.id, 'reopen', '')))}>
              {request.outcome?.by === 'ai' ? 'Decide this myself' : 'Take that back'}
            </button>
          ) : null}
        </p>
        <ErrorNote onDismiss={reopen.clearError}>{reopen.error}</ErrorNote>
      </>
    ) : (
      <p className="muted">{message.text} (archived with its cycle)</p>
    );
  } else if (message.kind === 'note') {
    body = <p className="pre-wrap">{message.text}</p>;
  } else {
    const said = {
      authorised: 'Authorised',
      declined: 'Declined',
      done: request?.kind === 'signature' ? 'Signed' : 'Paid',
      rejected: 'Rejected',
      withdrawn: 'Withdrawn',
      reopened: 'Taken back: open again',
    }[message.kind];
    body = (
      <>
        <p>
          <strong>{said}</strong> <span className="muted">· {about}</span>
        </p>
        {message.text ? <p className="pre-wrap">{message.text}</p> : null}
      </>
    );
  }

  return (
    <li className={`chat-line ${mine ? 'chat-mine' : 'chat-theirs'}`}>
      <SeatBadge seat={mine ? YOU : seatFor(org, message.fromId)} size="sm" />
      <div className="bubble">
        <p className="bubble-head">
          <strong>{mine ? 'You' : seatName(org, message.fromId)}</strong>
          <span className="muted num">{clock(message.at)}</span>
        </p>
        {body}
      </div>
    </li>
  );
}

export function Signatory({
  org,
  onView,
  onOpenPlan,
  onOpenFile,
  onSettings,
}: {
  org: Organisation;
  onView: (view: OrgView) => void;
  onOpenPlan: (planId: string) => void;
  onOpenFile: (path: string) => void;
  onSettings: () => void;
}) {
  const { requests, messages } = org.signatory;
  const holder = org.settings.signatory;
  const seat = org.executives.find((e) => e.kind === 'signatory');
  const waiting = requests.filter((r) => waitsOnPerson(r, holder));
  const withAi = requests.filter((r) => waitsOnAi(r, holder));
  const [text, setText] = useState('');
  const send = useAction();
  const scroll = useRef<HTMLOListElement>(null);

  // The conversation is read from the bottom, where the newest line is.
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div className="signatory">
      <header className="signatory-head">
        {seat ? <SeatBadge seat={seat} size="lg" /> : null}
        <div className="grow">
          <strong>{seat?.title ?? 'Signatory'}</strong>
          <p className="muted">
            {holder === 'human'
              ? 'You hold this seat. The organisation cannot pay for anything or sign anything: it asks here, you do it outside this system, and you tell it here what you did.'
              : 'An AI holds this seat and decides whether each request is authorised. It cannot pay or sign: what it authorises waits here for you to carry out, and you can still refuse.'}{' '}
            <button type="button" className="link" onClick={onSettings}>
              Change who holds it
            </button>
          </p>
          <p className="muted">Requests are written by AI. Check the amount and who is being paid yourself before you act on one.</p>
        </div>
      </header>

      {messages.length === 0 ? (
        <Empty title="Nothing has been asked of the signatory yet.">
          When a lead’s plan needs something paid for or signed, the request appears here. The organisation carries on meanwhile, but treats nothing as paid or signed until you say it is.
        </Empty>
      ) : (
        <ol className="chat" ref={scroll} aria-label="Conversation with the organisation">
          {messages.map((m) => (
            <Line key={m.id} org={org} message={m} onView={onView} onOpenPlan={onOpenPlan} onOpenFile={onOpenFile} />
          ))}
        </ol>
      )}

      <section className="waiting" aria-label="Waiting for you">
        <h3>
          {waiting.length ? `Waiting for you: ${waiting.length}` : 'Nothing is waiting for you'}
          {withAi.length ? <span className="muted"> · {withAi.length} with the AI signatory</span> : null}
        </h3>
        {waiting.map((request) => (
          <article key={request.id} className="request-card">
            <RequestBody org={org} request={request} withRuling onOpenPlan={onOpenPlan} onOpenFile={onOpenFile} />
            <Answer orgId={org.id} request={request} onView={onView} />
          </article>
        ))}
      </section>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void send.run(async () => {
            onView(await api.signatoryNote(org.id, text));
            setText('');
          });
        }}
      >
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            requests.some(isOpen)
              ? 'Tell the organisation something else, e.g. “Nothing can be paid before Monday”. To answer a request, use its buttons above.'
              : 'Tell the organisation something about signing or paying, e.g. “I have renewed the domain myself”.'
          }
          aria-label="Message to the organisation"
        />
        <button type="submit" className="button button-primary" disabled={!text.trim() || send.busy}>
          <Send size={15} aria-hidden="true" /> Send
        </button>
      </form>
      <ErrorNote onDismiss={send.clearError}>{send.error}</ErrorNote>
      <p className="field-hint">A message sent here is put to the board, and every lead hears it in this cycle and the next. For a rule that should always hold, send it as shareholder steer.</p>
    </div>
  );
}
