#!/usr/bin/env node
'use strict';

/**
 * examples/build.js — one-shot demo: turn this folder's index.html into
 * examples/Hello.exe (and then launch it once, so you can see the result).
 *
 *   node examples/build.js          # build + run
 *   node examples/build.js --no-run # build only
 */

const path = require('path');
const { spawn } = require('child_process');
const cli = require('../src/cli');

const args = process.argv.slice(2);
const runAfter = !args.includes('--no-run');

const buildArgs = [
  'build',
  '--src', path.join(__dirname),
  '--out', path.join(__dirname),
  '--name', 'Hello',
  '--title', 'Omni-Desktop-Factory · Hello',
  '--width', '960',
  '--height', '640',
];

(async function main() {
  await cli.run(buildArgs.concat(args.filter((a) => a === '--verbose')));

  if (!runAfter) return;

  const exe = path.join(__dirname, process.platform === 'win32' ? 'Hello.exe' : 'Hello');
  console.log('\nlaunching ' + exe + ' …');
  const child = spawn('"' + exe + '"', [], { shell: true, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log('(app exited with code ' + code + ')');
  });
})();
