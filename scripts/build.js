const fs = require('fs');
const path = require('path');
const { stripTypeScriptTypes } = require('node:module');

function transpileTsToCjs(code) {
  // Pre-process: Expand constructor parameter properties so stripTypeScriptTypes succeeds
  let pre = code.replace(/constructor\s*\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/g, (match, args, body) => {
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

  // 1. Official C++ TypeScript type stripping from Node.js 24
  let stripped = stripTypeScriptTypes(pre);

  // 2. Convert ES Imports to CommonJS Requires
  stripped = stripped.replace(/^import\s+\*\s+as\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/gm, 'const $1 = require("$2");');
  stripped = stripped.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/gm, 'const { $1 } = require("$2");');
  stripped = stripped.replace(/^import\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/gm, 'const $1 = require("$2");');

  // 3. Convert Export declarations to CommonJS
  const exportsList = [];
  stripped = stripped.replace(/^export\s+class\s+([a-zA-Z0-9_$]+)/gm, (m, name) => {
    exportsList.push(name);
    return `class ${name}`;
  });

  stripped = stripped.replace(/^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/gm, (m, name) => {
    exportsList.push(name);
    return m.replace(/^export\s+/, '');
  });

  stripped = stripped.replace(/^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/gm, (m, name) => {
    exportsList.push(name);
    return m.replace(/^export\s+/, '');
  });

  let append = '\n// CommonJS Exports\n';
  for (const exp of exportsList) {
    append += `module.exports.${exp} = ${exp};\n`;
  }

  return stripped + append;
}

function processDirectory(srcDir, outDir) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const outPath = path.join(outDir, entry.name.replace(/\.ts$/, '.js'));

    if (entry.isDirectory()) {
      processDirectory(srcPath, outPath);
    } else if (entry.name.endsWith('.ts')) {
      const tsCode = fs.readFileSync(srcPath, 'utf8');
      const jsCode = transpileTsToCjs(tsCode);
      fs.writeFileSync(outPath, jsCode, 'utf8');
    } else {
      fs.copyFileSync(srcPath, outPath);
    }
  }
}

console.log('[Build] Transpiling src/ to dist/ using Node 24 stripTypeScriptTypes ...');
const srcDir = path.resolve(__dirname, '..', 'src');
const distDir = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
processDirectory(srcDir, distDir);
console.log('[Build] Successfully transpiled all modules into dist/.');

// Synchronize compiled modules to release/dist if release directory exists
const releaseDir = path.resolve(__dirname, '..', 'release');
const releaseDist = path.join(releaseDir, 'dist');
if (fs.existsSync(releaseDir)) {
  console.log('[Build] Synchronizing compiled modules to release/dist ...');
  if (fs.existsSync(releaseDist)) {
    try { fs.rmSync(releaseDist, { recursive: true, force: true }); } catch {}
  }
  processDirectory(srcDir, releaseDist);
  console.log('[Build] Successfully synchronized release/dist.');
}

module.exports = { transpileTsToCjs, processDirectory };
