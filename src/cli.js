'use strict';

/**
 * factory_cli — command line entry for omni-desktop-factory.
 *
 * Usage:
 *   omni-factory build --src ./dist --name MyApp [--out ./] [--title "My App"]
 *                      [--width 1200] [--height 800] [--browser auto|chrome|edge|firefox|default]
 *                      [--keep] [--verbose]
 *   omni-factory doctor
 *   omni-factory help | --help | -h
 *   omni-factory --version
 *
 * The CLI itself contains zero runtime dependencies so it can run anywhere
 * Node.js >= 14 runs, including legacy Windows 7 dev machines.
 */

const path = require('path');
const pkg = require('../package.json');
const core = require('./core');
const doctor = require('./doctor');
const log = require('./log');

const HELP = `
omni-factory ${pkg.version} — Omni-Desktop-Factory CLI
Wrap the web in a Go shell. 把网页装进 Go 的壳里。

USAGE
  omni-factory <command> [flags]

COMMANDS
  build      Embed a web app into a standalone Go binary and compile it to .exe
  doctor     Check the local toolchain (Node / Go / browsers) for readiness
  help       Show this help
  --version  Print the CLI version

BUILD FLAGS
  --src <dir>        Frontend directory to embed (must contain index.html). REQUIRED
  --name <name>      Application name, used for the output binary. REQUIRED
  --out <dir>        Output directory for <name>.exe (default: current directory)
  --title <title>    Window title (default: same as --name)
  --width <px>       Window width in pixels (default: 1200)
  --height <px>      Window height in pixels (default: 800)
  --browser <which>  Window host: auto | chrome | edge | chromium | firefox |
                     brave | vivaldi | default (default: auto)
  --icon <file>      Reserved for a future release (currently ignored with a note)
  --keep             Keep the generated Go staging directory after building
  --verbose          Verbose logging

EXAMPLES
  omni-factory build --src ./dist --name MyApp
  omni-factory build --src ./dist --name MyApp --width 900 --height 700 --browser edge
  npx omni-factory doctor
`.trim();

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function cmdBuild(flags) {
  const src = flags.src;
  const name = flags.name;
  const missing = [];
  if (!src) missing.push('--src');
  if (!name) missing.push('--name');
  if (missing.length) {
    log.fail('missing required flag(s): ' + missing.join(', '));
    log.info('\n' + HELP);
    process.exitCode = 2;
    return;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(String(name))) {
    log.fail(`invalid --name "${name}": use letters, digits, dots, dashes or underscores only`);
    process.exitCode = 2;
    return;
  }

  const options = {
    src: path.resolve(String(src)),
    name: String(name),
    out: path.resolve(flags.out ? String(flags.out) : process.cwd()),
    title: flags.title ? String(flags.title) : String(name),
    width: toInt(flags.width, 1200),
    height: toInt(flags.height, 800),
    browser: flags.browser ? String(flags.browser) : 'auto',
    icon: flags.icon ? String(flags.icon) : null,
    keepStaging: flags.keep === true,
    verbose: flags.verbose === true,
  };

  log.setVerbose(options.verbose);
  try {
    const result = await core.build(options);
    log.banner('BUILD COMPLETE');
    log.ok('binary : ' + result.exePath);
    log.ok('size   : ' + result.sizeLabel + (result.sizeBytes <= 10 * 1024 * 1024 ? ' (within the 10MB target)' : ' (above the 10MB target — heavy assets detected)'));
    log.ok('elapsed: ' + result.elapsedLabel);
    log.info('\nDouble-click the .exe, or run it from a terminal. Press Ctrl+C in the');
    log.info('launched window\'s host process, invoke omni.call("app.exit") from the page,');
    log.info('or simply close the app window to quit.');
  } catch (e) {
    log.fail(e && e.message ? e.message : String(e));
    if (e && e.hint) log.warn('hint: ' + e.hint);
    process.exitCode = 1;
  }
}

async function cmdDoctor() {
  await doctor.run();
}

async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = (positional[0] || '').toLowerCase();

  if (flags.version === true || command === '--version') {
    console.log(pkg.version);
    return;
  }
  if (command === 'help' || flags.help === true || flags.h === true) {
    console.log(HELP);
    return;
  }
  if (command === 'doctor') {
    await cmdDoctor();
    return;
  }
  if (command === 'build') {
    await cmdBuild(flags);
    return;
  }
  console.log(HELP);
}

module.exports = { run, parseArgs };
