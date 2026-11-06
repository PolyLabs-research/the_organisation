# GitHub repositories

An organisation can work on real repositories. Agents get a branch of their own for each plan, commit to it, start build workflows on GitHub's machines, read the results and open a pull request. A person merges. Nothing here has run against a real token yet: see [what has been checked](#what-has-been-checked).

## Connect a repository

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to that one repository, with an expiry date. Give it:

   | Permission | Level | Why |
   | --- | --- | --- |
   | Contents | Read and write | Read files and commit to a branch |
   | Pull requests | Read and write | Open a pull request |
   | Actions | Read and write | Start workflows, and read runs and logs |
   | Commit statuses | Read | See results from outside GitHub Actions. Without it no gate can pass |
   | Workflows | Write | Only if a role will change pipelines |

2. Open **Email & accounts**, then **Repositories**. Enter `owner/name`, the token and the teams that may use it. The server asks GitHub whether the token works, then keeps it in the encrypted vault. It never comes back to the browser, and it goes to no address but `api.github.com`.
3. List the workflows agents may start, by file name, such as `ci.yml`. Leave out anything that deploys.
4. Under **Privileges**, give each role what it needs. Reading is on. Pushing, starting workflows and changing pipelines are off.

**Protect the main branch on GitHub as well.** Require a pull request and a review. This program never writes to the main branch, but a rule on GitHub holds even if this program is wrong, or a token is taken.

## What agents can do

| Role holds | Agents can |
| --- | --- |
| Read assigned repositories | List and read files, and read checks, workflow runs and the end of a failed run's log |
| Push branches and open pull requests | Commit text files to the plan's branch, and open a pull request from it to the main branch. Editing a script keeps it runnable, and a new one can be marked runnable |
| Start build workflows | Start a listed workflow on the plan's branch |
| Change build pipelines | Commit under `.github`. The token needs the Workflows permission too |

Each plan has one repository and one branch, `agents/<organisation>/<plan>`. The engine names it, and no agent can name another. There is no way to merge, force a push, delete a branch or touch the main branch. A commit that contains a saved password or token, in a file, a file name or the message, is refused. Once a plan has passed its last gate its branch is closed, so that nothing unchecked can follow what was checked. Each outward step is recorded under **Access history**.

Repository work needs agents working on this machine. Hosted sessions cannot reach the vault.

## Building outside this machine

Local agents cannot run code, but GitHub Actions can. An agent pushes to its branch, and either a workflow that runs on a push starts by itself or the agent starts a listed one. The agent reads the result and the log, and fixes what failed. This works with any model, and costs your GitHub Actions minutes rather than model calls.

## Gates that read the repository

A phase can have a gate the system checks for itself. DevOps delivery has two:

- **Verify** passes only when every automated check on the latest commit of the plan's branch has passed.
- **Release** needs that, and an open pull request for the branch.

The gate reads GitHub, not what any agent reported, and a lead cannot overrule it. While checks are running it waits, looking every 20 seconds, with no model call. It gives checks 3 minutes to appear after a push and 30 minutes to finish. Time spent paused does not count.

At least one check has to have really passed. A commit with no checks does not pass, and neither does one whose checks were all skipped: the repository needs a workflow that runs on a push. Anything that cannot be read counts against the commit, including commit statuses the token cannot see and results too long to read. A failed gate sends the phase back up to three times, and then the plan stops and the board is told.

If a person merges the pull request while a gate is looking, the gate passes: a merge settles it, even if the branch was deleted with it. A pull request closed without merging does not count.

If the vault locks, the organisation pauses at the gate until a person opens it. If the repository is removed or disabled, the plan stops rather than spend more model calls on something that cannot be checked. Connect the same repository again before the gate is reached and the plan carries on.

## What is enforced, and what to watch

**Enforced by the program:** the branch, the workflow list, the privileges, `.github` for roles without the privilege, secrets in commits, and that nothing can be merged.

**Not stopped:**

- **Code an agent pushes runs in your checks.** A test script on the plan's branch runs with whatever those checks can reach, including any secret the workflow is given. The `.github` rule protects workflow files, not `package.json`, a Makefile or a test. Keep deployment secrets behind a [protected environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) that requires a person's approval, and do not give a test workflow anything it does not need.
- **A public repository is public.** Pushing a branch publishes it.
- **A listed workflow can do anything it is written to do.** The list is the line between building and deploying, so keep it short.
- **A token can do what GitHub lets it.** Limits here apply to agents using this program. Keep the token to one repository and the permissions above.
- **Passing checks prove what the checks test,** and no more. A person still reviews the pull request.
- **Secrets are matched exactly.** A saved password that has been encoded some other way, such as in base64, is not caught in a commit.
- **Third-party checks may not be seen.** If a fine-grained token cannot list check runs, the gate falls back on Actions' own runs and commit statuses, and a check run from an outside app would be missed. Required checks in GitHub's branch rules do not have this gap.

## What has been checked

Every read this program makes was run against the real GitHub API, without a token, on public repositories: the repository, files, a file, a branch, including a branch name with slashes in it, check runs, statuses, pull requests, merged ones among them, and workflow runs. Reading a build log needs a token, so that has not been tried. Commits, pull requests and starting workflows were tested against a local stand-in built from GitHub's documentation. Nothing has been written to a real repository, and no fine-grained token has been tried. GitHub's documentation does not say whether such a token can list check runs, so if it cannot, the program reads Actions' own record of its runs instead.

## Local API

Under `/api/orgs/:id/access`, with the same origin and loopback controls as the rest of the vault:

| Route | Purpose |
| --- | --- |
| `POST /repositories` | Check and connect `{ label, repository, token, workflows, ownerIds }` |
| `PATCH /repositories/:id/workflows` | Replace `{ workflows }` |
| `PATCH /repositories/:id` | Replace `{ ownerIds, enabled }` |
| `DELETE /repositories/:id` | Remove the connection and its token. The repository is left alone |
| `POST /repositories/:id/password` | Check and replace the token, as `{ password }` |

`PATCH /api/orgs/:id/work-approaches` with `{ seatId, approachId, allowed }` opens or closes an approach to a role.
