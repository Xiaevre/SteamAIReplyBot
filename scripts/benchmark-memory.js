const { SteamBrowserManager } = require('../dist/steam/browser');
const { Logger } = require('../dist/utils/logger');
const { execSync } = require('child_process');

async function benchmark() {
  console.log('====================================================');
  console.log('   Real Memory & Process Footprint Benchmark');
  console.log('====================================================\n');

  const logger = new Logger();

  // 1. Idle Node RSS
  if (global.gc) global.gc();
  const idleMem = process.memoryUsage();
  const idleRssMb = Math.round(idleMem.rss / (1024 * 1024));
  const idleHeapMb = Math.round(idleMem.heapUsed / (1024 * 1024));
  console.log(`[Stage 1] Idle Daemon Process:`);
  console.log(`  - Node RSS: ${idleRssMb} MB`);
  console.log(`  - Node Heap: ${idleHeapMb} MB\n`);

  // 2. Launch Browser
  const browserManager = new SteamBrowserManager(logger, { headless: true });
  const ctx = await browserManager.getContext();
  await new Promise(r => setTimeout(r, 1500));

  const launchedMem = process.memoryUsage();
  const launchedRssMb = Math.round(launchedMem.rss / (1024 * 1024));
  console.log(`[Stage 2] Browser Launched (Headless Chromium):`);
  console.log(`  - Node RSS: ${launchedRssMb} MB`);
  console.log(`  - Active Pages: ${browserManager.getOpenPagesCount()}`);

  // Query Chromium processes memory
  let chromiumRssMb = 0;
  try {
    const tasklistOutput = execSync('tasklist /fi "imagename eq chrome.exe" /fo csv /nh', { encoding: 'utf8' });
    const lines = tasklistOutput.trim().split(/\r?\n/).filter(l => l.includes('chrome.exe'));
    for (const l of lines) {
      const parts = l.split(',');
      if (parts.length >= 5) {
        const memStr = parts[4].replace(/[^0-9]/g, '');
        chromiumRssMb += Math.round(parseInt(memStr, 10) / 1024);
      }
    }
  } catch {
    // Tasklist error fallback
  }
  console.log(`  - Chromium RSS (All Chrome procs): ~${chromiumRssMb} MB`);
  console.log(`  - Combined Total RSS: ~${launchedRssMb + chromiumRssMb} MB\n`);

  // 3. Page Loaded (Simulating Profile Navigation)
  const page = await browserManager.openEphemeralPage();
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head><title>Steam Community Profile</title></head>
      <body>
        <div class="commentthread_comments">
          <div class="commentthread_comment" id="comment_101">
            <div class="commentthread_comment_avatar"><a href="https://steamcommunity.com/id/bob"></a></div>
            <div class="commentthread_author_link"><a href="https://steamcommunity.com/id/bob">Bob</a></div>
            <div class="commentthread_comment_text">+rep nice player!</div>
          </div>
        </div>
      </body>
    </html>
  `);
  await new Promise(r => setTimeout(r, 1000));

  const pageLoadedMem = process.memoryUsage();
  const pageLoadedRssMb = Math.round(pageLoadedMem.rss / (1024 * 1024));
  console.log(`[Stage 3] Profile Page Loaded:`);
  console.log(`  - Node RSS: ${pageLoadedRssMb} MB`);
  console.log(`  - Active Pages: ${browserManager.getOpenPagesCount()}\n`);

  // 4. Complete Check & Close Page
  await page.close();
  await new Promise(r => setTimeout(r, 1000));
  if (global.gc) global.gc();

  const afterCheckMem = process.memoryUsage();
  const afterCheckRssMb = Math.round(afterCheckMem.rss / (1024 * 1024));
  console.log(`[Stage 4] After Check Completed (Ephemeral Page Closed):`);
  console.log(`  - Node RSS: ${afterCheckRssMb} MB`);
  console.log(`  - Active Pages: ${browserManager.getOpenPagesCount()}\n`);

  // 5. Clean Browser Close
  await browserManager.close();
  console.log(`[Stage 5] Browser Closed (Returned to Idle):`);
  console.log(`  - Node RSS: ${Math.round(process.memoryUsage().rss / (1024 * 1024))} MB`);
  console.log(`  - Active Pages: 0\n`);

  console.log('====================================================');
  console.log('   Benchmark Finished');
  console.log('====================================================');
}

benchmark().catch(err => console.error('Benchmark error:', err));
