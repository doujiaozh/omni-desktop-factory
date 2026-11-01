'use strict';

/**
 * src/core.js — the build orchestration of omni-desktop-factory.
 *
 *   validate the source dir
 *     -> make sure the Go toolchain exists
 *       -> stage a compilable Go app (src/generate.js)
 *         -> go build -ldflags="-s -w -H windowsgui"
 *           -> <name>.exe lands in --out
 *
 * No runtime dependencies; only Node's fs / child_process / path.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const generate = require('./generate');
const doctor = require('./doctor');
const log = require('./log');

/** Spawn a child and resolve { stdout, stderr, code } — never throws. */
function runFile(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: cwd || process.cwd(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: err ? (err.code === undefined ? 1 : err.code) : 0,
      });
    });
  });
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn('could not clean up ' + dir + ': ' + e.message);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatElapsed(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + 'm' + String(s).padStart(2, '0') + 's';
}

async function detectGo() {
  const res = await runFile('go', ['version']);
  if (res.code !== 0) {
    const err = new Error('Go toolchain not found on PATH (go version failed)');
    err.hint = 'install Go 1.20.x from https://go.dev/dl/ — it is the last release that still builds Windows 7-compatible binaries';
    throw err;
  }
  const v = doctor.parseGoVersion(res.stdout.trim());
  if (!v) {
    const err = new Error('could not parse "go version" output: ' + res.stdout.trim());
    throw err;
  }
  return { version: v, raw: res.stdout.trim() };
}

async function goEnv(name) {
  const res = await runFile('go', ['env', name]);
  return res.code === 0 ? res.stdout.trim() : '';
}

/**
 * Build a standalone desktop app.
 * @param {object} options { src, name, out, title, width, height, browser, icon, keepStaging, verbose, version }
 * @returns {Promise<{exePath, sizeBytes, sizeLabel, elapsedLabel}>}
 */
async function build(options) {
  const startedAt = Date.now();
  const o = Object.assign({ version: '1.0.0' }, options);

  // ---- 1. validate the frontend source -------------------------------
  let srcStat = null;
  try { srcStat = fs.statSync(o.src); } catch (e) { /* handled below */ }
  if (!srcStat || !srcStat.isDirectory()) {
    const err = new Error('--src is not a directory: ' + o.src);
    err.hint = 'point --src at a built frontend folder, e.g. omni-factory build --src ./dist --name MyApp';
    throw err;
  }
  if (!fs.existsSync(path.join(o.src, o.indexFile || 'index.html'))) {
    const err = new Error('no index.html inside ' + o.src);
    err.hint = 'the embedded server serves ' + (o.indexFile || 'index.html') + ' by default';
    throw err;
  }
  if (!fs.existsSync(o.out)) fs.mkdirSync(o.out, { recursive: true });

  // ---- 2. verify the Go toolchain ------------------------------------
  const go = await detectGo();
  const targetOS = await goEnv('GOOS');
  const isWindowsTarget = (!targetOS || targetOS === 'windows');
  log.ok('go ' + go.version.raw.replace(/^go/, '') + ' (' + (targetOS || '?') + '/' + (await goEnv('GOARCH') || '?') + ')');
  if (go.version.major > 1 || (go.version.major === 1 && go.version.minor > 20)) {
    if (isWindowsTarget) {
      log.warn(`Go ${go.version.major}.${go.version.minor} produces binaries that WILL NOT run on Windows 7/8.1`);
      log.warn('pin Go 1.20.x to keep the Win7 compatibility promise (see doctor)');
    }
  } else {
    log.dbg('toolchain is Win7-compatible (Go <= 1.20)');
  }

  // ---- 3. stage the Go app -------------------------------------------
  // The staging tree MUST live outside --src: the assets copy walks the
  // whole source directory, so a staging dir inside it would recurse into
  // itself forever. The system temp dir is always safe.
  const stagingDir = path.join(os.tmpdir(), 'omni-factory-' + o.name + '-' + process.pid);
  rmrf(stagingDir);
  log.step('staging Go app sources');
  const staged = generate.generate(o, stagingDir, log);
  log.ok('staged into ' + relPath(stagingDir, o.out) +
    ' (' + staged.assetFiles + ' embedded asset file(s))');

  // ---- 4. compile -----------------------------------------------------
  const exeName = (isWindowsTarget ? o.name + '.exe' : o.name);
  const exePath = path.join(o.out, exeName);
  const ldflags = ['-s', '-w'];
  if (isWindowsTarget) ldflags.push('-H', 'windowsgui'); // no console window
  const args = ['build', '-ldflags=' + ldflags.join(' '), '-o', exePath, '.'];

  log.step('go build ' + args.join(' ').replace(exePath, exeName));
  const buildRes = await runFile('go', args, stagingDir);
  if (buildRes.code !== 0 || !fs.existsSync(exePath)) {
    rmrf(stagingDir);
    const err = new Error('go build failed (exit ' + buildRes.code + ')\n' + buildRes.stderr.trim());
    err.hint = 'run "go build ." inside ' + stagingDir + ' for the full compiler output';
    throw err;
  }
  log.ok('compiled ' + exeName);

  // ---- 5. report + cleanup -------------------------------------------
  const sizeBytes = fs.statSync(exePath).size;
  const elapsed = Date.now() - startedAt;
  if (!o.keepStaging) {
    rmrf(stagingDir);
    log.dbg('removed staging dir (keep it with --keep)');
  } else {
    // --keep materialises the staging tree next to the binary for inspection.
    const keptDir = path.join(o.out, '.omni-staging-' + o.name);
    rmrf(keptDir);
    try {
      copyTreeLocal(stagingDir, keptDir);
      log.info('staging dir kept: ' + keptDir);
    } catch (e) {
      log.warn('could not keep staging dir: ' + e.message);
    }
    rmrf(stagingDir);
  }

  return {
    exePath,
    sizeBytes,
    sizeLabel: formatSize(sizeBytes),
    elapsedLabel: formatElapsed(elapsed),
  };
}

function relPath(p, base) {
  const rel = path.relative(base, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

function copyTreeLocal(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTreeLocal(from, to);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

module.exports = { build, detectGo, formatSize, formatElapsed };
