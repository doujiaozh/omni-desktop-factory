'use strict';

/**
 * src/generate.js — stage a compilable Go app from the runtime templates.
 *
 * Takes the build options and a staging directory, then writes:
 *
 *   staging/
 *     main.go, server.go, ws.go, bridge.go, shell.go, util.go   (verbatim)
 *     config.go         (runtime template with __OMNI_* filled in)
 *     go.mod            (verbatim)
 *     bridge/omni.js    (verbatim — embedded by main.go)
 *     assets/           (the user's --src, with the SDK injected in *.html)
 *
 * Everything is plain fs work: no template engine, no runtime deps.
 */

const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

// Files copied byte-for-byte from runtime/ into the staging directory.
const VERBATIM_GO_FILES = ['main.go', 'server.go', 'ws.go', 'bridge.go', 'shell.go', 'util.go', 'go.mod', 'config.go'];
// Subtrees copied verbatim (main.go embeds "bridge/omni.js").
const VERBATIM_DIRS = ['bridge'];

/** Escape a JS string into a Go double-quoted string literal. */
function goStr(value) {
  const s = String(value);
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;   // "
      case 0x5C: out += '\\\\'; break;  // backslash
      case 0x0A: out += '\\n'; break;
      case 0x0D: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      default:
        if (c < 0x20) {
          out += '\\x' + c.toString(16).padStart(2, '0');
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/** Directory names never embedded into the app (build artefacts). */
const SKIP_DIRS = /^\.omni-staging-/;
/** Files never embedded: native binaries would otherwise pull the previous
 *  build (or a stray DLL) into the next one and balloon the .exe. */
const SKIP_FILES = /\.(exe|dll)$/i;

function copyTree(src, dest) {
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.test(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) {
      if (SKIP_FILES.test(entry.name)) continue;
      copyFile(from, to);
    }
    // symlinks and other oddities are skipped on purpose
  }
}

/**
 * Reference the bridge SDK in an HTML document. Idempotent: pages that
 * already load /__omni.js are left untouched.
 */
const INJECT_SNIPPET = '<script src="/__omni.js"></script>';

function injectSdkIntoHtml(html) {
  if (/<script[^>]+\/__omni\.js/.test(html)) return html;
  const headClose = /<\/head>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, '  ' + INJECT_SNIPPET + '\n</head>');
  }
  const bodyClose = /<\/body>/i;
  if (bodyClose.test(html)) {
    return html.replace(bodyClose, '  ' + INJECT_SNIPPET + '\n</body>');
  }
  return html + '\n' + INJECT_SNIPPET + '\n';
}

function copyAssets(srcDir, assetsDir, log) {  let htmlFiles = 0;
  let files = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.test(entry.name)) continue; // never recurse into our own staging
    const from = path.join(srcDir, entry.name);
    const to = path.join(assetsDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
      files += countFiles(to);
    } else if (entry.isFile()) {
      if (SKIP_FILES.test(entry.name)) continue; // .exe/.dll are build artefacts, not app assets
      if (/\.html?$/i.test(entry.name)) {
        const raw = fs.readFileSync(from, 'utf8');
        fs.writeFileSync(to, injectSdkIntoHtml(raw), 'utf8');
        htmlFiles++;
      } else {
        copyFile(from, to);
      }
      files++;
    } else if (entry.isSymbolicLink()) {
      // Resolve one level: a symlinked subdirectory is still embedded.
      let target;
      try { target = fs.realpathSync(from); } catch (e) { continue; }
      if (fs.statSync(target).isDirectory()) copyTree(target, to);
      else copyFile(target, to);
      files++;
    }
  }
  if (htmlFiles === 0) {
    log.warn('no *.html found at the top level — the app may not render');
  }
  return { files, htmlFiles };
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n++;
  }
  return n;
}

/**
 * Render config.go from the runtime template by substituting the
 * __OMNI_*__ placeholders.
 *
 * The template keeps the placeholders inside Go string literals
 * ("__OMNI_NAME__"), so this file compiles standalone. Substitutions
 * therefore replace only the *inner* escaped content; the surrounding
 * quotes stay where the template put them.
 */
function renderConfig(options) {
  const template = fs.readFileSync(path.join(RUNTIME_DIR, 'config.go'), 'utf8');
  const inner = (v) => goStr(v).slice(1, -1); // drop the quotes goStr() adds
  const vars = {
    __OMNI_NAME__: inner(options.name),
    __OMNI_TITLE__: inner(options.title || options.name),
    __OMNI_VERSION__: inner(options.version || '1.0.0'),
    __OMNI_BROWSER__: inner(options.browser || 'auto'),
    __OMNI_WIDTH__: String(Number(options.width) || 1200),
    __OMNI_HEIGHT__: String(Number(options.height) || 800),
  };
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(key).join(value);
  }
  return out;
}

/**
 * Write the whole staging tree. Returns a small report.
 */
function generate(options, stagingDir, log) {
  mkdirp(stagingDir);

  // 1. Go sources, straight from the runtime templates.
  for (const file of VERBATIM_GO_FILES) {
    const from = path.join(RUNTIME_DIR, file);
    if (!fs.existsSync(from)) {
      const err = new Error('runtime template missing: runtime/' + file);
      err.hint = 'your omni-desktop-factory install is incomplete; reinstall the package';
      throw err;
    }
    if (file === 'config.go') {
      fs.writeFileSync(path.join(stagingDir, 'config.go'), renderConfig(options), 'utf8');
    } else {
      copyFile(from, path.join(stagingDir, file));
    }
  }

  // 2. bridge/omni.js (embedded into the binary by main.go).
  for (const dir of VERBATIM_DIRS) {
    copyTree(path.join(RUNTIME_DIR, dir), path.join(stagingDir, dir));
  }

  // 3. The frontend itself, under assets/ (embedded via //go:embed all:assets).
  const assetsDir = path.join(stagingDir, 'assets');
  mkdirp(assetsDir);
  const report = copyAssets(options.src, assetsDir, log);

  log.dbg('staged ' + report.files + ' asset file(s), ' +
    report.htmlFiles + ' html file(s) got the bridge sdk');

  return {
    stagingDir,
    assetsDir,
    assetFiles: report.files,
    htmlFiles: report.htmlFiles,
  };
}

module.exports = { generate, renderConfig, injectSdkIntoHtml, goStr };
