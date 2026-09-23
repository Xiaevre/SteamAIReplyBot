const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const zipPath = path.resolve(__dirname, '..', 'artifacts', 'SteamAIReplyBot-v1.0.1-windows-x64.zip');
console.log('Verifying ZIP:', zipPath);

const psCmd = `powershell.exe -NoProfile -Command "& { Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries.FullName }"`;
const output = execSync(psCmd, { maxBuffer: 10 * 1024 * 1024 }).toString();

const entries = output.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
console.log(`Total entries in zip: ${entries.length}`);

const forbidden = [
  'database.sqlite',
  'cookies',
  'browser-profile',
  'config.json',
  'runtime-control.json',
  'logs'
];

const violations = [];
for (const entry of entries) {
  for (const f of forbidden) {
    if (entry.toLowerCase().includes(f) && !entry.toLowerCase().includes('.example')) {
      violations.push({ entry, rule: f });
    }
  }
}

if (violations.length === 0) {
  console.log('✅ AUDIT PASSED: 0 forbidden files/folders found in zip.');
} else {
  console.error('❌ AUDIT FAILED: Forbidden items found:', violations);
  process.exit(1);
}

const stats = fs.statSync(zipPath);
console.log(`File: ${zipPath}`);
console.log(`Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB (${stats.size} bytes)`);
console.log(`Birthtime (Created): ${stats.birthtime.toISOString()}`);
console.log(`Mtime (Modified): ${stats.mtime.toISOString()}`);
