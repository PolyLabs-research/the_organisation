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
  mailboxes: MailboxView[]; accounts: AccountView[]; repositories: RepositoryView[]; drafts: MailDraft[];
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
