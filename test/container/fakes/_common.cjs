// Shared helpers for the fake IM CLIs used by test/container/*.test.ts.
// The server passes only PATH/HOME/LANG/NO_COLOR (+ adapter vars) to the CLI, so fakes are driven by
// $HOME/fake-control.json and append {bin, argv, env subset, cwd} to $HOME/fake.log.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const home = process.env.HOME || '/tmp';

function ctl() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'fake-control.json'), 'utf8'));
  } catch {
    return {};
  }
}

function record(bin) {
  const env = { ...process.env };
  const entry = { bin, argv: process.argv.slice(2), env, cwd: process.cwd(), pid: process.pid, t: Date.now() };
  fs.appendFileSync(path.join(home, 'fake.log'), JSON.stringify(entry) + '\n');
  return entry;
}

function finish(out, code, err) {
  if (out !== undefined) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  if (err) process.stderr.write(typeof err === 'string' ? err : JSON.stringify(err));
  process.exitCode = code || 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ctl, record, finish, sleep, home };
