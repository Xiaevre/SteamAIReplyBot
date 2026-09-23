const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const version = process.env.VERSION || process.argv[2] || 'v1.0.3';
const packageName = `SteamAIReplyBot-${version}-windows-x64`;

console.log('====================================================');
console.log('  Building Clean Portable Release Package (ZIP)    ');
console.log(`  Target: ${packageName}.zip    `);
console.log('====================================================\n');

const projectRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(projectRoot, 'artifacts');
const stagingDir = path.join(artifactsDir, packageName);
const targetZip = path.join(artifactsDir, `${packageName}.zip`);

// 1. Prepare clean artifacts directory
if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}
if (fs.existsSync(stagingDir)) {
  console.log('[1/6] Cleaning existing staging directory...');
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

// Helper to copy recursive
function copyDirSync(src, dest, filterFn = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!filterFn(srcPath, entry.name, entry.isDirectory())) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, filterFn);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 2. Ensure dist/ and SteamAIReplyBot.exe are fresh and clean
console.log('[2/6] Verifying dist and launcher executable...');
require('./build');

const launcherExe = path.join(projectRoot, 'release', 'SteamAIReplyBot.exe');
if (!fs.existsSync(launcherExe)) {
  console.log('  -> Compiling SteamAIReplyBot.exe ...');
  require('./package');
}

// 3. Staging required runtime files
console.log('[3/6] Staging runtime files into clean release bundle...');

// Native launcher
fs.copyFileSync(launcherExe, path.join(stagingDir, 'SteamAIReplyBot.exe'));

// Runtime scripts
fs.copyFileSync(path.join(projectRoot, 'bootstrap.js'), path.join(stagingDir, 'bootstrap.js'));
fs.copyFileSync(path.join(projectRoot, 'patch-fs.js'), path.join(stagingDir, 'patch-fs.js'));
fs.copyFileSync(path.join(projectRoot, 'start-background.vbs'), path.join(stagingDir, 'start-background.vbs'));
fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(stagingDir, 'package.json'));

// Node.js portable binary and VC runtime dlls
copyDirSync(path.join(projectRoot, 'release', 'bin'), path.join(stagingDir, 'bin'));

// Compiled JavaScript application & UI
copyDirSync(path.join(projectRoot, 'dist'), path.join(stagingDir, 'dist'));

// Playwright node_modules
copyDirSync(path.join(projectRoot, 'release', 'node_modules'), path.join(stagingDir, 'node_modules'));

// Prompts
copyDirSync(path.join(projectRoot, 'prompts'), path.join(stagingDir, 'prompts'));

// Templates
copyDirSync(path.join(projectRoot, 'github-release', 'templates'), path.join(stagingDir, 'templates'));

// Safe configuration templates & docs
fs.copyFileSync(path.join(projectRoot, 'github-release', 'config.example.json'), path.join(stagingDir, 'config.example.json'));
fs.copyFileSync(path.join(projectRoot, 'github-release', 'runtime-control.example.json'), path.join(stagingDir, 'runtime-control.example.json'));
fs.copyFileSync(path.join(projectRoot, 'github-release', '.env.example'), path.join(stagingDir, '.env.example'));
fs.copyFileSync(path.join(projectRoot, 'github-release', 'README.md'), path.join(stagingDir, 'README.md'));
fs.copyFileSync(path.join(projectRoot, 'github-release', 'LICENSE'), path.join(stagingDir, 'LICENSE'));

// Assets (UI preview & documentation images)
if (fs.existsSync(path.join(projectRoot, 'github-release', 'assets'))) {
  copyDirSync(path.join(projectRoot, 'github-release', 'assets'), path.join(stagingDir, 'assets'));
}

// 4. Verification before compression (Check for forbidden files)
console.log('[4/6] Verifying zero private data before compression...');
const forbiddenPatterns = [
  /\.sqlite$/i,
  /\.sqlite3$/i,
  /\.db$/i,
  /\.db-wal$/i,
  /\.db-shm$/i,
  /\.log$/i,
  /^config\.json$/i,
  /^\.env$/i,
  /^\.env\.local$/i,
  /^runtime-control\.json$/i,
  /^RELEASE_AUDIT\.md$/i
];

function checkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === 'data' && entry.isDirectory()) {
      throw new Error(`Forbidden directory found in staging: ${fullPath}`);
    }
    if (entry.name === 'cookies' || entry.name === 'browser-profile' || entry.name === 'logs') {
      throw new Error(`Forbidden runtime folder found in staging: ${fullPath}`);
    }
    for (const pat of forbiddenPatterns) {
      if (pat.test(entry.name)) {
        throw new Error(`Forbidden file found in staging: ${fullPath}`);
      }
    }
    if (entry.isDirectory()) {
      checkDir(fullPath);
    }
  }
}
checkDir(stagingDir);
console.log('  -> Pre-compression audit passed: 100% clean!');

// 5. Compress to ZIP using .NET ZipFile
console.log('[5/6] Creating ZIP archive with maximum compression...');
if (fs.existsSync(targetZip)) {
  try { fs.unlinkSync(targetZip); } catch {}
}

const zipCmd = `powershell.exe -NoProfile -Command "$ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${stagingDir}', '${targetZip}', [System.IO.Compression.CompressionLevel]::Optimal, $false)"`;
execSync(zipCmd, { stdio: 'inherit' });

// 6. Inspect final ZIP archive
console.log('\n[6/6] Inspecting generated release archive...');
const zipStats = fs.statSync(targetZip);
const zipSizeMb = (zipStats.size / (1024 * 1024)).toFixed(2);

console.log(`  -> ZIP Path: ${targetZip}`);
console.log(`  -> ZIP Size: ${zipSizeMb} MB (${zipStats.size} bytes)\n`);

// Count files in staging
let stagedCount = 0;
function countFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) countFiles(p);
    else stagedCount++;
  }
}
countFiles(stagingDir);
console.log(`  -> Staged File Count: ${stagedCount} files`);
console.log('====================================================');
console.log('  Release Package Built Successfully!');
console.log('====================================================\n');
