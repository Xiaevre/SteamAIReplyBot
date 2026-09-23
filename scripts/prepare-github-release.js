const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetDir = path.join(rootDir, 'github-release');

console.log('====================================================');
console.log('   Preparing Clean GitHub Open-Source Release Staging');
console.log('====================================================\n');
console.log(`Source Root: ${rootDir}`);
console.log(`Target Staging: ${targetDir}\n`);

// Clean staging directory if already exists
if (fs.existsSync(targetDir)) {
  console.log('[1/7] Cleaning existing github-release/ staging directory...');
  fs.rmSync(targetDir, { recursive: true, force: true });
}
fs.mkdirSync(targetDir, { recursive: true });

// Helper to copy directories recursively
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

// 1. Copy src/
console.log('[2/7] Copying src/ (TypeScript source, Web UI, Windows launcher)...');
copyDirSync(path.join(rootDir, 'src'), path.join(targetDir, 'src'));

// 2. Copy tests/
console.log('[3/7] Copying tests/ (Unit tests and test runner)...');
copyDirSync(path.join(rootDir, 'tests'), path.join(targetDir, 'tests'), (fullPath, name) => {
  // Exclude any test log or sqlite database artifacts
  if (name.endsWith('.log') || name.endsWith('.db') || name.endsWith('.sqlite') || name.includes('-journal') || name.includes('-wal') || name.includes('-shm')) {
    return false;
  }
  return true;
});

// 3. Copy scripts/
console.log('[4/7] Copying scripts/ (Build, package, memory benchmark, diagnosis)...');
copyDirSync(path.join(rootDir, 'scripts'), path.join(targetDir, 'scripts'), (fullPath, name) => {
  // Exclude release preparation and internal audit scripts
  if (name === 'security-audit-scan.js' || name === 'prepare-github-release.js') {
    return false;
  }
  return true;
});

// 4. Copy prompts/
console.log('[5/7] Copying prompts/ (System prompt)...');
copyDirSync(path.join(rootDir, 'prompts'), path.join(targetDir, 'prompts'));

// 5. Populate templates/
console.log('[6/7] Generating clean templates/ directory...');
const templatesDir = path.join(targetDir, 'templates');
fs.mkdirSync(templatesDir, { recursive: true });

// Copy clean templates
const rootTemplatesDir = path.join(rootDir, 'templates');
if (!fs.existsSync(rootTemplatesDir)) {
  fs.mkdirSync(rootTemplatesDir, { recursive: true });
}

// phrases.json
fs.copyFileSync(path.join(rootDir, 'data', 'phrases.json'), path.join(templatesDir, 'phrases.json'));
fs.copyFileSync(path.join(rootDir, 'data', 'phrases.json'), path.join(rootTemplatesDir, 'phrases.json'));

// reply-templates.json
fs.copyFileSync(path.join(rootDir, 'data', 'reply-templates.json'), path.join(templatesDir, 'reply-templates.json'));
fs.copyFileSync(path.join(rootDir, 'data', 'reply-templates.json'), path.join(rootTemplatesDir, 'reply-templates.json'));

// blacklist.example.json
const blacklistExample = {
  steamIds: [
    "76561198000000000"
  ],
  profileUrls: [
    "https://steamcommunity.com/id/example_spammer"
  ],
  keywords: [
    "free skins",
    "t.me/",
    "t.cn/"
  ]
};
fs.writeFileSync(path.join(templatesDir, 'blacklist.example.json'), JSON.stringify(blacklistExample, null, 2), 'utf8');
fs.writeFileSync(path.join(rootTemplatesDir, 'blacklist.example.json'), JSON.stringify(blacklistExample, null, 2), 'utf8');

// favorites.example.json
const favoritesExample = {
  steamIds: [
    "76561198000000001"
  ],
  notes: {
    "76561198000000001": "Close Friend / Frequent Visitor"
  }
};
fs.writeFileSync(path.join(templatesDir, 'favorites.example.json'), JSON.stringify(favoritesExample, null, 2), 'utf8');
fs.writeFileSync(path.join(rootTemplatesDir, 'favorites.example.json'), JSON.stringify(favoritesExample, null, 2), 'utf8');

// visual-replies
copyDirSync(path.join(rootDir, 'data', 'visual-replies'), path.join(templatesDir, 'visual-replies'));
copyDirSync(path.join(rootDir, 'data', 'visual-replies'), path.join(rootTemplatesDir, 'visual-replies'));

// 6. Root configuration and scripts
console.log('[7/7] Generating configuration examples, .gitignore, LICENSE, and documentation...');

// config.example.json
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
  BOT_ENABLED: true,
  EMERGENCY_STOP: false
};
fs.writeFileSync(path.join(targetDir, 'config.example.json'), JSON.stringify(configExample, null, 2), 'utf8');
fs.writeFileSync(path.join(rootDir, 'config.example.json'), JSON.stringify(configExample, null, 2), 'utf8');

// runtime-control.example.json
const runtimeControlExample = {
  mode: "AI_ENHANCED",
  lifecycleState: "STOPPED",
  lastError: null,
  botEnabled: true,
  emergencyStop: false,
  dryRunOverride: null,
  updatedAt: "2026-01-01T00:00:00.000Z"
};
fs.writeFileSync(path.join(targetDir, 'runtime-control.example.json'), JSON.stringify(runtimeControlExample, null, 2), 'utf8');
fs.writeFileSync(path.join(rootDir, 'runtime-control.example.json'), JSON.stringify(runtimeControlExample, null, 2), 'utf8');

// .env.example
const envExample = `# =======================================================
# Steam AI Reply Bot Environment Configuration Template
# =======================================================

# Required: Your Steam Profile URL (Custom URL or /profiles/7656119...)
STEAM_PROFILE_URL=https://steamcommunity.com/id/YOUR_STEAM_ID/

# Optional: DeepSeek API Key (Required only for AI_ENHANCED mode)
# Leave blank if you plan to use LOCAL_ONLY (Zero Token) mode!
DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# Operational Mode & Safety
DRY_RUN=true
BOT_ENABLED=true
EMERGENCY_STOP=false

# Polling & Dispatch Limits
CHECK_INTERVAL_MIN_SECONDS=90
CHECK_INTERVAL_MAX_SECONDS=180
MIN_REPLY_DELAY_SECONDS=60
MAX_REPLY_DELAY_SECONDS=240
MAX_REPLIES_PER_HOUR=10
MAX_REPLIES_PER_DAY=50

# Holiday Greeting Controls
MAX_HOLIDAY_MESSAGES_PER_DAY=5
HOLIDAY_ACTIVE_DAYS=30
HOLIDAY_SEND_START=09:00
HOLIDAY_SEND_END=22:00

# Server Low-Resource Limits
MEMORY_WARNING_MB=450
MEMORY_CRITICAL_MB=700
TIMEZONE=Asia/Tokyo
DEFAULT_LANGUAGE=zh
`;
fs.writeFileSync(path.join(targetDir, '.env.example'), envExample, 'utf8');
fs.writeFileSync(path.join(rootDir, '.env.example'), envExample, 'utf8');

// Copy package.json & tsconfig.json & root entrypoints
fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(targetDir, 'package.json'));
fs.copyFileSync(path.join(rootDir, 'tsconfig.json'), path.join(targetDir, 'tsconfig.json'));
fs.copyFileSync(path.join(rootDir, 'patch-fs.js'), path.join(targetDir, 'patch-fs.js'));
fs.copyFileSync(path.join(rootDir, 'bootstrap.js'), path.join(targetDir, 'bootstrap.js'));
fs.copyFileSync(path.join(rootDir, 'start-background.vbs'), path.join(targetDir, 'start-background.vbs'));
if (fs.existsSync(path.join(rootDir, 'README.md'))) {
  fs.copyFileSync(path.join(rootDir, 'README.md'), path.join(targetDir, 'README.md'));
}

// .gitignore
const gitignoreContent = `# =======================================================
# SteamAIReplyBot Comprehensive .gitignore
# =======================================================

# Runtime & User Persistence Directories
data/
release/
dist/
build/
bin/
browsers/

# Databases & SQLite Journal Files
*.sqlite
*.sqlite3
*.db
*.db-journal
*.db-wal
*.db-shm

# Sensitive Credentials, Secrets & Real Configurations
.env
.env.*
!.env.example
config.json
runtime-control.json
*.local.json

# Browser Profiles, Cookies & Playwright Runtime Artifacts
cookies/
browser-profile/
playwright-temp/
profile-analysis/
.playwright/

# Logs
logs/
*.log
npm-debug.log*
yarn-debug.log*

# Node modules & packaging
node_modules/
package-lock.json

# OS and Editor Files
.DS_Store
Thumbs.db
.vscode/
.idea/
*.suo
*.user
*.pdb

# Scratch Scripts and Temporary Dump Files
scratch*
test_regression*
test_live*
test_check*
kill_launcher.ps1
inspect_cookies.js
release.zip
*.tar.gz
*.zip

# Build and Release Staging Artifacts
artifacts/
github-release/
RELEASE_AUDIT.md
tools/
`;

fs.writeFileSync(path.join(targetDir, '.gitignore'), gitignoreContent, 'utf8');
fs.writeFileSync(path.join(rootDir, '.gitignore'), gitignoreContent, 'utf8');

// LICENSE (MIT)
const licenseContent = `MIT License

Copyright (c) 2026 SteamAIReplyBot Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

fs.writeFileSync(path.join(targetDir, 'LICENSE'), licenseContent, 'utf8');
fs.writeFileSync(path.join(rootDir, 'LICENSE'), licenseContent, 'utf8');

console.log('\n[SUCCESS] github-release/ cleanly staged!');
