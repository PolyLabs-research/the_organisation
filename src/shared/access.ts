import { z } from 'zod';

/** These views are safe for the dashboard. Passwords and cookies are kept separately, on the server. */
export interface MailboxView {
  id: string; provider: 'imap' | 'gmail'; label: string; address: string; username: string;
  imapHost: string; smtpHost: string; smtpPort: 465 | 587;
  ownerIds: string[]; enabled: boolean; createdAt: string;
}
export interface AccountView {
  id: string; label: string; origin: string; loginUrl: string; signupUrl: string;
  resourceOrigins: string[]; username: string; mailboxId: string;
  ownerIds: string[]; allowSignup: boolean; enabled: boolean; createdAt: string;
}
/** A GitHub repository connected to the vault. The token stays on the server, as a password does. */
export interface RepositoryView {
  id: string; label: string;
  /** owner/name */
  fullName: string; defaultBranch: string; private: boolean; htmlUrl: string;
  /** What GitHub says the token can do. */
  canPush: boolean;
  /** The workflow files agents may start. Anything else, such as a deployment, stays with a person. */
  workflows: string[];
  ownerIds: string[]; enabled: boolean; createdAt: string;
}
/** How many connected tools one role's agents are offered. Each one is described to the model in every task, which is paid for. */
export const MAX_OFFERED_TOOLS = 60;
/** One tool on a connected server, as the server described it when its tools were last read. */
export interface ToolView {
  /** The server's own name for it. */
  name: string;
  /** The name agents call it by: the server's prefix, then this. */
  callName: string;
  description: string;
  /** What it takes, by name, and what the server says of each. Those it cannot be called without come first. */
  takes: Array<{ name: string; required: boolean; about: string }>;
  /** What it takes in full, as a JSON Schema: with the description, this is everything a model is shown about the tool. */
  inputSchema: { [key: string]: unknown };
  /** What the server says of it. A server can say anything, so this informs a person and decides nothing. */
  says: 'reads' | 'changes' | 'deletes' | '';
  /** Stands for everything said of the tool here. Allowing it names this, so that what is allowed is what was on the page. */
  fingerprint: string;
  /** A person has allowed it as it is described here. Nothing else is ever offered to an agent. */
  allowed: boolean;
  /** It was allowed, and the server has described it differently since. It is kept back until it is allowed again. */
  changed: boolean;
  /** Why it cannot be offered at all, if it cannot. */
  unusable: string;
}
/** A server that offers tools over the Model Context Protocol. Its token stays on the server, as a password does. */
export interface ToolServerView {
  id: string; label: string;
  /** What goes in front of each of its tools' names, so that two servers' tools cannot be mistaken for each other. */
  prefix: string;
  url: string; hasToken: boolean;
  /** The header the token is sent in. In Authorization it goes as a bearer token, and in any other as it is. */
  header: string;
  /** What the server calls itself. */
  serverName: string;
  tools: ToolView[];
  /** How many more tools the server offers than are kept here. */
  toolsLeftOut: number;
  toolsReadAt: string;
  ownerIds: string[]; enabled: boolean; createdAt: string;
}
export interface MailSummary { id: string; from: string; subject: string; date: string; }
export interface MailMessage extends MailSummary { text: string; truncated: boolean; }
export interface MailDraft {
  id: string; mailboxId: string; to: string; subject: string; text: string; actorId: string;
  status: 'draft' | 'sending' | 'sent' | 'uncertain'; createdAt: string; sentAt: string | null;
}
export interface AccessRequest {
  id: string; actorId: string; service: string; reason: string; status: 'open' | 'resolved'; createdAt: string;
}
export interface AccessAudit { at: string; actorId: string; action: string; targetId: string; }
export interface AccessView {
  available: boolean; reason?: string; initialised: boolean; unlocked: boolean; googleConfigured?: boolean; autoLockMinutes?: number;
  mailboxes: MailboxView[]; accounts: AccountView[]; repositories: RepositoryView[]; toolServers: ToolServerView[]; drafts: MailDraft[];
  requests: AccessRequest[]; audit: AccessAudit[];
}
export const ownersSchema = z.array(z.string().min(1).max(80)).max(20);
const short = z.string().trim().min(1).max(160);
const host = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/);
export const mailboxSchema = z.object({
  label: short, address: z.email().max(254), username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(2048), imapHost: host, smtpHost: host,
  smtpPort: z.union([z.literal(465), z.literal(587)]).default(465),
  ownerIds: ownersSchema,
}).strict();
export const accountSchema = z.object({
  label: short, loginUrl: z.url().max(2000), signupUrl: z.union([z.literal(''), z.url().max(2000)]).default(''),
  resourceOrigins: z.array(z.url().max(300)).max(10).default([]),
  username: z.string().trim().min(1).max(254), mailboxId: z.string().max(80).default(''),
  password: z.string().max(2048).default(''), ownerIds: ownersSchema, allowSignup: z.boolean().default(false),
}).strict();
export const workflowFile = z.string().trim().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/, 'Use the workflow’s file name, such as ci.yml');
export const repositorySchema = z.object({
  label: short,
  repository: z.string().trim().min(3).max(300),
  token: z.string().trim().min(20).max(512).regex(/^[\x21-\x7e]+$/, 'A token has no spaces'),
  workflows: z.array(workflowFile).max(20).default([]),
  ownerIds: ownersSchema,
}).strict();
export const repositoryWorkflowsSchema = z.object({ workflows: z.array(workflowFile).max(20) }).strict();
/** A token is optional: a server on this machine often asks for none. */
export const toolServerSchema = z.object({
  label: short,
  url: z.string().trim().min(1).max(2000),
  token: z.union([z.literal(''), z.string().trim().min(8, 'A token has at least 8 characters').max(2048).regex(/^[\x21-\x7e]+$/, 'A token has no spaces')]).default(''),
  header: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'A header’s name has letters, digits and hyphens').default('Authorization'),
  ownerIds: ownersSchema,
}).strict();
/** The tools a person allows, each as it was described on the page they allowed it from. Every other tool on the server is not allowed. */
export const allowedToolsSchema = z.object({ allowed: z.array(z.object({ name: z.string().min(1).max(300), fingerprint: z.string().min(1).max(100) }).strict()).max(200) }).strict();
export const draftSchema = z.object({
  mailboxId: z.string().min(1), to: z.email().max(254),
  subject: z.string().trim().min(1).max(300).regex(/^[^\r\n]*$/),
  text: z.string().min(1).max(20000),
}).strict();
export const browserActionSchema = z.object({
  accountId: z.string().min(1),
  action: z.enum(['login', 'signup', 'inspect', 'fill', 'click', 'navigate', 'close']),
  element: z.number().int().min(0).max(199).optional(),
  value: z.string().max(2000).optional(),
  source: z.enum(['username', 'password', 'email', 'text']).optional(),
  url: z.string().max(2000).optional(),
}).strict();
export type BrowserAction = z.infer<typeof browserActionSchema>;
export interface AccountPage {
  url: string; title: string; text: string;
  elements: Array<{ id: number; tag: string; type: string; label: string }>;
  notice: string;
}
