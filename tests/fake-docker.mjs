#!/usr/bin/env node
// A stand-in for the `docker` command, for the tests of the sandbox.
//
// It does two things. It notes every call it is given, so that a test can read exactly what a container was started
// with. And it either passes the call on to the real command, changing nothing, or answers for it in the way a
// container service does when something is wrong: the service is not running, an image cannot be had, a container
// will not start. Those are hard to arrange with a real service and easy to get wrong without one.
//
//   FAKE_DOCKER_LOG   a file to add each call to, one JSON list of arguments to a line
//   FAKE_DOCKER_REAL  the real command, to pass calls on to. Left out, nothing real is ever run
//   FAKE_DOCKER_SAYS  what is wrong: down, no-image, no-tools, no-volume, refused. Or how a command that was run ended:
//                     killed (the command alone), starved (the command alone, for memory), killed-whole (everything in the
//                     container at once). Left out, nothing is wrong and a command ends by itself
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const says = process.env.FAKE_DOCKER_SAYS ?? '';
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n');

const fail = (code, message) => {
  process.stderr.write(message + '\n');
  process.exit(code);
};
const [first, second] = args;

if (says === 'down') fail(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
if (says === 'no-image' && first === 'image') fail(1, 'Error response from daemon: No such image: ' + args.at(-1));
if (says === 'no-image' && first === 'pull') fail(1, 'Error response from daemon: pull access denied for ' + args.at(-1) + ', repository does not exist or may require \'docker login\'');
if (says === 'no-volume' && first === 'volume' && second === 'create') fail(1, 'Error response from daemon: create ' + args.at(-1) + ': no space left on device');
// The check of what an image has prints what it lacks. This one has no tar and no timeout.
if (says === 'no-tools' && first === 'run' && args.at(-1).includes('command -v')) {
  process.stdout.write('tar timeout ');
  process.exit(0);
}
// A container the service will not start: the command says so, with warnings before it and advice after, and exits 125.
if (says === 'refused' && first === 'run' && !args.at(-1).includes('command -v') && !args.includes('0:0')) {
  fail(125, 'WARNING: Your kernel does not support swap limit capabilities\ndocker: Error response from daemon: failed to create task for container: OCI runtime create failed: unable to start container process\n\nRun \'docker run --help\' for more information');
}

const real = process.env.FAKE_DOCKER_REAL;
if (real) {
  // Passed on as it came, with this process's own streams, so the real command reads and writes exactly what the caller does.
  const child = spawn(real, args, { stdio: 'inherit' });
  child.on('error', (error) => fail(127, String(error.message)));
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
} else if (first === 'version') {
  process.stdout.write('99.0.0\n');
} else if (first === 'image' || first === 'pull' || first === 'volume' || first === 'kill' || first === 'ps') {
  if (first === 'volume' && second === 'create') process.stdout.write(args.at(-1) + '\n');
} else if (first === 'run' && args.at(-1).includes('command -v')) {
  // An image that has everything.
} else if (first === 'run' && (args.at(-1) === 'kept' || args.at(-1) === 'fresh')) {
  // Nothing real is run here. A container that "ran" a command first reads the files it is sent, to the end, as the real one
  // does before it says they are in place. Then it says what the wrapper would have said and prints what it was asked to run.
  for await (const sent of process.stdin) void sent;
  process.stderr.write('@@org-sandbox synced\n@@org-sandbox started\n');
  const command = args[args.indexOf('sandbox', args.indexOf('-c')) + 3] ?? '';
  process.stdout.write('ran: ' + command + '\n');
  // Everything in the container stopped at once: what runs around the command never gets to say that it saw the command end.
  if (says === 'killed-whole') process.exit(137);
  if (says === 'starved') process.stderr.write('@@org-sandbox oom\n');
  process.stderr.write('@@org-sandbox ended\n');
  if (says === 'killed' || says === 'starved') process.exit(137);
} else if (first === 'run') {
  // Any other container (one that makes a volume ready, one that brings files out) ends with nothing to say.
} else {
  fail(1, 'unknown command: ' + first);
}
