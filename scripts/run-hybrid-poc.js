const fs = require('fs');
const path = require('path');

// Ensure working with the real logged-in persistent browser profile
process.env.STEAM_BOT_ROOT = path.resolve('release');

const { SteamBrowserManager } = require('../dist/steam/browser');
const { HybridCommentSenderPoC } = require('../dist/steam/hybridCommentSenderPoC');
const { Logger } = require('../dist/utils/logger');

async function run() {
  console.log('====================================================');
  console.log('    Steam Hybrid Comment Send PoC Execution');
  console.log('====================================================\n');

  const logger = new Logger('release/logs');
  const browserManager = new SteamBrowserManager(logger, {
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });

  const targetSteamId64 = process.argv[2] || '76561198000000001';
  const targetProfileUrl = process.argv[3] || `https://steamcommunity.com/profiles/${targetSteamId64}`;
  const commentText = process.argv[4] || 'hello123';

  console.log(`[PoC Target] SteamID64: ${targetSteamId64}`);
  console.log(`[PoC Target] Profile:   ${targetProfileUrl}`);
  console.log(`[PoC Message] Text:     ${commentText}\n`);

  const poc = new HybridCommentSenderPoC(browserManager, logger);

  try {
    const result = await poc.executePoC(targetSteamId64, targetProfileUrl, commentText);

    console.log('\n====================================================');
    console.log('              PoC RAW EXECUTION RESULT');
    console.log('====================================================');
    console.log(JSON.stringify(result, null, 2));

    console.log('\n====================================================');
    console.log('              PoC STRUCTURED EVALUATION');
    console.log('====================================================');
    console.log(`A. HTTP Request Succeeded:       ${result.httpStatus === 200 ? 'YES (HTTP 200)' : `NO (HTTP ${result.httpStatus})`}`);
    console.log(`B. Steam Response JSON Keys:     ${result.responseKeys.join(', ')}`);
    console.log(`C. Steam success Flag:           ${result.success}`);
    if (result.error) {
      console.log(`   Steam error Message:          ${result.error}`);
    }
    console.log(`D. comments_html Present:        ${result.hasCommentsHtml} (Length: ${result.commentsHtmlLength} bytes)`);
    if (result.commentsHtmlSnippet) {
      console.log(`   comments_html Snippet:        "${result.commentsHtmlSnippet}"`);
    }
    console.log(`E. Parsed commentId:             ${result.parsedCommentId || '(none)'}`);
    console.log(`F. Target Page hello123 Visible: ${result.targetPageVerified ? 'YES' : 'NO'}`);
    console.log(`G. Moderation Pending Detected:  ${result.targetPageModerationPending || result.classification === 'MODERATION_PENDING' ? 'YES' : 'NO'}`);
    console.log(`   Final Classification:         ${result.classification}`);
    console.log('====================================================\n');
  } catch (err) {
    console.error('PoC unhandled error:', err);
  } finally {
    await browserManager.close();
    console.log('Browser context cleanly closed.');
  }
}

run();
