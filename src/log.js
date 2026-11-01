'use strict';

/**
 * factory_cli - minimal dependency-free terminal logging.
 * Kept deliberately tiny so the CLI stays zero-dependency and fast under `npx`.
 */

let verbose = false;

function setVerbose(v) {
  verbose = !!v;
}

function isVerbose() {
  return verbose;
}

function info(msg) {
  console.log(msg);
}

function step(msg) {
  console.log('\n> ' + msg);
}

function ok(msg) {
  console.log('  [ok]   ' + msg);
}

function warn(msg) {
  console.log('  [warn] ' + msg);
}

function fail(msg) {
  console.error('  [fail] ' + msg);
}

function dbg(msg) {
  if (verbose) console.log('  [dbg]  ' + msg);
}

function banner(title) {
  const bar = '='.repeat(Math.max(10, title.length + 4));
  console.log('\n' + bar);
  console.log('  ' + title);
  console.log(bar);
}

module.exports = { setVerbose, isVerbose, info, step, ok, warn, fail, dbg, banner };
