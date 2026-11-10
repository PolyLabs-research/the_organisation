# Tool servers

An organisation's agents can use tools from other programs and services, through servers that speak the [Model Context Protocol](https://modelcontextprotocol.io) (MCP): an issue tracker, a database, a payments dashboard, a program of your own. You connect a server, it says what tools it offers, and you choose which of them a team's agents may call. Nothing here has been run against a third party's server yet: see [what has been checked](#what-has-been-checked).

## Connect a tool server

About 5 minutes. Step 1 happens at the service, the rest in the app.

### 1. Find the server's address, and get a token for it

- **Address:** the one the service documents for its MCP server over HTTP, which usually ends in `/mcp`. It has to be an HTTPS address. A server running on this machine can be plain HTTP at `http://localhost:<port>/…`.
- **Token:** where the service takes an API key or an access token, create one for this and nothing else, limited to what agents should be able to do: reading only, or one project, where the service offers that. A server that asks for none needs none. Some services put a key in the address itself. That works, but prefer the token field where the service gives the choice: the address is kept in the vault and shown on the server's card, and it is not blanked out of what tools return the way a token is.
- **What cannot be connected yet:** a server that wants you to sign in through the browser (OAuth), a server that is started as a command on this machine (stdio), and the older addresses that end in `/sse`. A bridge program can put a command-started server behind a local HTTP address, and then it is a server on this machine like any other.

### 2. Open the form in the app

Open the organisation, the **Email & accounts** tab, then **Tool servers** → **Connect a tool server**. The vault has to be unlocked: see [Email & accounts](email-and-accounts.md#8-connect-the-mailbox-in-the-app) for creating it.

### 3. Connect

- **Name:** what you call it. Its first letters go in front of each tool's name, so that agents see `orders__find_order` and two servers' tools cannot be mistaken for each other.
- **Address** and **Token:** from step 1. Leave the token empty for a server that asks for none.
- **Header for the token:** leave it empty unless the service's documentation names a header of its own for the key, such as `X-API-Key`. The token is otherwise sent as a bearer token, which is what most servers take.
- Tick the teams whose agents may use it, and click **Connect tool server**.
- **Check:** the server is asked for its tools before anything is saved, so a wrong address or a refused token is said at once. The server then shows as a card listing its tools, none of them allowed. The token is kept in the encrypted vault, never comes back to the browser, and is sent only to the site you gave: if the server answers by pointing to another site, the request is not sent on.

### 4. Allow the tools agents may call

On the server's card, read what each tool does, tick the ones agents may call, and click **Save allowed tools**.

- **The card shows everything a model will be shown about a tool:** its description, each value it takes and what the server says about that value. **Everything a model is shown about it** opens the whole of it, to the letter. A description is how a server tells a model what to do, so read it as you would read instructions to your staff.
- **Nothing is hidden in it.** Characters that take up no room on the page, which a model would read and you could not see, are taken out of the descriptions. A tool that carries them anywhere else, such as in one of the values it accepts, cannot be allowed at all.
- **A label such as "Says it only reads"** is the server's own word about the tool, shown to help you choose. Nothing checks it.
- **A tool marked as one that cannot be offered** describes what it takes in a way a model provider would refuse, and the card says in what way.

### 5. Give the role the privilege

On the **Privileges** tab, turn on **Use connected tools** for each role whose agents should have them. It is off until you do.

To replace a token later, use **Replace token** on the server's card. The server is asked for its tools with the new token before it is saved.

## What agents can do

A team's agents are offered the tools you allowed, on the servers assigned to their team, while their role holds **Use connected tools**. Their lead is told which tools those are, so that it can plan work that uses them.

- **Every call is checked when it is made:** the privilege, the assignment to the team, and that the tool is still allowed as it is described. Take any of them away and the next call is refused. A call under way is stopped.
- **Every call is recorded** under **Access history**, with the role, the server and the tool.
- **What a tool returns comes back as text**, marked as untrusted content. Pictures, recordings and attached files are named and not passed on. A saved password or token found in a result is blanked out, and a call whose values contain one is refused.
- **A task keeps one session with a server** for all its calls, since some servers keep their place between calls. The session ends with the task.
- **Limits:** 20 servers in a vault, 150 tools kept for a server, 60 connected tools offered to one role, two minutes for a call, and 60,000 characters of a result. Each allowed tool is described to the model in every task of the team, which is paid for like the rest of the prompt, so allow what is needed and not everything on offer. A server's card says roughly what its ticked tools add to each task, and the pane says so if a team has more than 60 allowed, since the ones past 60 are left out.

Connected tools need agents working on this machine. Hosted sessions cannot reach the vault.

## When a server changes its tools

Agents are always shown a tool as it was described when you allowed it, whatever the server says later. To see what a server offers now, click **Read the server's tools again** on its card.

- A tool that is now described differently, in its description, in what it takes or in what the server says it does, is marked **Changed since you allowed it** and kept back from agents until you allow it again.
- A tool the server no longer offers is dropped, and its allowance with it. If one of the same name comes back, it starts unallowed.
- New tools arrive unallowed.

## What is enforced, and what to watch

**Enforced by the program:** which servers a team can reach, which tools on them, the privilege, that agents see a tool only as you allowed it and with nothing in its description that you could not see, that the token goes only to the site you gave, and that no saved password or token is sent or handed back.

**Not stopped:**

- **A tool does what its server lets it do, and no person checks each call.** Allowing `cancel_order` lets agents cancel any order the token can cancel. Keep tokens narrow and allow only the tools the work needs.
- **What agents send leaves this machine.** The values of a call go to whoever runs the server. Saved passwords and tokens are caught. Anything else the agents know about the business is not.
- **What a tool returns can steer an agent.** A result is marked as untrusted, which lowers the risk and does not remove it. A role that can read from an outside source and also change something, through a connected tool, an account or a repository, can be steered by what it reads.
- **The server's word is not checked.** A server can change what a tool does without changing a word of its description, and "only reads" is a claim.
- **Secrets are matched exactly.** A saved password that has been encoded some other way, such as in base64, is not caught.
- **A server on a private network can be reached.** The address is yours to give, so it may be an internal one. No agent can choose or change it.
- **One tool can stop a team's tasks.** A tool's description of what it takes is checked before it can be allowed, and one a model provider would refuse is marked as not offerable. The check cannot know every provider's rules. If a team's tasks start failing with a refused request after you allow a tool, take the tick away.

## What has been checked

The tests run the protocol's official client, which this program uses, against a real server of the protocol on the same machine: connecting, listing, allowing, calling, sessions, tokens, a server that forgets its sessions, and one that sends a request elsewhere. No third party's server has been connected, and no call has been made through a real model provider with a connected tool in its list.

## Local API

Under `/api/orgs/:id/access`, with the same origin and loopback controls as the rest of the vault:

| Route | Purpose |
| --- | --- |
| `POST /toolServers` | Ask the server for its tools and connect `{ label, url, token, header, ownerIds }`. `header` is where the token goes, and is `Authorization` if left out |
| `POST /toolServers/:id/tools/read` | Ask the server for its tools again |
| `PATCH /toolServers/:id/tools` | Replace the allowed tools: `{ allowed: [{ name, fingerprint }] }`, each as the access view shows it |
| `PATCH /toolServers/:id` | Replace `{ ownerIds, enabled }` |
| `DELETE /toolServers/:id` | Remove the connection, its token and its allowances. The server is left alone |
| `POST /toolServers/:id/password` | Check and replace the token, as `{ password }` |
