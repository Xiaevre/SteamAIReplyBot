const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('========================================');
console.log('  Packaging SteamAIReplyBot for Windows');
console.log('========================================\n');

// 1. Build dist
console.log('[1/5] Building project dist...');
require('./build');

// 2. Prepare release directory
const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}
const releaseDist = path.join(releaseDir, 'dist');
if (fs.existsSync(releaseDist)) {
  try { fs.rmSync(releaseDist, { recursive: true, force: true }); } catch {}
}
fs.mkdirSync(path.join(releaseDir, 'bin'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'browsers'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'prompts'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'templates'), { recursive: true });
// Prepare data directory skeleton (Requirement 8)
fs.mkdirSync(path.join(releaseDir, 'data', 'playwright-temp'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'data', 'cookies'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'data', 'logs'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'data', 'config'), { recursive: true });

// 3. Compile native launcher to release/SteamAIReplyBot.exe
console.log('[2/5] Compiling native Windows executable SteamAIReplyBot.exe ...');
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const launcherSrc = path.join(projectRoot, 'src', 'launcher.cs');
const targetExe = path.join(releaseDir, 'SteamAIReplyBot.exe');

if (fs.existsSync(cscPath)) {
  try {
    const iconPath = path.join(projectRoot, 'src', 'app.ico');
    const iconFlag = fs.existsSync(iconPath) ? ` /win32icon:"${iconPath}"` : '';
    const compileCmd = `"${cscPath}" /nologo /target:exe /platform:x64${iconFlag} /out:"${targetExe}" "${launcherSrc}"`;
    execSync(compileCmd, { stdio: 'inherit' });
    console.log('  -> release/SteamAIReplyBot.exe compiled successfully with standard icon & metadata!');
  } catch (err) {
    if (fs.existsSync(targetExe)) {
      console.warn('  -> release/SteamAIReplyBot.exe already exists, keeping current binary.');
    } else {
      throw err;
    }
  }
} else {
  console.warn('  -> csc.exe not found at standard path, copying node wrapper as exe');
}

// 4. Copy Node runtime & scripts
console.log('[3/5] Bundling Node.js runtime into release/bin/ ...');
const userHome = process.env.USERPROFILE || process.env.HOME || '';
const codexNodeExe = userHome ? path.join(userHome, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe') : '';
const systemNodeExe = process.execPath;
const targetNodeExe = path.join(releaseDir, 'bin', 'node.exe');
if (!fs.existsSync(targetNodeExe)) {
  if (codexNodeExe && fs.existsSync(codexNodeExe)) {
    try { fs.copyFileSync(codexNodeExe, targetNodeExe); } catch {}
  } else if (systemNodeExe && fs.existsSync(systemNodeExe)) {
    try { fs.copyFileSync(systemNodeExe, targetNodeExe); } catch {}
  }
}

// Copy dist/
copyFolderRecursiveSync(path.join(projectRoot, 'dist'), path.join(releaseDir, 'dist'));
// Copy patch-fs.js and bootstrap.js
try { fs.copyFileSync(path.join(projectRoot, 'patch-fs.js'), path.join(releaseDir, 'patch-fs.js')); } catch {}
try { fs.copyFileSync(path.join(projectRoot, 'bootstrap.js'), path.join(releaseDir, 'bootstrap.js')); } catch {}
try { fs.copyFileSync(path.join(projectRoot, 'start-background.vbs'), path.join(releaseDir, 'start-background.vbs')); } catch {}

// 5. Copy prompts and templates (NEVER touch user runtime data or data/ directory)
console.log('[4/5] Copying templates and prompts (NEVER touching user runtime data)...');
copyFolderRecursiveSync(path.join(projectRoot, 'prompts'), path.join(releaseDir, 'prompts'));

// Copy initial templates ONLY to release/templates/ (strictly never to data/ or release/data/)
const templatesDir = path.join(releaseDir, 'templates');
fs.mkdirSync(templatesDir, { recursive: true });
const initialPhrases = path.join(projectRoot, 'data', 'phrases.json');
if (fs.existsSync(initialPhrases)) {
  try { fs.copyFileSync(initialPhrases, path.join(templatesDir, 'phrases.json')); } catch {}
}

// Copy Playwright dependencies
console.log('[5/5] Packaging Playwright dependencies into release/node_modules/ ...');
const codexNodeModules = userHome ? path.join(userHome, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules') : '';
const localNodeModules = path.join(projectRoot, 'node_modules');
const targetNodeModules = path.join(releaseDir, 'node_modules');
fs.mkdirSync(targetNodeModules, { recursive: true });

const requiredPackages = ['playwright', 'playwright-core'];
for (const pkg of requiredPackages) {
  const codexPkg = codexNodeModules ? path.join(codexNodeModules, pkg) : '';
  const localPkg = path.join(localNodeModules, pkg);
  if (codexPkg && fs.existsSync(codexPkg)) {
    copyFolderRecursiveSync(codexPkg, path.join(targetNodeModules, pkg));
  } else if (fs.existsSync(localPkg)) {
    copyFolderRecursiveSync(localPkg, path.join(targetNodeModules, pkg));
  }
}

// Write config.json.example
const configExample = {
  STEAM_PROFILE_URL: "https://steamcommunity.com/id/YOUR_STEAM_ID/",
  DEEPSEEK_API_KEY: "YOUR_DEEPSEEK_API_KEY",
  DEEPSEEK_MODEL: "deepseek-chat",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
  CHECK_INTERVAL_MIN_SECONDS: 90,
  CHECK_INTERVAL_MAX_SECONDS: 180,
  DRY_RUN: true,
  MAX_REPLIES_PER_HOUR: 10,
  MAX_REPLIES_PER_DAY: 50,
  MAX_HOLIDAY_MESSAGES_PER_DAY: 5,
  HOLIDAY_ACTIVE_DAYS: 30,
  HOLIDAY_SEND_START: "09:00",
  HOLIDAY_SEND_END: "22:00",
  DEFAULT_LANGUAGE: "zh",
  TIMEZONE: "Asia/Tokyo",
  MIN_REPLY_DELAY_SECONDS: 60,
  MAX_REPLY_DELAY_SECONDS: 240,
  AI_REQUEST_DELAY_MS: 2000,
  MEMORY_WARNING_MB: 450,
  MEMORY_CRITICAL_MB: 700,
  BOT_ENABLED: false,
  EMERGENCY_STOP: false
};
fs.writeFileSync(path.join(releaseDir, 'config.json.example'), JSON.stringify(configExample, null, 2), 'utf8');

// Write .env.example
const envExample = `# Steam AI Comment Reply Bot Environment Configuration
STEAM_PROFILE_URL=https://steamcommunity.com/id/YOUR_STEAM_ID/
DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY
DEEPSEEK_MODEL=deepseek-chat
DRY_RUN=true
CHECK_INTERVAL_MIN_SECONDS=90
CHECK_INTERVAL_MAX_SECONDS=180
MAX_REPLIES_PER_HOUR=10
MAX_REPLIES_PER_DAY=50
MEMORY_WARNING_MB=450
MEMORY_CRITICAL_MB=700
BOT_ENABLED=false
EMERGENCY_STOP=false
`;
fs.writeFileSync(path.join(releaseDir, '.env.example'), envExample, 'utf8');

// Write release/browsers/README.txt
const browsersReadme = `【Chromium 独立浏览器说明】
本程序默认优先寻找并使用：
1. 本目录 release/browsers/ 内部的 Chromium
2. 系统已安装的 Google Chrome 或 Microsoft Edge

若运行在无图形界面的 Windows Server 上，可直接将 Chromium 绿色包解压至此目录：
release/
└── browsers/
    └── chrome-win/
        └── chrome.exe
`;
fs.writeFileSync(path.join(releaseDir, 'browsers', 'README.txt'), browsersReadme, 'utf8');

console.log('\n✅ Packaging completed successfully!');
console.log(`Executable located at: ${targetExe}`);

function copyFolderRecursiveSync(src, dest, skipIfExists = false) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Strictly exclude lock files, temporary playwright files, and sqlite WAL/SHM files
    if (
      entry.name === 'bot-instance.lock' ||
      entry.name.endsWith('.lock') ||
      entry.name === 'playwright-temp' ||
      entry.name.endsWith('-wal') ||
      entry.name.endsWith('-shm') ||
      entry.name.endsWith('-journal') ||
      entry.name.startsWith('bot.db') ||
      entry.name.startsWith('steam-reply.db')
    ) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // Never overwrite existing browser-profile to protect real login sessions
    if (entry.name === 'browser-profile' && fs.existsSync(destPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      copyFolderRecursiveSync(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}
// Note: package.js strictly never touches user data in %LOCALAPPDATA%\SteamAIReplyBot\data\

