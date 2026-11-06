import type { Executive, Organisation } from './types';

// What a role and its agents may do. The shareholders set these, per role, and nothing a seat or an agent does can
// change them. Each one is enforced where the thing is done: an agent is told what its role may not do, so that it
// does not waste its turns, but being told is not what stops it. A mailbox or an account must also be assigned to
// the team under Email & accounts: the privilege says what a role may do, the assignment says with what.

export type Privilege =
  | 'web_search' | 'update_records' | 'ask_signatory' | 'read_mail' | 'draft_mail' | 'sign_in' | 'act' | 'create_accounts'
  | 'read_code' | 'push_code' | 'run_workflows' | 'edit_pipelines';

export interface PrivilegeSpec {
  id: Privilege;
  group: string;
  label: string;
  detail: string;
  /** What the role may not do, as it reads after "you may not". */
  forbids: string;
  /** Where the shareholders have said nothing. Anything with an outside effect that no person checks starts off. */
  byDefault: boolean;
  /** Whether it means anything in a hosted session, which cannot reach the vault. */
  hosted: boolean;
  /** Whether the CEO, which has no agents, can hold it as well as the leads. */
  ceo?: boolean;
  /** A privilege that is of no use without this one. */
  needs?: Privilege;
}

export const PRIVILEGES: readonly PrivilegeSpec[] = [
  {
    id: 'web_search',
    group: 'Research',
    label: 'Search the web',
    detail: 'Look things up on the web. Web search also has to be on for the organisation.',
    forbids: 'search the web',
    byDefault: true,
    hosted: true,
  },
  {
    id: 'update_records',
    group: 'Business records',
    label: 'Update business records',
    detail: 'Change jobs, customers, the scorecard, finances and knowledge within the role’s remit.',
    forbids: 'change business records',
    byDefault: true,
    hosted: true,
    ceo: true,
  },
  {
    id: 'ask_signatory',
    group: 'Money and signatures',
    label: 'Ask the signatory to pay or sign',
    detail: 'Raise a request at a phase gate. A person still has to carry it out.',
    forbids: 'put requests to the signatory',
    byDefault: true,
    hosted: true,
  },
  {
    id: 'read_mail',
    group: 'Email',
    label: 'Read assigned mailboxes',
    detail: 'List and read messages in mailboxes assigned to this team.',
    forbids: 'read business email',
    byDefault: true,
    hosted: false,
  },
  {
    id: 'draft_mail',
    group: 'Email',
    label: 'Draft email',
    detail: 'Prepare a message for a person to review and send.',
    forbids: 'draft business email',
    byDefault: true,
    hosted: false,
  },
  {
    id: 'sign_in',
    group: 'Service accounts',
    label: 'Sign in and read',
    detail: 'Sign in to accounts assigned to this team and read them. The browser blocks anything else that would send a change.',
    forbids: 'sign in to service accounts',
    byDefault: true,
    hosted: false,
  },
  {
    id: 'act',
    group: 'Service accounts',
    label: 'Act on accounts',
    detail: 'Submit forms and press buttons on accounts assigned to this team. Agents can then do whatever the account can do, such as placing an order or deleting something, and no person checks first.',
    forbids: 'submit forms or change anything on a service account',
    byDefault: false,
    hosted: false,
    needs: 'sign_in',
  },
  {
    id: 'create_accounts',
    group: 'Service accounts',
    label: 'Create accounts',
    detail: 'Open the sign-up page of a service assigned to this team, where that account allows it, and submit it once. This can accept the service’s terms.',
    forbids: 'create service accounts',
    byDefault: false,
    hosted: false,
    needs: 'sign_in',
  },
  {
    id: 'read_code',
    group: 'Code',
    label: 'Read assigned repositories',
    detail: 'Read files, checks and build results in repositories assigned to this team.',
    forbids: 'read code repositories',
    byDefault: true,
    hosted: false,
  },
  {
    id: 'push_code',
    group: 'Code',
    label: 'Push branches and open pull requests',
    detail: 'Commit to a branch of the plan’s own and open a pull request. A person merges. Anything the repository’s checks run from that branch runs with what those checks can reach.',
    forbids: 'push code or open pull requests',
    byDefault: false,
    hosted: false,
    needs: 'read_code',
  },
  {
    id: 'run_workflows',
    group: 'Code',
    label: 'Start build workflows',
    detail: 'Start a GitHub Actions workflow on the plan’s branch, from the list set on the repository. It runs on GitHub’s machines and uses your account’s minutes.',
    forbids: 'start build workflows',
    byDefault: false,
    hosted: false,
    needs: 'read_code',
  },
  {
    id: 'edit_pipelines',
    group: 'Code',
    label: 'Change build pipelines',
    detail: 'Change files under .github, such as workflows. A workflow can use the repository’s secrets, so this comes close to handing them over.',
    forbids: 'change files under .github',
    byDefault: false,
    hosted: false,
    needs: 'push_code',
  },
];

/** What is always so, whatever is ticked: no setting changes these. */
export const EVERY_ROLE_CAN = ['Read and write files in the shared workspace', 'Read the board and the business records', 'Ask a person for help under Email & accounts'];
export const NO_ROLE_CAN = [
  'Send an email: a person reviews and sends every message',
  'See a saved password, token or session cookie',
  'Merge a pull request or push to a repository’s main branch: a person merges',
  'Change these privileges, or give itself access to anything',
  'Record a payment or a measurement as confirmed: only a person can',
  'Reach a private or local network address from the account browser',
];

export const PRIVILEGE_BY_ID = Object.fromEntries(PRIVILEGES.map((p) => [p.id, p])) as Record<Privilege, PrivilegeSpec>;

/** What the shareholders have said, role by role. A privilege they have said nothing about stands at its default. */
export type OrgPrivileges = Record<string, Partial<Record<Privilege, boolean>>>;

export function allows(org: Pick<Organisation, 'privileges'>, seatId: string, privilege: Privilege): boolean {
  return org.privileges[seatId]?.[privilege] ?? PRIVILEGE_BY_ID[privilege].byDefault;
}

/** The roles with anything to set: the leads, whose agents do the work, and the CEO. */
export function rolesOf(org: Pick<Organisation, 'executives'>): Executive[] {
  return org.executives.filter((seat) => seat.kind === 'ceo' || seat.kind === 'lead');
}

export function applies(seat: Pick<Executive, 'kind'>, privilege: PrivilegeSpec): boolean {
  return seat.kind === 'lead' || (seat.kind === 'ceo' && !!privilege.ceo);
}
