/**
 * User-Friendly Log Layer - Log Presentation Mapper (Browser & Node.js Runtime)
 * 将内部结构化事件映射为通俗易懂的“人话日志”
 */

function mapLogToPresentation(log, index) {
  if (index === undefined) index = 0;
  var event = (log && log.event) ? log.event : 'UNKNOWN_EVENT';
  var details = (log && log.details) ? log.details : {};
  var timestamp = (log && log.timestamp) ? log.timestamp : new Date().toISOString();
  var timeStr = timestamp.length >= 19 ? timestamp.substring(11, 19) : timestamp;
  var rawJson = JSON.stringify(log, null, 2);
  var id = 'log_' + (Date.parse(timestamp) || Date.now()) + '_' + index + '_' + Math.random().toString(36).substring(2, 7);

  switch (event) {
    // 1. 系统启动与运行就绪
    case 'BOOT_START':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '程序正在启动',
        icon: '🚀',
        level: 'info',
        categories: ['all', 'task'],
        message: 'Steam AI Reply Bot 正在进行启动与运行环境自检...',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'BOOT_READY':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '程序已启动并进入后台运行',
        icon: '✅',
        level: 'success',
        categories: ['all', 'success'],
        message: '机器人核心进程 (PID: ' + (details.pid || '已就绪') + ') 已启动，正在后台稳定运行。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'WEB_SERVER_STARTED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '管理面板已启动',
        icon: '🌐',
        level: 'success',
        categories: ['all', 'success'],
        message: 'Web 控制面板已成功启动，监听地址: ' + (details.url || ('http://' + details.host + ':' + details.port)),
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'SCHEDULER_STARTED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '自动任务调度已启动',
        icon: '⏱️',
        level: 'info',
        categories: ['all', 'task'],
        message: '自动化轮询与回复调度系统已就绪（演练模式: ' + (details.dryRun ? '已开启' : '关闭') + '，无头浏览器: ' + (details.headless ? '是' : '否') + '）。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    // 2. Steam 登录与会话
    case 'SESSION_HEALTH_OK':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 登录正常',
        icon: '🟢',
        level: 'success',
        categories: ['all', 'steam', 'success', 'important'],
        message: 'Steam 登录会话完全有效，已连接账号: ' + (details.accountName || details.steamId || '已认证用户') + '。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'SESSION_HEALTH_FAILED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 登录失效',
        icon: '🔴',
        level: 'error',
        categories: ['all', 'steam', 'error', 'important'],
        message: '当前 Steam 登录会话无效，发送队列已自动暂停，不会发送任何评论。',
        suggestion: '请点击「唤起 Steam 登录向导」完成登录以恢复发送。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'LOGIN_REQUIRED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '需要登录 Steam',
        icon: '🔑',
        level: 'warn',
        categories: ['all', 'steam', 'error', 'important'],
        message: '系统检测到当前需要完成 Steam 登录 (' + (details.reason || details.detail || '会话凭据未生效') + ')。',
        suggestion: '请点击「唤起 Steam 登录向导」扫码或输入凭证登录。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'SESSION_COOKIE_MISSING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '登录凭据检查异常',
        icon: '⚠️',
        level: 'warn',
        categories: ['all', 'steam', 'error'],
        message: '本地浏览器 Profile 中未找到有效的 steamLoginSecure 认证凭据。',
        suggestion: '请使用「唤起 Steam 登录向导」重新完成账号登录。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_LOGIN_TRIGGERED_VIA_API':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在打开 Steam 登录窗口',
        icon: '🖥️',
        level: 'info',
        categories: ['all', 'steam', 'important'],
        message: '正在使用独立的浏览器环境打开 Steam 登录页面，登录后凭据将自动持久化。',
        suggestion: '请在弹出的 Chrome 窗口中扫码或输入验证码完成登录。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_LOGIN_PREPARE':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在准备 Steam 登录窗口',
        icon: '⏳',
        level: 'info',
        categories: ['all', 'steam', 'important'],
        message: '正在暂停后台调度并释放浏览器资源，准备启动可视 Chrome 登录界面...',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'HEADLESS_BROWSER_CLOSING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在安全关闭后台浏览器',
        icon: '🔄',
        level: 'info',
        categories: ['all', 'steam'],
        message: '正在关闭后台静默 Chrome 实例以释放 browser-profile 独占锁...',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'HEADLESS_BROWSER_CLOSED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '后台浏览器锁已成功释放',
        icon: '🔒',
        level: 'info',
        categories: ['all', 'steam'],
        message: '已释放 profile 数据目录锁，准备启动独立可视登录窗口。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_BROWSER_LAUNCHING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在启动可视 Chrome 登录窗口',
        icon: '🪟',
        level: 'info',
        categories: ['all', 'steam', 'important'],
        message: '正在以可视模式启动 Chrome 浏览器 (headless: false)...',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_BROWSER_LAUNCHED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 登录窗口已打开',
        icon: '🖥️',
        level: 'info',
        categories: ['all', 'steam', 'important'],
        message: '可视 Chrome 登录窗口已成功唤起 (PID: ' + (details.chromiumPid || '已就绪') + ')，请在弹出的窗口中登录 Steam。',
        suggestion: '请在弹出的 Chrome 窗口中完成账号登录与手机令牌验证。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_LOGIN_WAITING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '等待用户完成登录',
        icon: '⏳',
        level: 'info',
        categories: ['all', 'steam'],
        message: '已打开 Steam 官方登录页面，系统正在等待您完成登录...',
        suggestion: '请在弹出的窗口中完成 Steam 登录，登录成功后系统会自动保存凭据。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_LOGIN_SUCCESS':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 登录成功',
        icon: '🎉',
        level: 'success',
        categories: ['all', 'steam', 'success', 'important'],
        message: '已成功验证 Steam 登录状态 (SteamID: ' + (details.steamId64 || '-') + '，用户: ' + (details.accountName || '已认证') + ')！',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_BROWSER_CLOSING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在关闭可视登录窗口',
        icon: '🪟',
        level: 'info',
        categories: ['all', 'steam'],
        message: '凭据已安全保存，正在关闭可视登录窗口...',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'HEADLESS_BROWSER_RESTARTING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在重启后台守护浏览器',
        icon: '🚀',
        level: 'info',
        categories: ['all', 'steam'],
        message: '正在使用最新登录凭据重启后台低开销静默浏览器...',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'LOGIN_FLOW_COMPLETED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '登录与恢复流程全部完成',
        icon: '✅',
        level: 'success',
        categories: ['all', 'steam', 'success', 'important'],
        message: 'Steam 登录切换已顺利完成，后台监控与评论发送队列已全面恢复！',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_LOGIN_FAILED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '登录窗口启动失败',
        icon: '🔴',
        level: 'error',
        categories: ['all', 'steam', 'error', 'important'],
        message: '可视 Chrome 登录窗口未能成功启动 (' + (details.error || '未知错误') + ')。',
        suggestion: '请确认 Chrome/Chromium 未被其他进程独占，可重启程序重试。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'INTERACTIVE_LOGIN_CANCELLED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '登录窗口已关闭',
        icon: '⚠️',
        level: 'warn',
        categories: ['all', 'steam', 'error'],
        message: '登录窗口在完成验证前已关闭，系统已安全恢复等待登录状态。',
        suggestion: '若需继续自动回复评论，请重新点击「登录 Steam」。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'CYCLE_SKIPPED_LOGIN_ACTIVE':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '轮询暂时避让登录',
        icon: '⏸️',
        level: 'info',
        categories: ['all', 'task'],
        message: '当前正在进行可视化 Steam 登录，后台检查轮询已自动避让暂停。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'LOGIN_STARTED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 登录向导窗口已就绪',
        icon: '🔑',
        level: 'info',
        categories: ['all', 'steam'],
        message: '可视浏览器登录窗口已成功唤起，正在等待用户操作。',
        suggestion: '完成登录后该窗口可随时关闭，系统将自动检测会话。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'LOGIN_SUCCESS':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 登录认证成功',
        icon: '🟢',
        level: 'success',
        categories: ['all', 'steam', 'success', 'important'],
        message: '登录向导已成功捕获登录凭据，会话已恢复正常！',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'LOGIN_RESUMED_TASKS':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '已自动恢复排队任务',
        icon: '🔄',
        level: 'success',
        categories: ['all', 'steam', 'task', 'success', 'important'],
        message: 'Steam 登录成功！已自动恢复 ' + (details.resumedCount || 0) + ' 个之前因等待登录而积压的回复任务。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'DISPATCH_PAUSED_LOGIN_REQUIRED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '发送队列已自动暂停',
        icon: '⏸️',
        level: 'warn',
        categories: ['all', 'steam', 'send', 'error', 'important'],
        message: '当前 Steam 登录会话无效，发送队列已自动暂停，保护账号不会盲目报错。',
        suggestion: '点击「唤起 Steam 登录向导」重新登录即可恢复。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    // 3. 监控与巡检
    case 'MONITOR_REFRESHING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '正在检查 Steam 主页',
        icon: '🔍',
        level: 'info',
        categories: ['all', 'steam', 'task'],
        message: '正在访问个人主页检查最新留言情况 (' + (details.profileUrl || '') + ')。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'MONITOR_REFRESHED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '主页检查完成',
        icon: '📥',
        level: 'info',
        categories: ['all', 'steam', 'task'],
        message: '个人主页留言区刷新成功，页面内容已顺利加载。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'MONITOR_FETCHED': {
      var count = details.count || 0;
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '发现 ' + count + ' 条留言',
        icon: '💬',
        level: 'info',
        categories: ['all', 'task'],
        message: '本轮成功发现 ' + count + ' 条留言' + (details.latestAuthor ? (' (最新来自: ' + details.latestAuthor + ')') : '') + '，交由决策管道处理。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };
    }

    case 'NEXT_POLL_SCHEDULED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '下一次自动检查已安排',
        icon: '⏰',
        level: 'info',
        categories: ['all', 'task'],
        message: '本轮巡检完毕，下一次自动检查将在 ' + (details.delaySeconds || 0) + ' 秒后执行。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    // 4. 评论处理与异常
    case 'COMMENT_PROCESSING_ERROR': {
      var errStr = String(details.error || '');
      var isDbReadonly = errStr.indexOf('readonly database') !== -1 || errStr.indexOf('SQLITE_READONLY') !== -1;
      var isDbError = isDbReadonly || errStr.toLowerCase().indexOf('database') !== -1 || errStr.toLowerCase().indexOf('sqlite') !== -1;

      if (isDbReadonly) {
        return {
          id: id,
          timestamp: timestamp,
          timeStr: timeStr,
          title: '数据库无法写入',
          icon: '🔴',
          level: 'error',
          categories: ['all', 'task', 'error', 'important'],
          message: '检测到评论但程序无法保存处理状态 (attempt to write a readonly database)，因此本轮任务没有继续处理。',
          suggestion: '请检查 Bot 数据目录是否具有写入权限或重启程序释放锁占用。',
          isImportant: true,
          technicalEvent: event,
          rawDetails: details,
          rawJson: rawJson
        };
      }

      if (isDbError) {
        return {
          id: id,
          timestamp: timestamp,
          timeStr: timeStr,
          title: '数据库操作异常',
          icon: '🔴',
          level: 'error',
          categories: ['all', 'task', 'error', 'important'],
          message: '保存评论记录时数据库报错: ' + errStr + '。',
          suggestion: '请检查 data/ 目录读写权限并查看技术详情。',
          isImportant: true,
          technicalEvent: event,
          rawDetails: details,
          rawJson: rawJson
        };
      }

      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '评论处理失败',
        icon: '🔴',
        level: 'error',
        categories: ['all', 'task', 'error'],
        message: '处理评论时出现异常 (' + (details.commentId || '') + '): ' + errStr,
        suggestion: '点击右侧「查看技术详情」排查具体错误堆栈。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };
    }

    case 'COMMENT_SCAN_SUMMARY': {
      var sum = details || {};
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '本轮评论检查结果',
        icon: '📊',
        level: 'info',
        categories: ['all', 'task'],
        message: '总共 ' + (sum.totalComments || 0) + ' 条，新增: ' + (sum.newComments || 0) + '，已处理过: ' + (sum.alreadyProcessed || 0) + '，垃圾拦截: ' + (sum.spam || 0) + '，表情符本地回复: ' + (sum.visualExpressionLocal || 0) + '，AI回复: ' + (sum.deepseekReplies || 0) + '，异常: ' + (sum.errors || 0) + '。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };
    }

    case 'AI_BLOCKED_VISUAL_EXPRESSION':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '识别为视觉表情留言',
        icon: '🎨',
        level: 'info',
        categories: ['all', 'task'],
        message: '留言包含字符画/像素画/大型颜文字 (' + (details.subtype || '视觉表情') + ')，已智能拦截大模型请求，自动采用本地个性化模板回复，节省 API 成本。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    // 5. 评论发送与校验
    case 'SEND_ATTEMPT':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '准备发送评论',
        icon: '📤',
        level: 'info',
        categories: ['all', 'send', 'task'],
        message: '准备向目标主页发起回复评论...',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'SEND_RESULT_CLASSIFIED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '发送结果已判定',
        icon: '⚖️',
        level: 'info',
        categories: ['all', 'send', 'task'],
        message: 'Steam 发送响应已分类判定为: ' + (details.classification || details.status || '已完成') + '。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'SEND_VERIFIED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '评论发送成功',
        icon: '🟢',
        level: 'success',
        categories: ['all', 'send', 'success', 'important'],
        message: '已向目标用户发送回复，并确认评论已正式出现在目标主页。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'TARGET_REJECTED':
    case 'SEND_TARGET_REJECTED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '对方主页不允许留言',
        icon: '🚫',
        level: 'warn',
        categories: ['all', 'send', 'error', 'important'],
        message: '对方 Steam 个人资料隐私设置限制了留言，或该主页已关闭留言功能。',
        suggestion: '系统已将该任务标记为跳过，后续任务不受影响。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'RATE_LIMITED':
    case 'SEND_RATE_LIMITED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 当前限制发送频率',
        icon: '⏳',
        level: 'warn',
        categories: ['all', 'send', 'error', 'important'],
        message: 'Steam 提示短时间内留言过于频繁，已触发频率安全保护。',
        suggestion: '任务已自动推迟并排队重试，建议在设置中适当加大回复间隔。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'MODERATION_PENDING':
    case 'STEAM_MODERATION_PENDING':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: 'Steam 正在审核评论',
        icon: '🛡️',
        level: 'info',
        categories: ['all', 'task', 'send'],
        message: 'Steam 内容风控正在对该条留言进行自动审核，暂未对外公开显示。',
        suggestion: '系统将在下一轮轮询中自动检测审核状态，审核放行后自动完成处理。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'UNCERTAIN_SEND_STATE':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '发送结果暂时无法确认',
        icon: '❓',
        level: 'warn',
        categories: ['all', 'send', 'error', 'important'],
        message: '由于网络超时或 Steam 响应异常，当前无法确认留言是否已经成功上墙。',
        suggestion: '系统已启动防重保护，后续轮询将重新核验，绝不盲目重复发送。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'DRY_RUN_REPLY_SIMULATED':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '演练模式：回复已模拟生成',
        icon: '🧪',
        level: 'info',
        categories: ['all', 'send', 'task'],
        message: '演练模式已生效，已生成回复文本但未向 Steam 真实发送（回复内容: "' + ((details.replyText || '').substring(0, 30)) + '..."）。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    // 6. 控制台操作
    case 'BOT_PAUSED_VIA_API':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '发送队列已暂停',
        icon: '⏸️',
        level: 'warn',
        categories: ['all', 'task', 'important'],
        message: '管理员通过控制面板暂停了发送队列。机器人将继续巡检但不会向 Steam 发送新评论。',
        suggestion: '需要恢复发送时，请点击「继续发送队列」。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'BOT_RESUMED_VIA_API':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '发送队列已恢复',
        icon: '▶️',
        level: 'success',
        categories: ['all', 'task', 'success'],
        message: '管理员已恢复发送队列，正常按计划调度发送回复任务。',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    case 'EMERGENCY_STOP_TRIGGERED_VIA_API':
      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: '紧急停止已触发',
        icon: '🛑',
        level: 'error',
        categories: ['all', 'task', 'error', 'important'],
        message: '已激活紧急停止 (Emergency Stop)！所有轮询与发送已全部冻结。',
        suggestion: '在排除异常后，点击控制台的「继续发送队列」解除急停。',
        isImportant: true,
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };

    default: {
      var level = (log && log.level === 'ERROR') ? 'error' : ((log && log.level === 'WARN') ? 'warn' : 'info');
      var icon = level === 'error' ? '🔴' : (level === 'warn' ? '🟡' : 'ℹ️');
      var cats = ['all'];
      if (level === 'error') cats.push('error');
      if (event.indexOf('SEND') !== -1) cats.push('send');
      if (event.indexOf('SESSION') !== -1 || event.indexOf('STEAM') !== -1) cats.push('steam');
      if (event.indexOf('COMMENT') !== -1 || event.indexOf('TASK') !== -1) cats.push('task');

      var detailStr = '';
      if (typeof details === 'string') detailStr = details;
      else if (details && typeof details === 'object') {
        var keys = Object.keys(details);
        if (keys.length > 0) {
          detailStr = keys.map(function(k) { return k + ': ' + details[k]; }).join(' | ');
        }
      }

      return {
        id: id,
        timestamp: timestamp,
        timeStr: timeStr,
        title: event.replace(/_/g, ' '),
        icon: icon,
        level: level,
        categories: cats,
        message: detailStr || '无附加说明',
        technicalEvent: event,
        rawDetails: details,
        rawJson: rawJson
      };
    }
  }
}

if (typeof window !== 'undefined') {
  window.LogPresentation = { mapLogToPresentation: mapLogToPresentation };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mapLogToPresentation: mapLogToPresentation };
}
