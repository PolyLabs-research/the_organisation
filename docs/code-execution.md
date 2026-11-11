# Running code in a sandbox

On this machine an agent reads and writes files. Whether its code runs, or its tests pass, used to be whatever it said. A role you allow can now run commands in a sandbox: a container on this machine that holds a copy of the workspace and has no way to the rest of the machine. The system keeps its own record of every command and how it ended, and the lead reads that record at the phase gate, beside the agent's report. A plan can also have a gate that the system checks by running a command itself: the phase passes if the command exits with 0, and not otherwise, whatever anyone reported.

It works with any model provider. [Hosted sessions](../README.md#hosted-sessions-claude-managed-agents) have a sandbox of their own on Anthropic's side and are not affected by any of this.

## Set it up

1. **Install Docker and start it.** Docker Desktop on macOS or Windows, Docker Engine on Linux. Nothing else is needed: there is no image to build.
2. **Allow a role.** Under **Privileges**, tick **Run code in a sandbox** for the roles whose agents should run things. It is off for every role to begin with.
3. **Choose the image and the network**, if the defaults do not suit, in an organisation's settings. See [Images](#images) and [The network](#the-network).

The first time a role is allowed, the image is fetched (several hundred megabytes for the default). If Docker is not running, or the image cannot be had, the board says so, and until it is put right the role's agents are told that they cannot run code, exactly as before. The Privileges page says which it is: what code is run with, from which image and whether it can reach the network, or what stands in the way.

Running code is switched off on a server that listens beyond loopback (`HOST` other than `127.0.0.1`). The API has no login, so anyone who could reach such a server could allow a role to run code and then have code run on your machine. `ORG_SANDBOX=off` switches it off everywhere.

## What agents get

Two tools, in every task of a role that may run code:

- **`run_command`** runs a shell command in the plan's sandbox, in a folder of the workspace, and returns the exit code and what was printed. An agent writes and changes files with its file tools as before, then runs them.
- **`save_from_sandbox`** brings files a command produced into the workspace, by name: a test report, a built artefact. Nothing a command writes reaches the workspace any other way.

The sandbox holds a **copy** of the workspace, brought up to date before each command: files that are new or changed are sent in, and files that have gone are removed. What commands leave behind in the copy (installed packages, build output) stays there for the plan's later commands, shared by the plan's tasks, and is removed when the cycle ends. An agent can ask for a fresh start, which empties the copy and brings the workspace in again.

Agents are told to run what can be run, to say in their report what they ran and how it ended, and that a command that failed has failed.

## What the system records, and who reads it

Each command is recorded on its task as it ends: the command, the folder, how long it took, and whether it exited by itself (and with what code), hit its time limit, was stopped with the work, was killed, or could not be run. The record is the system's, written by the code that ran the command. No model writes or edits it.

You read it under **Plans**: each task lists the commands it ran, in order, with where each was run, how it ended and how long it took, and the task's own line says how the last of them ended. A task that could run commands and ran none says so.

At the phase gate the lead is shown the same, under each task: what it ran and how that ended, or that it ran nothing. The lead is told to go by that record where an agent's report says more. A lead whose agents can run code is told so when it hands out a phase's tasks, so that it asks for work to be run and tested.

## A gate the system checks for itself

A record of what agents ran still leaves the verdict with the lead. For work that one command can prove, a lead can choose the **Tested build** approach for a plan in place of its own operating profile: Spec → Build → **Prove** → Release. The Prove phase has a gate that the system checks by running a command, as [DevOps delivery](../README.md#work-approaches) has gates it checks against a repository.

- **The lead names the check** as it hands out the Prove phase: the command that proves the work (its tests, its build), the folder to run it in, and how long it may take. That is five minutes unless the lead says, and never more than fifteen. The check is shown on the phase under **Plans**, and the phase's agents are told what it is, so that they run it themselves and get it passing.
- **The system runs it** when the phase's work is in, before the lead is asked anything. It runs in the plan's sandbox, confined like every other command, after the sandbox's copy has been brought up to date with the workspace.
- **Exit code 0 passes, and nothing else does.** A check that fails, runs out of time, is killed for the memory or the disk it used, or cannot be run because its folder is not there, holds the phase. The lead is shown the result and the end of what the check printed, and is told that the phase goes back for rework whatever it rules. It does.
- **A phase held this way can go back three times.** After that the plan stops, and the board says why. It stops at once if the role's privilege to run code has been taken away, since no number of goes could change that.
- **The lead can put a wrong check right.** If the check itself was the mistake (the wrong command, the wrong folder), the lead names another at the review, and the system runs that one next time. Each change goes on the board with what it replaced.
- **Docker stopping is nobody's failure.** If the check cannot be started because the container service has gone, the gate is tried again, and then the organisation pauses and says so. Start Docker and then the organisation, and the gate is checked. Stopping the organisation while a check runs stops the check, and it is run afresh when work starts again.

What the check printed is treated as every other command's output is: a saved password or token in it is blanked out before anyone is shown it, and a check that contains one is not run.

Tested build is offered to the engineering and data leads, and only while the role may run code, the container service answers, and agents work on this machine. You can close it for a role under **Approaches**. What it proves is that the command the lead named exited with 0 when the system ran it: see [what that leaves open](#what-this-does-not-do).

## What confines a command

Every command runs in a container of its own, started for it and removed when it ends. All of the following are options given to the container when it is started. None is an instruction to a model, and nothing an agent writes can change one.

| What | How |
| --- | --- |
| No way to the network | Started with no network at all, unless you open it in the settings. |
| Nothing of this machine's inside it | No folder of this machine is mounted. The workspace's files are sent in as an archive, and files come out only when asked for by name. The one thing mounted is the plan's own volume, which Docker keeps. |
| No privileges | Every capability dropped, with no way to gain any, and Docker's default system-call filter. |
| An ordinary user | Commands run as this server's own user, or as user 1000 where the server is run by root. Never as root. |
| A system it cannot change | The container's own filesystem is read-only. It can write to its work folder, its home folder and `/tmp`, which is 512 MB held in memory. |
| Memory | 2 GB, with no swap. A process that goes over is killed, and the agent is told that is why. |
| Processors and processes | 2 processors, and 512 processes at one time. |
| Disk | 4 GB for everything a plan's commands leave behind. No one file may be larger, and the total is measured every few seconds while a command runs: one that goes past it is stopped. |
| Time | 120 seconds unless the agent asks for longer, and never more than 15 minutes. Nothing a command starts goes on running after it: the container ends with the command. |
| How many at once | Four commands on the whole server. The rest wait their turn. |
| Its surroundings | Eight environment variables, the same every time (`HOME`, `USER`, `CI` and the like). Nothing of the server's own environment, where your API keys may be. |

`ORG_SANDBOX_MEMORY_MB` and `ORG_SANDBOX_CPUS` change the memory and the processors for the whole server.

The agent's command is handed to the container as one argument. It is never made part of a script, and no shell on this machine ever reads it. The folder is checked to be inside the workspace before anything is started.

Three further things, on this side:

- **A saved password or token never goes in, and does not come back.** A command that contains one is refused. One that a command prints is blanked out before a model sees the output.
- **Output is bounded.** The first 6,000 and the last 14,000 characters of what a command prints are kept, with colours and cursor movements taken out.
- **Taking the privilege away stops what is running.** So does pausing with Stop, cancelling the plan, or deleting the organisation.

## The network

A sandbox has no network unless **Let code in a sandbox reach the network** is ticked in the organisation's settings. Without it, a command has what its image came with and what is in the workspace, and nothing can be downloaded or installed. That is enough to run code that needs only the language's own library, such as tests written for Node's or Python's built-in test runner.

With it, code can install packages and fetch what it needs. It can also reach **any** site, and this machine's own network: your router, other machines on it, and anything on this machine that listens on all addresses. Whatever the code can read, which is a copy of the whole workspace, it can send anywhere. There is not yet a setting that allows package registries and nothing else. Open the network for an organisation whose workspace you would be content to see leave the machine, and close it again when the installing is done: what was installed stays in the plan's sandbox.

The switch applies to commands started after it is changed.

## Images

A sandbox is started from a container image, named in the organisation's settings. The default is `node:22-bookworm`: Node.js 22, Python 3 with its standard library, git, and the usual tools for building software. For Python work with packages, `python:3.12-bookworm` is the obvious choice. Any image will do that has a shell and the common tools (`tar`, `timeout`, `find`, `du` and their like): the small `alpine` has them. An image that lacks one is refused, with the name of what it lacks.

An image is run as it is. Choose one you trust, as you would for anything else you run in Docker. To hold a sandbox to exactly one build of an image, name it by digest (`node@sha256:…`).

## What this does not do

- **It is a container, not a virtual machine.** A container shares this machine's kernel. A flaw in the kernel or in Docker could let code out of one, and on Linux the Docker service usually runs as root. Docker Desktop, on macOS and Windows, runs containers inside a virtual machine of its own, which is a second wall. On Linux, [rootless Docker](https://docs.docker.com/engine/security/rootless/) is the stronger arrangement.
- **It bounds what code can use, not whether it is worth running.** Within its limits, a command does what it is written to do, for as long as it is allowed.
- **A gate proves what its check proves, and no more.** The lead chooses the command, and one that cannot fail will pass. The check is on the plan for you to read, and every change to it is on the board. There is not yet a way for you to set a check yourself, or to approve one before it counts.
- **A check runs in the plan's sandbox as the plan's commands left it.** That is what lets it use the packages an agent installed. It also means that a file a command made in the sandbox, and nobody brought out to the workspace, is there when the check runs. A check that passes says the work passes in that sandbox, which is not quite to say that the workspace alone would.
- **No registries-only network**, as above.
- **Nothing keeps running between commands.** An agent can start a server, test it and stop it within one command, but cannot leave one running.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORG_SANDBOX` | on | `off` switches running code off on this server, whatever a role is allowed. |
| `ORG_SANDBOX_COMMAND` | `docker` | The command that runs containers. One that takes the same arguments, such as `podman`, should work and has not been tried. |
| `ORG_SANDBOX_MEMORY_MB` | `2048` | The memory one command may use. |
| `ORG_SANDBOX_CPUS` | `2` | The processors one command may use. |

## What has been checked

Everything in the table above is tested in real containers, on Docker 29 on Linux: that a command cannot reach the network, cannot see this machine's files, holds no capability, cannot write to its system, and is stopped at each of its limits; that files go in and come out as described; that the leavings of a finished plan are removed. Whole simulated organisations are run with agents that run commands, and the record is checked on every task and in what the lead is shown. A gate that runs a check is taken through whole simulated plans in real containers: a check that passes, one that fails and is put right, one that never passes, one that runs out of time or of memory, one named for a folder that is not there, one the lead corrects, a role that loses the privilege, and an organisation stopped while its check runs. What is sent to Docker is also checked against a stand-in for the `docker` command, on any machine.

Not yet tried: Docker Desktop on macOS or Windows, Podman, rootless Docker, and any real model deciding what to run or which check to name.
