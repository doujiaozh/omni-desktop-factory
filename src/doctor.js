'use strict';

/**
 * factory_cli/doctor — environment self-check before building.
 *
 * The Win7 red line: Go 1.20 is the LAST Go toolchain that still targets
 * Windows 7 / 8.1 / Server 2008 R2 / 2012. Go 1.21+ binaries refuse to run on
 * them. On a Windows 7 host, building with Go >= 1.21 or a too-new browser
 * breaks the promise of a standalone native app, so doctor warns loudly.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./log');

function execQuiet(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { shell: process.platform === 'win32', windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').trim() });
    });
  });
}

function parseGoVersion(out) {
  const m = /go version go(\d+)\.(\d+)(?:\.(\d+))? /.exec(out + ' ');
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0), raw: out };
}

function envDirs() {
  const list = [];
  const keys = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'];
  for (const k of keys) {
    const v = process.env[k];
    if (v) list.push(v);
  }
  return [...new Set(list)];
}

function candidateBrowsers() {
  const sub = {
    chrome: ['Google\\Chrome\\Application\\chrome.exe'],
    edge: ['Microsoft\\Edge\\Application\\msedge.exe'],
    chromium: ['Chromium\\Application\\chrome.exe'],
    brave: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    vivaldi: ['Vivaldi\\Application\\vivaldi.exe'],
    firefox: ['Mozilla Firefox\\firefox.exe'],
  };
  const found = [];
  for (const [name, rels] of Object.entries(sub)) {
    for (const base of envDirs()) {
      for (const rel of rels) {
        const p = path.join(base, rel);
        if (fs.existsSync(p)) {
          found.push({ name, path: p });
          break;
        }
      }
    }
  }
  return found;
}

async function run() {
  log.banner('omni-factory doctor — toolchain check');

  // Node
  log.step('Node.js runtime');
  log.ok('node ' + process.version + ' (' + process.platform + '/' + process.arch + ')');
  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  if (major < 14) log.warn('Node < 14 is not supported by this CLI');
  if (/^win/.test(process.platform) && major > 18) {
    log.warn('very new Node on a legacy Windows host may misbehave; Node 14-18 is the sweet spot');
  }

  // Go
  log.step('Go toolchain (the packaging kernel)');
  const gv = await execQuiet('go', ['version']);
  if (!gv.ok) {
    log.fail('Go was not found on PATH');
    log.fail('install Go 1.20.x from https://go.dev/dl/ (last toolchain supporting Windows 7)');
    log.warn('on Windows 7 you may need to extract the zip manually and set PATH');
  } else {
    const v = parseGoVersion(gv.out);
    log.ok(gv.out);
    if (v) {
      if (v.major > 1 || (v.major === 1 && v.minor > 20)) {
        log.warn(`Go ${v.major}.${v.minor} builds binaries that WILL NOT run on Windows 7/8.1`);
        log.warn('install go1.20.x to keep the Win7 compatibility promise (go install / zip overwrite)');
      } else {
        log.ok(`Go ${v.major}.${v.minor} keeps the Windows 7 compatibility promise`);
      }
    }
    const env = await execQuiet('go', ['env', 'GOOS', 'GOARCH', 'CGO_ENABLED']);
    if (env.ok) {
      log.ok('go env: ' + env.out.replace(/\n/g, ' / '));
      if (/CGO_ENABLED=1/.test(env.out)) {
        log.warn('CGO_ENABLED=1 detected; this project is pure-Go and needs no C toolchain');
      }
    }
  }

  // Browsers (window host)
  log.step('Installed browsers (window host for --app mode)');
  const browsers = candidateBrowsers();
  if (browsers.length === 0) {
    log.warn('no supported browser found; apps will fall back to the system default browser');
    log.warn('Windows 7 supported versions: Chrome/Edge <= 109, Firefox ESR 115');
  } else {
    for (const b of browsers) log.ok(b.name + ' -> ' + b.path);
  }

  // Runtime templates
  log.step('Bundled Go runtime templates');
  const runtimeDir = path.join(__dirname, '..', 'runtime');
  const required = ['main.go', 'server.go', 'ws.go', 'bridge.go', 'shell.go', 'go.mod', 'bridge/omni.js'];
  let missingTemplate = false;
  for (const rel of required) {
    const p = path.join(runtimeDir, rel);
    if (fs.existsSync(p)) log.ok(rel);
    else { log.fail('missing template: ' + rel); missingTemplate = true; }
  }

  log.step('Verdict');
  const fatal = !gv.ok || missingTemplate;
  if (fatal) {
    log.fail('environment is NOT ready — fix the failures above before building');
  } else {
    log.ok('environment is ready — run: omni-factory build --src ./dist --name MyApp');
  }
  return fatal;
}

module.exports = { run, parseGoVersion, candidateBrowsers };
