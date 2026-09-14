const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../dist/config/env');
const { AppDatabase } = require('../dist/db/database');
const { TaskScheduler } = require('../dist/scheduler/taskScheduler');
const { CommentDiagnosticLogger } = require('../dist/utils/commentDiagnostics');

const configPath = process.env.STEAM_BOT_CONFIG || path.resolve(__dirname, '../config.json');
const dbPath = process.env.STEAM_BOT_DB || path.resolve(__dirname, '../data/steam-ai-reply.db');

const cfg = fs.existsSync(configPath) ? loadConfig(configPath) : { DRY_RUN: true };
cfg.DRY_RUN = true;
const db = new AppDatabase(fs.existsSync(dbPath) ? dbPath : ':memory:');
const scheduler = new TaskScheduler(cfg, db);

const rows = db.prepare('SELECT steam_comment_id, commenter_name, commenter_profile_url, commenter_steam_id, content, created_at, status, classification, reply_source FROM comments ORDER BY created_at DESC LIMIT 6').all();

console.log('MONITOR_FETCHED: {"count":' + rows.length + '}\n');

const summary = {
  totalComments: rows.length,
  newComments: 0,
  alreadyProcessed: 0,
  spam: 0,
  localReplies: 0,
  visualExpressionLocal: 0,
  deepseekReplies: 0,
  aiRequests: 0,
  aiRequestsBlocked: 0,
  aiRequestsSaved: 0,
  visualExpressionSaved: 0,
  rateLimited: 0,
  errors: 0
};

(async () => {
  let idx = 0;
  for (const r of rows) {
    idx++;
    const diag = await scheduler.processComment({
      commentId: r.steam_comment_id,
      commenterName: r.commenter_name,
      commenterSteamId: r.commenter_steam_id || '76561198000000000',
      commenterProfileUrl: r.commenter_profile_url,
      content: r.content,
      timestampStr: r.created_at
    }, idx, { persistAndDispatch: false });

    console.log(CommentDiagnosticLogger.formatConsoleDiagnostic(diag));

    if (diag.databaseRecordExists) {
      summary.alreadyProcessed++;
    }
    if (diag.visualExpression) {
      summary.visualExpressionLocal++;
      summary.visualExpressionSaved++;
      summary.aiRequestsSaved++;
      summary.aiRequestsBlocked++;
    } else if (diag.classificationSource === 'LOCAL_RULE' || diag.replySource === 'LOCAL_TEMPLATE') {
      summary.localReplies++;
      summary.aiRequestsSaved++;
    } else if (diag.classificationSource === 'DEEPSEEK' || diag.replySource === 'DEEPSEEK') {
      summary.deepseekReplies++;
      summary.aiRequests++;
    }
  }

  console.log('\n' + CommentDiagnosticLogger.formatSummary(summary));
  db.close();
})();
