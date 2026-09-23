// Master Test Runner for SteamAIReplyBot
const fs = require('fs');
const path = require('path');
const { transpileTsToCjs } = require('../scripts/build');

require.extensions['.ts'] = function(module, filename) {
  const content = fs.readFileSync(filename, 'utf8');
  const compiled = transpileTsToCjs(content);
  module._compile(compiled, filename);
};

console.log('====================================================');
console.log('    SteamAIReplyBot Comprehensive Test Suite');
console.log('====================================================\n');

async function run() {
  let passedSuites = 0;
  let totalSuites = 0;

  const suites = [
    { name: 'Local Classifier & Rule Heuristics', fn: require('./unit/classifier.test').runClassifierTests },
    { name: 'Visual Expression & Emoji Pixel Art Detection', fn: require('./unit/visualExpression.test').runVisualExpressionTests },
    { name: 'Target Direction Strict Enforcement', fn: require('./unit/targetDirection.test').runTargetDirectionTests },
    { name: 'Idempotency & Crash Recovery', fn: require('./unit/idempotency.test').runIdempotencyTests },
    { name: 'AI Learner Strict Promotion', fn: require('./unit/aiLearner.test').runAiLearnerTests },
    { name: 'Kill Switch & Emergency Stop', fn: require('./unit/killSwitch.test').runKillSwitchTests },
    { name: 'Holiday Eligibility & Scheduling', fn: require('./unit/holiday.test').runHolidayTests },
    { name: 'Comment Diagnostic Logging & Decision Audit', fn: require('./unit/diagnostics.test').runDiagnosticsTests },
    { name: 'Steam Moderation Pending & Release Lifecycle', fn: require('./unit/moderation.test').runModerationTests },
    { name: 'Hybrid Comment Sender & Lifecycle Verification', fn: require('./unit/hybridSender.test').runHybridSenderTests },
    { name: 'Diagnose Send & Raw Diagnostic Auditing', fn: require('./unit/diagnoseSend.test').runDiagnoseSendTests },
    { name: 'Steam Session Lifecycle & Auth Health Check', fn: require('./unit/sessionLifecycle.test').runSessionLifecycleTests },
    { name: 'Comprehensive Sender & Target Decoupling Acceptance', fn: require('./unit/comprehensiveSenderAcceptance.test').runComprehensiveSenderAcceptanceTests },
    { name: 'Local Web Server & Control REST API', fn: require('./unit/webControlApi.test').runWebControlApiTests },
    { name: 'BOT_DISABLED Lifecycle Recovery & Immediate Wakeup', fn: require('./unit/botDisabledRecovery.test').runBotDisabledRecoveryTests },
    { name: 'Visual Reply Strategy & Curated Library', fn: require('./unit/visualStrategyLibrary.test').runVisualStrategyLibraryTests },
    { name: 'Moderation Idempotency & Zero-Resend Acceptance', fn: require('./unit/moderationIdempotencyAcceptance.test').runModerationIdempotencyAcceptanceTests },
    { name: 'Steam Profile Analysis, Knowledge Base & Persona Suggestions', fn: require('./unit/profileAnalysis.test').runProfileAnalysisTests },
    { name: 'Chromium Auto-Detection & Browser Selection', fn: require('./unit/browserDetection.test').runBrowserDetectionTests },
    { name: 'Vanity URL to SteamID64 Resolution & Transport Guard', fn: require('./unit/vanityUrlResolution.test').runVanityUrlResolutionTests },
    { name: 'Post-Send Result Confirmation & Strict Verification', fn: require('./unit/postSendConfirmation.test').runPostSendConfirmationTests },
    { name: 'Safe Retry & Global Circuit Breaker', fn: require('./unit/safeRetryAndCircuitBreaker.test').runSafeRetryAndCircuitBreakerTests },
    { name: 'Nickname Resolver & Natural Time Greeting', fn: require('./unit/nicknameResolver.test').runNicknameResolverTests },
    { name: 'Runtime Mode & Lifecycle State Architecture', fn: require('./unit/runtimeModeAndState.test').runRuntimeModeAndStateTests },
    { name: 'Graceful Stop & Resume Lifecycle Architecture', fn: require('./unit/stopResumeBot.test').runStopResumeBotTests },
    { name: 'Windows Background Execution & Autostart Architecture', fn: require('./unit/windowsBackgroundAndAutostart.test').runWindowsBackgroundAndAutostartTests },
    { name: 'Startup Recovery & Interactive Login Race Safety', fn: require('./unit/startupRecoveryRace.test').runStartupRecoveryRaceTests },
    { name: 'Today Stats & Total Replies Accounting', fn: require('./unit/todayStats.test').runTodayStatsTests },
    { name: 'Circuit Breaker & Queue Decoupling Acceptance', fn: require('./unit/circuitBreakerQueueDecoupling.test').runCircuitBreakerQueueDecouplingTests },
    { name: 'Browser Profile Recovery & Lifecycle Stability', fn: require('./unit/browserLifecycleRecovery.test').runBrowserLifecycleRecoveryTests },
    { name: 'Poll Decoupling, Incremental Catch-up & Diagnostics', fn: require('./unit/pollDecouplingAndCatchup.test').runPollDecouplingAndCatchupTests }
  ];

  const failedList = [];
  for (const suite of suites) {
    totalSuites++;
    try {
      await suite.fn();
      passedSuites++;
      console.log(`[PASS] Suite ${totalSuites}: ${suite.name}\n`);
    } catch (err) {
      failedList.push(suite.name);
      console.error(`[FAIL] Suite ${totalSuites}: ${suite.name}`);
      console.error(err);
      console.log('\n');
    }
  }

  console.log('====================================================');
  console.log(`Summary: ${passedSuites}/${totalSuites} test suites PASSED`);
  if (failedList.length > 0) {
    console.error(`FAILED SUITES: ${failedList.join(', ')}`);
  }
  console.log('====================================================');

  await new Promise(resolve => setTimeout(resolve, 100));
  if (passedSuites === totalSuites) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

run();
