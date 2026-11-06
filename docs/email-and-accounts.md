# Business email and accounts

Each organisation has an **Email & accounts** desk for connected mailboxes, service credentials, outgoing drafts, access requests and an audit history. Local task agents use these connections through four tools: `business_access`, `read_business_email`, `draft_business_email` and `account_browser`.

## Connect Gmail or Google Workspace

The app uses Google OAuth with Gmail read and send scopes. It does not ask for your Google password. Tokens are kept in the organisation's encrypted vault.

1. In your [Google Cloud project](https://console.cloud.google.com/apis/library/gmail.googleapis.com), enable the Gmail API.
2. Configure the OAuth consent screen. For a Workspace organisation, use an internal app if available. For an external app in testing, add the Google accounts that will connect as test users. Your Workspace administrator may need to allow the app.
3. Create an OAuth client of type **Web application**. Add the exact redirect URI shown in **Email & accounts**. With the default address it is:
   ```text
   http://127.0.0.1:4780/api/oauth/google/callback
   ```
   If you open the app through `localhost` instead, register that hostname too. The hostname and port must match.
4. Add the following to the server's ignored `.env`, then restart the server:
   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
5. Open an organisation's **Email & accounts**, create its vault, and keep its passphrase somewhere safe. Select the teams that may use the mailbox and click **Connect Gmail with Google**. Grant both requested permissions and return to the dashboard.

The scopes are `gmail.readonly` and `gmail.send`. No delete, forwarding or settings permission is requested. Google classifies these as restricted and sensitive respectively; distributing an OAuth app outside your own testing or Workspace organisation can require Google's verification. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [Google's web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server) for consent, publication and refresh-token requirements. Reconnect if consent expires, access is revoked, or Google refuses a refresh.

The OAuth callback uses an expiring, single-use state, a browser cookie, PKCE and the current vault session. Locking the vault invalidates a pending sign-in. The server discovers the mailbox address from Google; an agent cannot supply a different sender identity.

**Other providers:** the expandable IMAP/SMTP form supports an app password with IMAP over TLS on port 993 and SMTP over TLS on 465 or required STARTTLS on 587. It checks both connections before saving. Use Google sign-in for Gmail. Microsoft OAuth is not implemented.

## Give the agents access

Access is assigned explicitly to executive teams. Their local task agents inherit it. The CEO does not automatically get every mailbox or account. Leave every team unchecked to keep a connection for a person only. Grants are checked at each operation, and disabling or removing a connection cancels operations using it.

What a team may do with a connection is set role by role under **Privileges**, and a role needs both. [What each role may do](../README.md#what-each-role-may-do) lists them. A role starts able to read and draft mail, and to sign in to its accounts and read them. Acting on an account and creating one are off until you turn them on for that role. Each mailbox and account shows what its teams can actually do.

Agents can list the latest 20 inbox messages and read a selected message as plain text, limited to 20,000 characters. Attachments and remote images are not opened. Reading does not mark mail as read. Messages an agent reads are sent to its configured model provider; use a dedicated business mailbox rather than a personal inbox. Agents are told to treat incoming messages as untrusted content, not authority to change the company's instructions. That is an instruction to the model, not a barrier: see [below](#what-is-enforced-and-what-is-only-instructed).

There is no background inbox poller. Give a lead a calendar commitment to review its inbox, or steer it to check for a particular reply. Access works with **local task execution**, including the Claude Code provider's local tools. Hosted Managed Agents sessions cannot reach this vault.

## Service accounts and passwords

Under **Accounts**, enter the service's HTTPS login URL, username, existing password, verification mailbox and allowed teams. For a new account, enable account creation and provide a sign-up URL on the same origin; the role also needs **Create accounts** under Privileges. Leaving the password blank generates and saves a random password before the agent submits a form. Authorising a service grants the selected teams browser access to that service. Choose services and registration terms you intend the business to use.

The account browser opens the authorised site, describes visible form controls, fills or clicks a returned element ID, and follows verification links on that same origin. Passwords are filled by the server into password inputs; the model receives neither the password nor cookies. Saved passwords are also removed from everything a page returns, as they are and as URLs and web forms encode them. A site that shows one in some other form, such as base64, is not caught. A person can reveal a saved account password for 30 seconds in the dashboard. **Update saved password** records a password already changed at the external service; it does not rotate that service's password for you.

A service can have additional explicitly trusted origins for its scripts, assets and APIs. Top-level navigation stays on the account's main origin. Private, loopback and reserved network destinations are refused, DNS answers are pinned for the connection, TLS certificates are verified, and browser downloads, popups, service workers and WebSockets are disabled.

Install Google Chrome on the server for account browsing, or set `ORG_BROWSER_PATH` to an installed Chromium executable. The package uses `playwright-core`; it does not download a browser automatically. Browser sessions are isolated per task, close when the task finishes or access is revoked, and expire after ten minutes idle. Sessions are not exported or reused across tasks.

A form submission is not evidence that an account exists or login succeeded. The agent must inspect the resulting page. It can request help under **Access requests** for a new service, CAPTCHA, MFA or an unsupported login flow. The dashboard's account browser can fill a text verification code. Graphical challenges, passkeys and cross-origin SSO may need a person or another integration. Agents are told that payments and new contractual commitments go to the Signatory. The browser is not a payment integration, but for a role with **Act on accounts** it can press whatever the account can press.

Without Act on accounts, a session gets one sign-in, or one sign-up for a role that may create accounts. It has to be made on the page the session opened on, in a form with one password field for a login, after the saved password is filled in. After that, and for anything else, the browser refuses every request but GET, HEAD and OPTIONS, whatever the agent presses and whatever the page's scripts try. If a page tries to go somewhere by a blocked request, the agent is told, and the browser reloads the page it was on. If a login was mistyped, closing the session and opening the login again gives another try. Because this goes by the kind of request, a site that changes something on a plain GET is not stopped, and a login in two steps, or a site that reads through POST, may not work without Act.

## What is enforced and what is only instructed

**Enforced by the program, whatever a model decides:**

- An agent cannot get a saved password, a Google token or a session cookie from the vault.
- An agent cannot send email. A person presses **Send this email** for every message.
- A team reaches only the mailboxes and accounts granted to it, and only while the vault is unlocked.
- A role does only what it holds under Privileges. Losing a privilege stops what it has under way with email or an account, and closes its browser sessions.
- A role without **Act on accounts** cannot send a change to a service, apart from its one sign-in, unless the site changes something on a plain GET.
- The browser stays on the service's origin, reaches only the service's trusted origins, and cannot reach private addresses.

**Only instructed: the model is told, and nothing else stops it:**

- For a role with **Act on accounts**, not to make purchases or enter new commitments through the browser. Such an agent can press whatever that account can press: place an order, change a delivery address, post a message, delete something, close the account. Creating an account can accept the site's terms. There is no person in the loop for this, as there is for email.
- To treat email and web pages as data, not instructions. Anyone can email a connected mailbox, and a model can be talked into things. If an email persuades an agent, the outgoing-email review will catch a draft, but not what an agent with Act on accounts does in a browser.

So choose what you connect with that in mind:

- Leave **Act on accounts** off unless a role needs it, and do not give it to a role on an account that holds a saved card, can order on credit, or could do damage if pressed the wrong way. Keep payment methods off accounts the agents use.
- Think twice before giving one role both a mailbox that strangers can write to and Act on an account that can spend or publish. What the agent reads in one can go out through a form in the other. The Privileges panel warns of this.
- Give each account the lowest role the service offers, and read **Access history** now and then.

## Outgoing email

Agents prepare plain-text drafts. A person reviews the sender, recipient and full content, then clicks **Send this email**. There is no agent send tool. Drafts have one recipient, no attachments and no remote content.

Before contacting Gmail or SMTP, the server saves the draft as `sending`. A confirmed API/SMTP acceptance changes it to `sent`. A timeout, cancellation or restart leaves it `uncertain`; the server will not automatically send it again. Check the external mailbox before preparing another copy. An accepted message is not proof that the recipient read it.

## Vault storage and recovery

The vault is `data/orgs/<org-id>/access-vault.json`, outside the agents' workspace. It encrypts credentials, tokens, drafts, requests and audit records with AES-256-GCM, a random salt and scrypt-derived key. Its authenticated data binds it to the organisation ID. Writes use a private temporary file and atomic rename; the file's mode is 0600.

The passphrase is not stored. Keys and decrypted records remain in the server process while unlocked. By default the vault locks after 30 minutes without an access action. Select **Keep unlocked until I lock it or the server restarts** when you want unattended scheduled work. A restart always requires unlocking again, even if the organisation resumes automatically. Locking closes account browsers and cancels active connection operations.

Use **Download encrypted backup**, and keep the organisation ID and passphrase with your recovery records. Restore the file to that same organisation's directory while the server is stopped. There is no passphrase reset or recovery. The existing model-provider key store is separate and is not migrated by this feature.

The app still has no multi-user authentication. Email and account controls therefore require a loopback server, reject foreign browser requests, and send no-cache responses. This is a local vault for the app, not a replacement for a separately administered enterprise password-management service. Someone controlling the server process or the local user account can use credentials while it is unlocked.

## Only Paperclips example

For a real business using the fictional example's structure:

1. Connect a dedicated business Gmail mailbox and grant the COO access.
2. Authorise the wholesaler's actual service account for the COO, with that mailbox for verification.
3. Add a recurring calendar commitment for supplier-email triage.
4. Under **Privileges**, give the COO **Create accounts** if it is to register, and **Act on accounts** if it is to do more than read. Steer the COO to register or log in to that approved supplier, read its verification email, inspect the result and record evidence on the commitment.
5. Review outgoing enquiries under **Email drafts** and handle any requests requiring a person.

The bundled Only Paperclips demo connects no mailbox or service, and sends no real messages.

## Validation

Tests cover encrypted persistence, corruption and wrong passphrases, cross-organisation and cross-team isolation, role privileges at each point they are enforced, revocation, secret redaction, duplicate-send prevention, OAuth cookie/state/PKCE binding, Gmail token refresh and MIME messages, and agent-tool integration. Real Chrome tests use an in-memory supplier site to register, verify and log in, check what a read-only role can and cannot send, and exercise the dashboard against a fake mailbox. No live Google account, external signup, email delivery or paid service is used in the tests. Run `npm run build` before `npm test` for the dashboard tests; Chrome tests are skipped if Chrome is absent.

## Local API

Routes below are under `/api/orgs/:id/access`, inherit the existing origin controls, and require a loopback binding.

| Route | Purpose |
| --- | --- |
| `GET /` | Public vault state; never returns credentials |
| `POST /create`, `POST /unlock` | `{ passphrase, keepUnlocked?: boolean }` |
| `POST /lock` | Lock and cancel active operations |
| `GET /backup` | Download the encrypted file |
| `POST /google/start` | Begin Google sign-in with `{ label, ownerIds }` |
| `POST /mailboxes` | Check and add IMAP/SMTP credentials |
| `POST /accounts` | Authorise a service and save or generate its password |
| `PATCH /mailboxes/:id`, `PATCH /accounts/:id` | Replace `{ ownerIds, enabled }` |
| `DELETE /mailboxes/:id`, `DELETE /accounts/:id` | Remove a local connection |
| `POST /:kind/:id/password` | Update an existing saved password; reconnect Google through OAuth |
| `POST /accounts/:id/reveal` | Person-only password reveal, recorded in the audit |
| `GET /mailboxes/:id/messages` | Latest inbox summaries |
| `GET /mailboxes/:id/messages/:messageId` | Bounded plain-text message |
| `POST /drafts` | Prepare `{ mailboxId, to, subject, text }` |
| `POST /drafts/:id/send`, `POST /drafts/:id/remove` | Person reviews/sends or clears a draft |
| `POST /requests/:id/resolve` | Mark a request handled |
| `POST /browser` | Person operates an account browser |

`PATCH /api/orgs/:id/privileges` with `{ seatId, privilege, allowed }` sets what a role may do, under the same origin controls.

Google redirects to the static `/api/oauth/google/callback` endpoint. The agent tools call the same access service with their bound lead identity; they cannot call the person's routes, change grants or privileges, reveal secrets or send drafts.
