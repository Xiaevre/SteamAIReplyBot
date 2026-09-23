const fs = require('fs');
const path = require('path');

const targetDir = path.resolve(__dirname, '..', 'github-release');

console.log('====================================================');
console.log('       GITHUB-RELEASE SECURITY AUDIT SCANNER        ');
console.log('====================================================\n');
console.log(`Auditing target: ${targetDir}\n`);

if (!fs.existsSync(targetDir)) {
  console.error(`ERROR: Target directory does not exist: ${targetDir}`);
  process.exit(1);
}

// Sensitive keywords to search
const SENSITIVE_RULES = [
  { name: 'User Real SteamID64 (76561198357500972)', pattern: /76561198357500972/gi },
  { name: 'User Real Steam Vanity/Profile (5XAO)', pattern: /(steamcommunity\.com\/id\/5xao|5xao)/gi },
  { name: 'User Real Chinese Nickname (潇雨 / 潇雨惊梦华)', pattern: /(潇雨|潇雨惊梦华)/g },
  { name: 'User Real Alias (ShawRain)', pattern: /ShawRain/gi },
  { name: 'User DeepSeek Real API Key (sk-6289...)', pattern: /sk-6289[a-zA-Z0-9_-]*/gi },
  { name: 'Generic Live DeepSeek Key pattern', pattern: /sk-[a-zA-Z0-9]{32,}/gi },
  { name: 'Real Steam Login Secure Token', pattern: /steamLoginSecure=[a-zA-Z0-9%_-]{20,}/gi },
  { name: 'Developer Local Machine Drive Path (E:\\antigravity)', pattern: /e:[\\\/]antigravity/gi },
  { name: 'Developer Windows User Path (C:\\Users\\xiao)', pattern: /c:[\\\/]users[\\\/]xiao/gi },
  { name: 'Developer Username in Paths (\\Users\\xiao)', pattern: /[\\\/]users[\\\/]xiao[\\\/]/gi },
  { name: 'Live Database File extension', fileCheck: (filename) => /\.(sqlite|sqlite3|db|db-wal|db-shm)$/i.test(filename) },
  { name: 'Live Log File extension', fileCheck: (filename) => /\.log$/i.test(filename) },
  { name: 'Private Config file', fileCheck: (filename) => filename === 'config.json' || filename === 'runtime-control.json' || filename === '.env' }
];

let totalFilesScanned = 0;
let totalIssuesFound = 0;
const issues = [];

function scanFile(filePath) {
  const relPath = path.relative(targetDir, filePath);
  const baseName = path.basename(filePath);
  totalFilesScanned++;

  // 1. Filename checks
  for (const rule of SENSITIVE_RULES) {
    if (rule.fileCheck && rule.fileCheck(baseName)) {
      totalIssuesFound++;
      issues.push({
        file: relPath,
        rule: rule.name,
        line: 0,
        snippet: `Forbidden file name found: ${baseName}`
      });
    }
  }

  // Skip binary files for text content scan
  const ext = path.extname(filePath).toLowerCase();
  if (['.ico', '.png', '.jpg', '.jpeg', '.gif', '.exe', '.dll', '.bin'].includes(ext)) {
    return;
  }

  // 2. Content checks
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of SENSITIVE_RULES) {
        if (rule.pattern) {
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(line)) {
            totalIssuesFound++;
            issues.push({
              file: relPath,
              rule: rule.name,
              line: i + 1,
              snippet: line.trim()
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[WARN] Could not read file as text: ${relPath} (${err.message})`);
  }
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else {
      scanFile(fullPath);
    }
  }
}

walkDir(targetDir);

console.log('----------------------------------------------------');
console.log(`Scan Complete! Total Files Scanned: ${totalFilesScanned}`);
console.log(`Total Issues / Leaks Found:          ${totalIssuesFound}`);
console.log('----------------------------------------------------\n');

if (totalIssuesFound === 0) {
  console.log('✅ [PASSED] 100% CLEAN! Zero leaks, zero personal data, zero private tokens detected in github-release/!\n');
} else {
  console.error('❌ [FAILED] Sensitive data detected:');
  for (const issue of issues) {
    console.error(`  - [${issue.rule}] at ${issue.file}:${issue.line}`);
    console.error(`    Snippet: ${issue.snippet}`);
  }
  process.exit(1);
}
