# the_organisation

A self-hosted app that runs a company of LLM agents: a CEO, up to eight leads on fixed operating profiles, one to eight agents under each, a board, a budget, and a signatory, who is a person and the only one who pays or signs. TypeScript throughout: Node 22, Express 5, React 19, Vite, vitest, zod.

`README.md` is the description of record. `docs/user-guide.md` is the how-to. Read the README's **Status** and **Limits of this version** before judging what works: most of it has been run against the simulator and stand-ins, and little against real models.

## Commands

- `npm run dev`: the server, with a hot-reloading client, on <http://127.0.0.1:4780>. With no key it runs in simulation and spends nothing.
- `npm run typecheck` and `npm test`: both must pass. One file: `npx vitest run tests/memory.test.ts`. One test: add `-t "part of its name"`.
- `npm run build`: the client. The tests that drive it in a browser need it built first.
- `REQUIRE_BROWSER=1 npm test`: the browser tests are compulsory. Without it they are skipped when the build or Chrome is missing. Set `CHROME_PATH` if Chrome is not at `/opt/google/chrome/chrome`.
- `REQUIRE_SANDBOX=1 npm test`: the tests that run real containers are compulsory. They need Docker running. `ORG_SANDBOX_TEST_IMAGE` names the image they use.
- `.github/workflows/ci.yml` runs the type check, the build and the suite with both of those set, on every pull request and every push to `main`.

A test that was skipped has checked nothing. When you report a run, say what was skipped and why.

## How it is put together

- `src/shared/`: what server and client both use. `types.ts` is the model of an organisation.
- `src/server/engine/`: the loop. `work.ts` says what work is ready, `handlers.ts` does one piece of it and returns what to write back, `runner.ts` runs as much as there is room for and asks again when something finishes. It is a reconciler over state, so pause, stop and restart need nothing special.
- `src/server/providers/`: the models. `mock.ts` is the simulator; `router.ts` sends each call to the provider its model is on.
- `src/server/`: `app.ts` is the HTTP API and the live stream; `workspace.ts` the agents' files; `sandbox.ts` running code; `memory.ts` the organisation's memory; `access*.ts` the vault, mail, accounts, GitHub and tool servers.
- `src/client/`: React. `Dashboard.tsx` is the shell of an organisation's page and its tabs are in the files beside it, several of them in `Tabs.tsx`. The headquarters is `headquarters.ts`, which works out from the state where every room stands and what is going on in it and draws nothing, and `Headquarters*.tsx`, which draw it.
- `data/`: everything an organisation is, as plain JSON on disk, ignored by git. `data/orgs/<id>/org.json` is live state, `activity.jsonl` has one line per model call, `archive/` holds older cycles and `workspace/` what the agents wrote. To find out what a run did, read those.

## Rules for a change

- A change in behaviour comes with a test that fails without it. Once the tests are written, take each new behaviour away in turn and see that a test fails. Add tests for whatever slips through, and delete code that turns out to do nothing.
- Tests never call a real provider. Use the simulator and the stand-ins in `tests/fake-*`: Claude Code, Docker, GitHub, Managed Agents, MCP and OpenAI.
- The README and the guides change with the code, in the same commit. Keep **Status** and **Limits of this version** true: say what has been run for real and what has not.
- No new dependencies without asking.
- Each commit passes by itself.
- Never commit `data/` or `.env`.
- Do not open a pull request, push to `main` or merge unless asked. When you do open one, check its base.

## Style

- British spelling. Plain sentences. A comment says why, in the voice of the comments around it.
- A commit's subject is imperative and says what a person will notice. Its body says what happened before and what happens now. No `fix:` or `feat:` prefixes.
- A pull request's description goes: Why, a section for each feature with bold-led bullets, Dependencies, Tests, Not covered, Reviewing.
- TypeScript is strict, with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.

## What must stay true

- What a model writes is not trusted. On screen its links are shown as words and its images as their labels (`Markdown` in `src/client/ui.tsx`), and what is asked of the signatory is shown as written.
- What a role may do is enforced in code where the thing is done, and never by asking the model.
- Keys and saved passwords stay on the server. They are not sent to the browser, not shown to a model, and blanked out of what a sandbox prints.
- Paying and signing are a person's. Nothing in the program moves money or signs.

## Anything on screen

- Build it and look at it in a real browser, at several window sizes and in dark mode, before calling it done. Screenshots have caught what tests did not. `tests/headquarters-ui.test.ts` shows how to start a server on the simulator and drive the built client with `playwright-core`, which is already a dependency.
- How a thing stands is never told by colour alone: it has a glyph, a shape or a label as well.
- Nothing moves for whoever has asked their system for less motion.
- Whatever a pointer can reach, the keyboard can reach too, there or in a list beside it.

## What has gone wrong before

- A pull request had its base pointed at a feature branch and was merged there, not into `main`.
- A test had a date written into it, and the date passed. A test takes its clock from the test.
- A stand-in more forgiving than the real thing hid faults: the one for `docker` said files had arrived without reading them. Where the real thing is to hand, test against it too.
- GitHub's machine behaved differently from a local one: a process that ran out of memory took its whole container down. Some things are only seen there.
- Browser tests that measured while something was still moving, or read where the page was before a scroll had finished, failed now and then. Wait until it is at rest, then measure.
- A file written twice within a millisecond, at the same size, looked unchanged to whatever compared size and time.
