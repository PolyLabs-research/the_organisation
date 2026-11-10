import { useEffect, useRef, useState } from 'react';
import type { Organisation } from '../shared/types';
import { MAX_OFFERED_TOOLS, type AccessView, type AccountPage, type AccountView, type MailboxView, type MailMessage, type MailSummary, type RepositoryView, type ToolServerView, type ToolView } from '../shared/access';
import { allows } from '../shared/privileges';
import { request, useAction } from './api';
import { HelpLink } from './Guide';
import { ErrorNote, Field } from './ui';

const call = <T,>(id: string, method: string, path = '', body?: unknown) => request<T>(method, '/api/orgs/' + id + '/access' + path, body);
type Update = (view: AccessView) => void;
const teams = (org: Organisation) => org.executives.filter(exec => exec.kind === 'lead' || exec.kind === 'ceo');

function TeamPicker({ org, value, onChange }: { org: Organisation; value: string[]; onChange: (ids: string[]) => void }) {
  return <fieldset className="access-teams"><legend>Teams with agent access</legend>{teams(org).map(exec => <label key={exec.id}>
    <input type="checkbox" checked={value.includes(exec.id)} onChange={event => onChange(event.target.checked ? [...value, exec.id] : value.filter(id => id !== exec.id))} /> {exec.short} — {exec.title}
  </label>)}<p className="muted">Leave all unchecked to keep this connection for a person only. What a team may do with it is set under Privileges.</p></fieldset>;
}
/** What each team can do with a connection, which is its assignment and its role's privileges taken together. */
function Reach({ org, ownerIds, describe }: { org: Organisation; ownerIds: string[]; describe: (seatId: string) => string }) {
  const seats = teams(org).filter(seat => ownerIds.includes(seat.id));
  return <p className="muted">{seats.length ? seats.map(seat => seat.short + ': ' + (seat.kind === 'ceo' ? 'no agents' : describe(seat.id))).join(' · ') : 'For a person only: no team is assigned.'}</p>;
}
const canRead = (org: Organisation, id: string) => allows(org, id, 'read_mail'), canDraft = (org: Organisation, id: string) => allows(org, id, 'draft_mail');
const mailReach = (org: Organisation) => (id: string) => canRead(org, id) && canDraft(org, id) ? 'reads and drafts' : canRead(org, id) ? 'reads only' : canDraft(org, id) ? 'drafts only' : 'no access, see Privileges';
const codeReach = (org: Organisation) => (id: string) => allows(org, id, 'push_code') ? (allows(org, id, 'run_workflows') ? 'pushes and starts builds' : 'pushes branches') : allows(org, id, 'read_code') ? (allows(org, id, 'run_workflows') ? 'reads and starts builds' : 'reads only') : 'no access, see Privileges';
const accountReach = (org: Organisation) => (id: string) => allows(org, id, 'act') ? 'can act' : allows(org, id, 'sign_in') ? 'signs in and reads only' : 'no access, see Privileges';
const toolReach = (org: Organisation) => (id: string) => allows(org, id, 'use_tools') ? 'calls the tools allowed here' : 'no access, see Privileges';
type Kind = 'accounts' | 'mailboxes' | 'repositories' | 'toolServers';
function PasswordUpdate({ orgId, kind, id, onView }: { orgId: string; kind: Kind; id: string; onView: Update }) {
  const action = useAction();
  const [password, setPassword] = useState('');
  const token = kind === 'repositories' || kind === 'toolServers';
  return <details className="access-details"><summary>{token ? 'Replace token' : 'Update saved password'}</summary>
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => { try { onView(await call(orgId, 'POST', '/' + kind + '/' + id + '/password', { password })); } finally { setPassword(''); } }); }}>
      <p className="muted">{kind === 'toolServers' ? 'The server is asked for its tools with the new token before it is saved.' : token ? 'GitHub is asked whether the new token works before it is saved.' : 'Save a password you have already changed at the service. This updates the vault only.'}</p>
      <Field label={token ? 'New token' : 'New saved password'}><input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={2048} /></Field>
      <ErrorNote>{action.error}</ErrorNote><button className="button" disabled={action.busy}>{token ? 'Save token' : 'Save password'}</button>
    </form>
  </details>;
}
function GrantEditor({ org, kind, record, onView }: { org: Organisation; kind: Kind; record: AccountView | MailboxView | RepositoryView | ToolServerView; onView: Update }) {
  const action = useAction();
  const [owners, setOwners] = useState(record.ownerIds);
  // Removing takes two presses: what is saved here goes for good, and for a password generated here there is no other copy.
  const [removing, setRemoving] = useState(false);
  useEffect(() => setOwners(record.ownerIds), [record.ownerIds.join(',')]);
  // Ticks are saved by "Save team access" and by nothing else. Disabling or enabling keeps the teams already saved: a press that says nothing of teams must not give one access.
  const update = (ownerIds: string[], enabled: boolean) => void action.run(async () => onView(await call(org.id, 'PATCH', '/' + kind + '/' + record.id, { ownerIds, enabled })));
  const lost = kind === 'toolServers' ? 'Its saved token is deleted for good, and so is your choice of which tools agents may call.' : kind === 'repositories' ? 'Its saved token is deleted for good.' : kind === 'accounts' ? 'Its saved password is deleted for good. If that is its only copy, reveal it and note it first.' : 'Its saved password or Google sign-in is deleted for good, and so are the drafts prepared from it.';
  return <details className="access-details"><summary>Manage access</summary>
    <TeamPicker org={org} value={owners} onChange={setOwners} />
    <div className="access-actions">
      <button type="button" className="button" disabled={action.busy} onClick={() => update(owners, record.enabled)}>Save team access</button>
      <button type="button" className="button" disabled={action.busy} onClick={() => update(record.ownerIds, !record.enabled)}>{record.enabled ? 'Disable' : 'Enable'}</button>
      {removing ? <>
        <span className="pre-wrap">Remove {record.label}? {lost}</span>
        <button type="button" className="button button-danger" disabled={action.busy} onClick={() => void action.run(async () => onView(await call(org.id, 'DELETE', '/' + kind + '/' + record.id)))}>Yes, remove it</button>
        <button type="button" className="button" disabled={action.busy} onClick={() => setRemoving(false)}>Keep it</button>
      </> : <button type="button" className="button" disabled={action.busy} onClick={() => setRemoving(true)}>Remove connection</button>}
    </div>
    <p className="muted">Removing a connection deletes its saved secret here. It does not delete the external account. Google permissions can also be revoked in your Google Account.</p>
    <ErrorNote>{action.error}</ErrorNote>
  </details>;
}
function MailConnect({ org, configured, onView }: { org: Organisation; configured: boolean; onView: Update }) {
  const action = useAction();
  const [label, setLabel] = useState('Business inbox');
  const [owners, setOwners] = useState<string[]>([]);
  const [address, setAddress] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  return <section className="ops-editor">
    <div className="row"><h3>Connect a business mailbox</h3><HelpLink guide="email-and-accounts" section="connect-gmail-or-google-workspace" /></div>
    <p>Use a dedicated business mailbox. Agents you select can read its messages and prepare drafts; you review each outgoing message before sending. Messages an agent reads are shared with its configured model provider.</p>
    <Field label="Mailbox label"><input value={label} onChange={e => setLabel(e.target.value)} maxLength={160} required /></Field>
    <TeamPicker org={org} value={owners} onChange={setOwners} />
    {!configured ? <div className="note note-warn"><div>
      <strong>Google sign-in needs one-time server setup.</strong>
      <p>Enable the Gmail API in your Google Cloud project, create a Web application OAuth client, and set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in the server’s <code>.env</code>. Restart the server.</p>
      <p>Register this exact authorised redirect URI: <code>{window.location.origin}/api/oauth/google/callback</code></p>
      <p>Add your Google account as a test user, or use your Workspace organisation’s approved internal app.</p>
      <p><HelpLink guide="email-and-accounts" section="connect-gmail-or-google-workspace">Step-by-step setup, with a link for each step</HelpLink></p>
    </div></div> : null}
    <button type="button" className="button button-primary" disabled={!configured || action.busy || !label.trim()} onClick={() => void action.run(async () => {
      const result = await call<{ url: string }>(org.id, 'POST', '/google/start', { label, ownerIds: owners });
      window.location.assign(result.url);
    })}>Connect Gmail with Google</button>
    <details className="access-details"><summary>Other providers: IMAP and SMTP</summary>
      <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
        try { onView(await call(org.id, 'POST', '/mailboxes', { label, address, username: username || address, password, imapHost, smtpHost, smtpPort, ownerIds: owners })); }
        finally { setPassword(''); }
      }); }}>
        <div className="grid-2">
          <Field label="Email address"><input type="email" required value={address} onChange={e => setAddress(e.target.value)} autoComplete="off" /></Field>
          <Field label="Username (blank to use email)"><input value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></Field>
          <Field label="App password"><input type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
          <Field label="IMAP host (TLS, port 993)"><input required placeholder="imap.example.com" value={imapHost} onChange={e => setImapHost(e.target.value)} /></Field>
          <Field label="SMTP host"><input required placeholder="smtp.example.com" value={smtpHost} onChange={e => setSmtpHost(e.target.value)} /></Field>
          <Field label="SMTP port"><select aria-label="SMTP port" value={smtpPort} onChange={e => setSmtpPort(Number(e.target.value))}><option value={465}>465 — TLS</option><option value={587}>587 — required STARTTLS</option></select></Field>
        </div>
        <button className="button" disabled={action.busy}>{action.busy ? 'Checking connection…' : 'Connect mailbox'}</button>
      </form>
    </details>
    <ErrorNote>{action.error}</ErrorNote>
  </section>;
}
function AccountConnect({ org, view, onView }: { org: Organisation; view: AccessView; onView: Update }) {
  const action = useAction();
  const [values, setValues] = useState({ label: '', loginUrl: '', signupUrl: '', username: '', mailboxId: '', password: '', resources: '' });
  const [owners, setOwners] = useState<string[]>([]);
  const [signup, setSignup] = useState(false);
  const set = (key: keyof typeof values, value: string) => setValues(old => ({ ...old, [key]: value }));
  return <form className="ops-editor" onSubmit={event => { event.preventDefault(); void action.run(async () => {
    const { resources, ...spec } = values;
    try {
      onView(await call(org.id, 'POST', '/accounts', { ...spec, resourceOrigins: resources.split(/[\s,]+/).filter(Boolean), ownerIds: owners, allowSignup: signup }));
      setValues({ label: '', loginUrl: '', signupUrl: '', username: '', mailboxId: '', password: '', resources: '' });
    } finally { set('password', ''); }
  }); }}>
    <div className="row"><h3>Authorise a service account</h3><HelpLink guide="email-and-accounts" section="service-accounts-and-passwords" /></div>
    <p>Choose the service and the teams allowed to operate it. The browser fills saved credentials on this exact site. Account creation can accept the service’s terms, so authorise services you intend the business to use.</p>
    <p className="note note-warn">An assigned team can sign in and read, and the browser blocks anything else that would send a change. With Act on accounts on under Privileges, its agents can press anything this account can press, and are only told not to buy or commit. Do not give that to a role on an account that holds a saved card or can order on credit.</p>
    <div className="grid-2">
      <Field label="Service name"><input value={values.label} onChange={e => set('label', e.target.value)} required maxLength={160} /></Field>
      <Field label="Login URL"><input type="url" placeholder="https://service.example/login" value={values.loginUrl} onChange={e => set('loginUrl', e.target.value)} required /></Field>
      <Field label="Account username or email"><input value={values.username} onChange={e => set('username', e.target.value)} required autoComplete="off" /></Field>
      <Field label="Mailbox for verification"><select aria-label="Mailbox for verification" value={values.mailboxId} onChange={e => set('mailboxId', e.target.value)}><option value="">None</option>{view.mailboxes.filter(box => box.enabled).map(box => <option value={box.id} key={box.id}>{box.address}</option>)}</select></Field>
      <Field label={signup ? 'Password (blank to generate)' : 'Existing account password'}><input type="password" value={values.password} onChange={e => set('password', e.target.value)} required={!signup} autoComplete="new-password" /></Field>
      <Field label="Trusted supporting origins (optional)" hint="Exact HTTPS origins for a service’s API, scripts or assets; separate with spaces."><input value={values.resources} onChange={e => set('resources', e.target.value)} placeholder="https://cdn.service.example" /></Field>
    </div>
    <label className="access-check"><input type="checkbox" checked={signup} onChange={e => setSignup(e.target.checked)} /> Allow the agents to create this business account (the role also needs Create accounts under Privileges)</label>
    {signup ? <Field label="Sign-up URL (same site as login)"><input type="url" value={values.signupUrl} onChange={e => set('signupUrl', e.target.value)} required /></Field> : null}
    <TeamPicker org={org} value={owners} onChange={setOwners} />
    <ErrorNote>{action.error}</ErrorNote><button className="button button-primary" disabled={action.busy}>Save service account</button>
  </form>;
}
const splitNames = (text: string) => text.split(/[\s,]+/).filter(Boolean);
function RepositoryConnect({ org, onView }: { org: Organisation; onView: Update }) {
  const action = useAction();
  const [label, setLabel] = useState('');
  const [repository, setRepository] = useState('');
  const [token, setToken] = useState('');
  const [workflows, setWorkflows] = useState('');
  const [owners, setOwners] = useState<string[]>([]);
  return <form className="ops-editor" onSubmit={event => { event.preventDefault(); void action.run(async () => {
    try {
      onView(await call(org.id, 'POST', '/repositories', { label, repository, token, workflows: splitNames(workflows), ownerIds: owners }));
      setLabel(''); setRepository(''); setWorkflows('');
    } finally { setToken(''); }
  }); }}>
    <div className="row"><h3>Connect a GitHub repository</h3><HelpLink guide="code-repositories" section="connect-a-repository" /></div>
    <p>Agents get a branch of their own for each plan. They can commit there, open a pull request and start the workflows you list, so builds and tests run on GitHub’s machines. A person merges.</p>
    <p className="note note-warn">Use a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained token</a> limited to this repository, with Contents, Pull requests and Actions set to read and write, and Commit statuses to read. Add Workflows only if a role will change pipelines. Protect the main branch on GitHub as well: that lock holds whatever happens here.</p>
    <div className="grid-2">
      <Field label="Name"><input value={label} onChange={e => setLabel(e.target.value)} required maxLength={160} /></Field>
      <Field label="Repository"><input value={repository} onChange={e => setRepository(e.target.value)} placeholder="owner/name" required maxLength={300} autoComplete="off" /></Field>
      <Field label="Token"><input type="password" value={token} onChange={e => setToken(e.target.value)} required maxLength={512} autoComplete="new-password" /></Field>
      <Field label="Workflows agents may start (optional)" hint="File names such as ci.yml. Leave out anything that deploys."><input value={workflows} onChange={e => setWorkflows(e.target.value)} placeholder="ci.yml" /></Field>
    </div>
    <TeamPicker org={org} value={owners} onChange={setOwners} />
    <ErrorNote>{action.error}</ErrorNote><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Checking with GitHub…' : 'Connect repository'}</button>
  </form>;
}
function RepositoryCard({ org, repository, onView }: { org: Organisation; repository: RepositoryView; onView: Update }) {
  const action = useAction();
  const [workflows, setWorkflows] = useState(repository.workflows.join(' '));
  useEffect(() => setWorkflows(repository.workflows.join(' ')), [repository.workflows.join(' ')]);
  return <article className="ops-card">
    <div className="row"><h3>{repository.label}</h3><span className="tag">{repository.private ? 'Private' : 'Public'} · {repository.enabled ? 'Enabled' : 'Disabled'}</span></div>
    <p><a href={repository.htmlUrl} target="_blank" rel="noreferrer">{repository.fullName}</a> · main branch {repository.defaultBranch}</p>
    <Reach org={org} ownerIds={repository.ownerIds} describe={codeReach(org)} />
    {!repository.canPush ? <p className="note note-warn">GitHub says this token cannot push, so agents can only read here.</p> : null}
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => onView(await call(org.id, 'PATCH', '/repositories/' + repository.id + '/workflows', { workflows: splitNames(workflows) }))); }}>
      <Field label="Workflows agents may start" hint="File names such as ci.yml. Leave out anything that deploys."><input value={workflows} onChange={e => setWorkflows(e.target.value)} /></Field>
      <ErrorNote>{action.error}</ErrorNote><button className="button" disabled={action.busy}>Save workflows</button>
    </form>
    <GrantEditor org={org} kind="repositories" record={repository} onView={onView} />
    <PasswordUpdate orgId={org.id} kind="repositories" id={repository.id} onView={onView} />
  </article>;
}
function ToolServerConnect({ org, onView }: { org: Organisation; onView: Update }) {
  const action = useAction();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [header, setHeader] = useState('');
  const [owners, setOwners] = useState<string[]>([]);
  return <form className="ops-editor" onSubmit={event => { event.preventDefault(); void action.run(async () => {
    try {
      onView(await call(org.id, 'POST', '/toolServers', { label, url, token, header: header.trim() || 'Authorization', ownerIds: owners }));
      setLabel(''); setUrl(''); setHeader('');
    } finally { setToken(''); }
  }); }}>
    <div className="row"><h3>Connect a tool server</h3><HelpLink guide="tool-servers" section="connect-a-tool-server" /></div>
    <p>A tool server gives agents tools from another program or service, over the Model Context Protocol (MCP). The server is asked what it offers, and you choose which of its tools agents may call. None is allowed until you tick it.</p>
    <p className="note note-warn">Connect only a server you trust with what agents send it, and with what its tools can do. Where the service offers a token limited to reading, or to one project, use that one.</p>
    <div className="grid-2">
      <Field label="Name"><input value={label} onChange={e => setLabel(e.target.value)} required maxLength={160} /></Field>
      <Field label="Address" hint="HTTPS, or http://localhost for a server on this machine."><input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://tools.example.com/mcp" required maxLength={2000} autoComplete="off" /></Field>
      <Field label="Token (optional)" hint="Leave empty for a server that asks for none."><input type="password" value={token} onChange={e => setToken(e.target.value)} maxLength={2048} autoComplete="new-password" /></Field>
      <Field label="Header for the token (optional)" hint="Leave empty to send it as a bearer token, which most servers take. Otherwise the header the service names for its key, such as X-API-Key."><input value={header} onChange={e => setHeader(e.target.value)} placeholder="Authorization" maxLength={64} autoComplete="off" /></Field>
    </div>
    <TeamPicker org={org} value={owners} onChange={setOwners} />
    <ErrorNote>{action.error}</ErrorNote><button className="button button-primary" disabled={action.busy}>{action.busy ? 'Asking the server for its tools…' : 'Connect tool server'}</button>
  </form>;
}
const SAYS = { reads: 'Says it only reads', changes: 'Says it changes things', deletes: 'Says it can delete', '': '' } as const;
const allowedNames = (tools: ToolView[]) => tools.filter(tool => tool.allowed).map(tool => tool.name);
function ToolServerCard({ org, server, onView }: { org: Organisation; server: ToolServerView; onView: Update }) {
  const action = useAction();
  const [ticked, setTicked] = useState(() => allowedNames(server.tools));
  // The ticks follow the server only when what it holds changes. A page that is refreshed while a person is choosing must not undo the choosing.
  const held = server.tools.map(tool => tool.fingerprint + (tool.allowed ? '+' : '-')).join(',');
  useEffect(() => setTicked(allowedNames(server.tools)), [held]);
  const allowed = allowedNames(server.tools);
  const unsaved = ticked.length !== allowed.length || ticked.some(name => !allowed.includes(name));
  // Every tool a team has is described to the model in each of its tasks. Roughly four characters make a token.
  const weight = Math.round(server.tools.filter(tool => ticked.includes(tool.name)).reduce((sum, tool) => sum + tool.callName.length + tool.description.length + JSON.stringify(tool.inputSchema).length + 120, 0) / 400) * 100;
  // Each tool is allowed as it is described on this page: the server refuses one that has been read again and is no longer the same.
  const save = () => void action.run(async () => onView(await call(org.id, 'PATCH', '/toolServers/' + server.id + '/tools', { allowed: server.tools.filter(tool => ticked.includes(tool.name)).map(tool => ({ name: tool.name, fingerprint: tool.fingerprint })) })));
  return <article className="ops-card">
    <div className="row"><h3>{server.label}</h3><span className="tag">{allowed.length} of {server.tools.length} tools allowed · {server.enabled ? 'Enabled' : 'Disabled'}</span></div>
    <p>{server.url}{server.serverName ? <> · calls itself {server.serverName}</> : null} · {!server.hasToken ? 'no token' : server.header.toLowerCase() === 'authorization' ? 'token saved' : 'token saved, sent as ' + server.header}</p>
    <Reach org={org} ownerIds={server.ownerIds} describe={toolReach(org)} />
    {server.tools.some(tool => tool.changed) ? <p className="note note-warn">The server now describes a tool differently from when you allowed it. It is kept back from agents until you have looked at it and allowed it again.</p> : null}
    <fieldset className="access-tools" disabled={action.busy}>
      <legend>Tools agents may call</legend>
      {!server.tools.length ? <p className="muted">The server offers no tools.</p> : null}
      {server.tools.map(tool => <div className={tool.unusable ? 'access-tool access-tool-off' : 'access-tool'} key={tool.name}>
        {/* Only the tick and the name make the tick: reading down a long description, or selecting some of it, must not allow a tool by a slip. */}
        <label className="access-tool-name">
          <input type="checkbox" aria-label={'Allow ' + tool.name} checked={ticked.includes(tool.name)} disabled={!!tool.unusable} onChange={event => setTicked(event.target.checked ? [...ticked, tool.name] : ticked.filter(name => name !== tool.name))} />
          <strong>{tool.name}</strong>{tool.says ? <span className="tag">{SAYS[tool.says]}</span> : null}{tool.changed ? <span className="tag tag-warn">Changed since you allowed it</span> : null}
        </label>
        <div className="access-tool-body">
          <span className="access-tool-text">{tool.description || 'The server gives no description.'}</span>
          {tool.unusable ? <span className="muted">Cannot be offered to agents. {tool.unusable}</span> : <>
            {tool.takes.length ? <span className="access-tool-takes">{tool.takes.map(item => <span key={item.name}><code>{item.name}</code>{item.required ? '' : ' (optional)'}{item.about ? ': ' + item.about : ''}</span>)}</span> : <span className="muted">Takes nothing.</span>}
            <details className="access-tool-shown"><summary>Everything a model is shown about it</summary><pre className="access-message-body">{tool.callName + '\n\n' + (tool.description || 'A tool on ' + server.label + '.') + '\n\n' + JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
          </>}
        </div>
      </div>)}
    </fieldset>
    {server.toolsLeftOut ? <p className="muted">{server.toolsLeftOut} more {server.toolsLeftOut === 1 ? 'tool is' : 'tools are'} offered by the server and not kept here: there is room for 150, and for descriptions of ordinary length.</p> : null}
    <p className="muted">What a tool says of itself is the server’s word, not a check. Agents are shown each tool as it is described here, read {new Date(server.toolsReadAt).toLocaleString()}.{ticked.length ? ' As ticked, these tools add about ' + (weight || 100).toLocaleString() + ' tokens to every task of a team that has them, since each is described to the model every time.' : ''}</p>
    <ErrorNote>{action.error}</ErrorNote>
    <div className="access-actions">
      <button type="button" className="button button-primary" disabled={action.busy || !unsaved} onClick={save}>Save allowed tools</button>
      <button type="button" className="button" disabled={action.busy} onClick={() => void action.run(async () => onView(await call(org.id, 'POST', '/toolServers/' + server.id + '/tools/read', {})))}>{action.busy ? 'Working…' : 'Read the server’s tools again'}</button>
    </div>
    <GrantEditor org={org} kind="toolServers" record={server} onView={onView} />
    <PasswordUpdate orgId={org.id} kind="toolServers" id={server.id} onView={onView} />
  </article>;
}
/** A team's agents are offered a limited number of connected tools, in the order the servers and their tools stand here. Past that, a tool allowed is a tool left out, which a person has to be told. */
function TooManyTools({ org, servers }: { org: Organisation; servers: ToolServerView[] }) {
  const over = teams(org).map(seat => ({ seat, allowed: servers.filter(server => server.enabled && server.ownerIds.includes(seat.id)).reduce((sum, server) => sum + server.tools.filter(tool => tool.allowed).length, 0) })).filter(item => item.seat.kind !== 'ceo' && item.allowed > MAX_OFFERED_TOOLS);
  return <>{over.map(({ seat, allowed }) => <p className="note note-warn" key={seat.id}>{seat.short} has {allowed} tools allowed across its servers. A team’s agents are offered {MAX_OFFERED_TOOLS} at most, in the order they stand here, so the last {allowed - MAX_OFFERED_TOOLS} are left out. Untick the ones the work does not need.</p>)}</>;
}
function Inbox({ orgId, box }: { orgId: string; box: MailboxView }) {
  const action = useAction();
  const [messages, setMessages] = useState<MailSummary[] | null>(null);
  const [message, setMessage] = useState<MailMessage | null>(null);
  return <div className="access-inbox">
    <button type="button" className="button" disabled={action.busy || !box.enabled} onClick={() => void action.run(async () => { setMessage(null); setMessages(await call(orgId, 'GET', '/mailboxes/' + box.id + '/messages')); })}>{action.busy ? 'Reading…' : 'Read inbox'}</button>
    <ErrorNote>{action.error}</ErrorNote>
    {messages ? <div className="access-messages">{messages.length ? messages.map(item => <button type="button" className="access-message" key={item.id} disabled={action.busy} onClick={() => void action.run(async () => setMessage(await call(orgId, 'GET', '/mailboxes/' + box.id + '/messages/' + encodeURIComponent(item.id))))}>
      <strong>{item.subject}</strong><span>{item.from} · {item.date ? new Date(item.date).toLocaleString() : ''}</span>
    </button>) : <p className="muted">The inbox is empty.</p>}</div> : null}
    {message ? <article className="ops-card"><h4>{message.subject}</h4><p className="muted">{message.from}</p><pre className="access-message-body">{message.text}</pre>{message.truncated ? <p className="muted">Long message shortened. Open Gmail for the full message.</p> : null}</article> : null}
  </div>;
}
function BrowserDesk({ orgId, account }: { orgId: string; account: AccountView }) {
  const action = useAction();
  const [page, setPage] = useState<AccountPage | null>(null);
  const [element, setElement] = useState<number | null>(null);
  const [source, setSource] = useState('username');
  const [value, setValue] = useState('');
  const [url, setUrl] = useState('');
  // The elements are numbered afresh for every page that comes back, so the same number is a different element after any action. A choice is for one action, and a number is only sent while it is in the list on show.
  const chosen = page?.elements.some(item => item.id === element) ? element : null;
  const run = (command: string) => void action.run(async () => {
    try {
      const result = await call<AccountPage>(orgId, 'POST', '/browser', { accountId: account.id, action: command, ...(chosen === null ? {} : { element: chosen }), source, value, url });
      setPage(command === 'close' ? null : result);
      setValue('');
    } finally { setElement(null); }
  });
  return <details className="access-details"><summary>Account browser</summary>
    <div className="access-actions">
      <button className="button" type="button" disabled={action.busy || !account.enabled} onClick={() => run('login')}>Open login</button>
      {account.allowSignup ? <button className="button" type="button" disabled={action.busy || !account.enabled} onClick={() => run('signup')}>Open sign-up</button> : null}
      {page ? <><button className="button" type="button" disabled={action.busy} onClick={() => run('inspect')}>Inspect page</button><button className="button" type="button" disabled={action.busy} onClick={() => run('close')}>Close session</button></> : null}
    </div>
    <ErrorNote>{action.error}</ErrorNote>
    {page ? <div className="access-browser"><h4>{page.title}</h4><p className="muted">{page.url}</p><pre className="access-message-body">{page.text}</pre>
      <Field label="Page element"><select aria-label="Page element" value={chosen ?? ''} onChange={e => setElement(e.target.value === '' ? null : Number(e.target.value))}><option value="">Choose an element</option>{page.elements.map(item => <option value={item.id} key={item.id}>{item.id}: {item.tag} {item.type} — {item.label}</option>)}</select></Field>
      <div className="grid-2">
        <Field label="Fill with"><select aria-label="Fill with" value={source} onChange={e => setSource(e.target.value)}><option value="username">Saved username</option><option value="password">Saved password</option><option value="email">Connected email</option><option value="text">Text or verification code</option></select></Field>
        {source === 'text' ? <Field label="Text or verification code"><input value={value} onChange={e => setValue(e.target.value)} autoComplete="off" /></Field> : null}
      </div>
      <div className="access-actions"><button type="button" className="button" disabled={action.busy || chosen === null} onClick={() => run('fill')}>Fill element</button><button type="button" className="button" disabled={action.busy || chosen === null} onClick={() => run('click')}>Click element</button></div>
      <Field label="Verification link (same service)"><input type="url" value={url} onChange={e => setUrl(e.target.value)} /></Field>
      <button type="button" className="button" disabled={action.busy || !url} onClick={() => run('navigate')}>Follow verification link</button>
    </div> : null}
  </details>;
}
function AccountCard({ org, account, onView }: { org: Organisation; account: AccountView; onView: Update }) {
  const action = useAction();
  const [secret, setSecret] = useState('');
  useEffect(() => { if (!secret) return; const timer = setTimeout(() => setSecret(''), 30000); return () => clearTimeout(timer); }, [secret]);
  return <article className="ops-card">
    <div className="row"><h3>{account.label}</h3><span className="tag">{account.enabled ? 'Enabled' : 'Disabled'}</span></div>
    <p>{account.username} · {account.origin}</p><Reach org={org} ownerIds={account.ownerIds} describe={accountReach(org)} /><p className="muted">Saved account details do not confirm that registration or login has succeeded.</p>
    <button className="button" type="button" disabled={action.busy || !account.enabled} onClick={() => secret ? setSecret('') : void action.run(async () => setSecret((await call<{ password: string }>(org.id, 'POST', '/accounts/' + account.id + '/reveal', {})).password))}>{secret ? 'Hide password' : 'Reveal password for 30 seconds'}</button>
    {secret ? <p className="access-secret"><code>{secret}</code></p> : null}
    <ErrorNote>{action.error}</ErrorNote>
    <BrowserDesk orgId={org.id} account={account} />
    <GrantEditor org={org} kind="accounts" record={account} onView={onView} />
    <PasswordUpdate orgId={org.id} kind="accounts" id={account.id} onView={onView} />
  </article>;
}
function Drafts({ org, view, onView }: { org: Organisation; view: AccessView; onView: Update }) {
  const action = useAction();
  const [mailboxId, setMailbox] = useState(view.mailboxes[0]?.id ?? '');
  const [to, setTo] = useState(''), [subject, setSubject] = useState(''), [text, setText] = useState('');
  // Sending takes two presses. The draft waiting for the second is held by its id, so that when the list moves, as it does whenever an agent prepares another, the second press cannot land on a different draft's send.
  const [sending, setSending] = useState<string | null>(null);
  return <>
    <form className="ops-editor" onSubmit={event => { event.preventDefault(); void action.run(async () => { onView(await call(org.id, 'POST', '/drafts', { mailboxId, to, subject, text })); setTo(''); setSubject(''); setText(''); }); }}>
      <h3>Prepare an email</h3><div className="grid-2">
        <Field label="From"><select aria-label="From" value={mailboxId} onChange={e => setMailbox(e.target.value)} required><option value="">Choose a mailbox</option>{view.mailboxes.filter(box => box.enabled).map(box => <option key={box.id} value={box.id}>{box.address}</option>)}</select></Field>
        <Field label="To"><input type="email" value={to} onChange={e => setTo(e.target.value)} required /></Field>
      </div>
      <Field label="Subject"><input value={subject} onChange={e => setSubject(e.target.value)} required maxLength={300} /></Field>
      <Field label="Message"><textarea value={text} onChange={e => setText(e.target.value)} required rows={5} maxLength={20000} /></Field>
      <button className="button" disabled={action.busy}>Save draft</button>
    </form>
    <ErrorNote>{action.error}</ErrorNote>
    {[...view.drafts].reverse().map(draft => <article className="ops-card" key={draft.id}>
      <div className="row"><h3>{draft.subject}</h3><span className="tag">{draft.status}</span></div>
      <p>From {view.mailboxes.find(box => box.id === draft.mailboxId)?.address} to {draft.to}</p>
      <p className="muted">Prepared by {draft.actorId} · {new Date(draft.createdAt).toLocaleString()}</p>
      <pre className="access-message-body">{draft.text}</pre>
      {draft.status === 'uncertain' || draft.status === 'sending' ? <p className="note note-warn">Delivery is unconfirmed. Check Sent in the mailbox before preparing another copy.</p> : null}
      <div className="access-actions">{draft.status !== 'draft' ? null : sending !== draft.id ? <button type="button" className="button button-primary" disabled={action.busy} onClick={() => setSending(draft.id)}>Send this email</button> : <>
          <span className="pre-wrap">Send “{draft.subject}” to {draft.to}? Once sent, it cannot be taken back.</span>
          <button type="button" className="button button-primary" disabled={action.busy} onClick={() => void action.run(async () => { try { onView(await call(org.id, 'POST', '/drafts/' + draft.id + '/send', {})); } finally { setSending(null); onView(await call(org.id, 'GET')); } })}>Yes, send it</button>
          <button type="button" className="button" disabled={action.busy} onClick={() => setSending(null)}>Not yet</button>
        </>}
        <button type="button" className="button" disabled={action.busy || draft.status === 'sending'} onClick={() => void action.run(async () => onView(await call(org.id, 'POST', '/drafts/' + draft.id + '/remove', {})))}>Remove from desk</button></div>
    </article>)}
  </>;
}
function Unlocked({ org, view, onView }: { org: Organisation; view: AccessView; onView: Update }) {
  const action = useAction();
  const [pane, setPane] = useState<'mail' | 'accounts' | 'code' | 'tools' | 'drafts' | 'requests' | 'history'>('mail');
  return <>
    <div className="row"><p className="muted">Unlocked · {view.autoLockMinutes === 0 ? 'stays unlocked until you lock it or the server stops.' : 'locks after 30 minutes without an access action, or when the server stops.'}</p><div className="access-actions"><a className="button" href={'/api/orgs/' + org.id + '/access/backup'} download>Download encrypted backup</a><button type="button" className="button" onClick={() => void action.run(async () => onView(await call(org.id, 'POST', '/lock', {})))} disabled={action.busy}>Lock vault</button></div></div>
    {org.settings.execution === 'managed' ? <p className="note note-warn">The email, account, repository and connected tools run with local task execution. Switch Execution in Settings to local to give the agents these tools.</p> : null}
    <ErrorNote>{action.error}</ErrorNote>
    <nav className="ops-nav" aria-label="Email and account sections">{(['mail', 'accounts', 'code', 'tools', 'drafts', 'requests', 'history'] as const).map(item => <button type="button" key={item} className={pane === item ? 'button button-primary' : 'button'} onClick={() => setPane(item)}>{({ mail: 'Mailboxes', accounts: 'Accounts', code: 'Repositories', tools: 'Tool servers', drafts: 'Email drafts', requests: 'Access requests', history: 'Access history' })[item]}{item === 'requests' && view.requests.some(request => request.status === 'open') ? ' (' + view.requests.filter(request => request.status === 'open').length + ')' : ''}</button>)}</nav>
    {pane === 'mail' ? <><details className="access-add" open={view.mailboxes.length === 0}><summary>Connect a mailbox</summary><MailConnect org={org} configured={!!view.googleConfigured} onView={onView} /></details>{view.mailboxes.map(box => <article className="ops-card" key={box.id}><div className="row"><h3>{box.label}</h3><span className="tag">{box.provider === 'gmail' ? 'Google' : 'IMAP / SMTP'} · {box.enabled ? 'Enabled' : 'Disabled'}</span></div><p>{box.address}</p><Reach org={org} ownerIds={box.ownerIds} describe={mailReach(org)} /><Inbox orgId={org.id} box={box} /><GrantEditor org={org} kind="mailboxes" record={box} onView={onView} />{box.provider === 'imap' ? <PasswordUpdate orgId={org.id} kind="mailboxes" id={box.id} onView={onView} /> : null}</article>)}</> : null}
    {pane === 'accounts' ? <><details className="access-add" open={view.accounts.length === 0}><summary>Add a service account</summary><AccountConnect org={org} view={view} onView={onView} /></details>{view.accounts.map(account => <AccountCard key={account.id} org={org} account={account} onView={onView} />)}</> : null}
    {pane === 'code' ? <><details className="access-add" open={view.repositories.length === 0}><summary>Connect a repository</summary><RepositoryConnect org={org} onView={onView} /></details>{view.repositories.map(repository => <RepositoryCard key={repository.id} org={org} repository={repository} onView={onView} />)}</> : null}
    {pane === 'tools' ? <><details className="access-add" open={view.toolServers.length === 0}><summary>Connect a tool server</summary><ToolServerConnect org={org} onView={onView} /></details><TooManyTools org={org} servers={view.toolServers} />{view.toolServers.map(server => <ToolServerCard key={server.id} org={org} server={server} onView={onView} />)}</> : null}
    {pane === 'drafts' ? <Drafts org={org} view={view} onView={onView} /> : null}
    {pane === 'requests' ? <>{!view.requests.length ? <p className="muted">Agents can request a service or help with sign-in here.</p> : null}{[...view.requests].reverse().map(item => <article className="ops-card" key={item.id}><h3>{item.service}</h3><p>{item.reason}</p><p className="muted">{item.actorId} · {item.status}</p>{item.status === 'open' ? <button className="button" type="button" disabled={action.busy} onClick={() => void action.run(async () => onView(await call(org.id, 'POST', '/requests/' + item.id + '/resolve', {})))}>Mark handled</button> : null}</article>)}</> : null}
    {pane === 'history' ? <div className="access-history">{view.audit.map((item, i) => <p key={i}><time>{new Date(item.at).toLocaleString()}</time> · {item.actorId} · {item.action.replaceAll('_', ' ')} · <code>{item.targetId}</code></p>)}</div> : null}
  </>;
}
export function Access({ org }: { org: Organisation }) {
  const action = useAction();
  const [view, setView] = useState<AccessView | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [keepUnlocked, setKeepUnlocked] = useState(false);
  const revision = useRef(0);
  const update = (next: AccessView) => { revision.current++; setView(next); };
  useEffect(() => {
    let closed = false;
    const refresh = () => { const current = revision.current; return call<AccessView>(org.id, 'GET').then(next => { if (!closed && current === revision.current) setView(next); }); };
    void action.run(refresh);
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 15000);
    return () => { closed = true; clearInterval(timer); };
  }, [org.id]);
  return <section className="operations access-panel">
    <h2>Email &amp; accounts</h2>
    <p>Business mail, saved logins, repositories and tool servers for the agents, held in this organisation’s encrypted vault. <HelpLink guide="email-and-accounts">Setup guide</HelpLink></p>
    <ErrorNote onDismiss={action.clearError}>{action.error}</ErrorNote>
    {!view ? <p className="muted">Loading access settings…</p> : !view.available ? <p className="note note-warn">{view.reason}</p> : view.unlocked ? <Unlocked org={org} view={view} onView={update} /> :
      <form className="ops-editor" onSubmit={event => { event.preventDefault(); void action.run(async () => {
        if (!view.initialised && passphrase !== confirm) throw new Error('The passphrases do not match.');
        try { update(await call(org.id, 'POST', view.initialised ? '/unlock' : '/create', { passphrase, keepUnlocked })); } finally { setPassphrase(''); setConfirm(''); }
      }); }}>
        <div className="row"><h3>{view.initialised ? 'Unlock the business vault' : 'Create a business vault'}</h3><HelpLink guide="email-and-accounts" section="vault-storage-and-recovery">About the vault</HelpLink></div>
        <p>{view.initialised ? 'Unlocking makes saved connections available to the teams you authorised.' : 'Choose a passphrase you can keep safely. It is not sent to the agents or stored on disk. There is no passphrase recovery.'}</p>
        <Field label="Vault passphrase"><input type="password" autoComplete={view.initialised ? 'current-password' : 'new-password'} value={passphrase} onChange={e => setPassphrase(e.target.value)} required minLength={12} maxLength={1024} /></Field>
        {!view.initialised ? <Field label="Repeat vault passphrase"><input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={12} maxLength={1024} /></Field> : null}
        <label className="access-check"><input type="checkbox" checked={keepUnlocked} onChange={e => setKeepUnlocked(e.target.checked)} /> Keep unlocked until I lock it or the server restarts, for unattended work</label>
        <button className="button button-primary" disabled={action.busy}>{action.busy ? 'Opening vault…' : view.initialised ? 'Unlock vault' : 'Create vault'}</button>
      </form>}
  </section>;
}
