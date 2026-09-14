const fs = require('fs');
const path = require('path');
const os = require('os');

// 1. Patch fs.realpathSync and fs.realpath to avoid EPERM on Windows root drives
const origRealpathSync = fs.realpathSync;
fs.realpathSync = function (p, options) {
  try {
    return origRealpathSync(p, options);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return path.resolve(p);
    }
    throw err;
  }
};
fs.realpathSync.native = fs.realpathSync;

const origRealpath = fs.realpath;
fs.realpath = function (p, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  try {
    origRealpath(p, options, (err, resolved) => {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        return cb(null, path.resolve(p));
      }
      return cb(err, resolved);
    });
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return cb(null, path.resolve(p));
    }
    throw err;
  }
};
fs.realpath.native = fs.realpath;

// 2. Determine and initialize project-isolated Playwright Temp directory
function resolvePlaywrightTemp() {
  const rootDir = process.env.STEAM_BOT_ROOT || process.cwd();
  const tempDir = path.resolve(rootDir, 'data', 'playwright-temp');
  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  } catch {
    // Ignore initial mkdir error if handled later
  }
  return tempDir;
}

const customTempDir = resolvePlaywrightTemp();

// Redirect environment variables
process.env.TEMP = customTempDir;
process.env.TMP = customTempDir;
process.env.TMPDIR = customTempDir;
process.env.PLAYWRIGHT_ARTIFACTS_PATH = customTempDir;
process.env.PWTEST_SOCKETS_DIR = customTempDir;

// Monkey-patch os.tmpdir()
os.tmpdir = function () {
  return customTempDir;
};

// 3. Patch mkdtemp to redirect any system Temp / restricted path to customTempDir on EPERM
const origMkdtemp = fs.mkdtemp;
fs.mkdtemp = function (prefix, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opt = typeof options === 'function' ? {} : options;
  origMkdtemp(prefix, opt, (err, folder) => {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      const fallbackPrefix = path.join(customTempDir, path.basename(prefix) || 'playwright-artifacts-');
      return origMkdtemp(fallbackPrefix, opt, cb);
    }
    return cb(err, folder);
  });
};

const origMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, options) {
  try {
    return origMkdtempSync(prefix, options);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      const fallbackPrefix = path.join(customTempDir, path.basename(prefix) || 'playwright-artifacts-');
      return origMkdtempSync(fallbackPrefix, options);
    }
    throw err;
  }
};

if (fs.promises && fs.promises.mkdtemp) {
  const origPromisesMkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function (prefix, options) {
    try {
      return await origPromisesMkdtemp(prefix, options);
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        const fallbackPrefix = path.join(customTempDir, path.basename(prefix) || 'playwright-artifacts-');
        return await origPromisesMkdtemp(fallbackPrefix, options);
      }
      throw err;
    }
  };
}

// 4. Add .ts loader extension using Node 24 stripTypeScriptTypes
if (require.extensions && !require.extensions['.ts']) {
  let stripTypeScriptTypes;
  try {
    stripTypeScriptTypes = require('node:module').stripTypeScriptTypes;
  } catch {}

  require.extensions['.ts'] = function (module, filename) {
    let content = fs.readFileSync(filename, 'utf8');
    if (stripTypeScriptTypes) {
      try {
        content = content.replace(/constructor\s*\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/g, (match, args, body) => {
          const assignments = [];
          const cleanedArgs = args.split(',').map(a => {
            const m = a.match(/(?:public|private|protected|readonly)\s+([a-zA-Z0-9_$]+)/);
            if (m) {
              assignments.push(`this.${m[1]} = ${m[1]};`);
              return a.replace(/(?:public|private|protected|readonly)\s+/, '');
            }
            return a;
          }).join(', ');
          return `constructor(${cleanedArgs}) {\n${assignments.join('\n')}\n${body}}`;
        });
        content = stripTypeScriptTypes(content);
        content = content.replace(/^import\s+\*\s+as\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/gm, 'const $1 = require("$2");');
        content = content.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/gm, 'const { $1 } = require("$2");');
        content = content.replace(/^import\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/gm, 'const $1 = require("$2");');
        const exportsList = [];
        content = content.replace(/^export\s+class\s+([a-zA-Z0-9_$]+)/gm, (m, name) => { exportsList.push(name); return `class ${name}`; });
        content = content.replace(/^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/gm, (m, name) => { exportsList.push(name); return m.replace(/^export\s+/, ''); });
        content = content.replace(/^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/gm, (m, name) => { exportsList.push(name); return m.replace(/^export\s+/, ''); });
        if (exportsList.length > 0) {
          content += `\nmodule.exports = Object.assign(module.exports || {}, { ${exportsList.join(', ')} });\n`;
        }
      } catch {}
    }
    module._compile(content, filename);
  };
}
