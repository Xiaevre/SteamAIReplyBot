// ==========================================================================
// Steam AI Reply Bot - Client Application Script
// ==========================================================================

const API_BASE = '';
const GITHUB_REPO_URL = 'https://github.com/Xiaevre/SteamAIReplyBot';
let currentView = 'dashboard';
let currentTaskFilter = 'all';
let pollIntervalTimer = null;
let lastKnownLogCount = 0;
let isSavingConfig = false;
let isProfileSyncing = false;
let previousProfileSyncStatus = null;

// 1. App Initialization
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupGitHubLink();
  setupActionButtons();
  setupModeButtons();
  setupAutostartHandlers();
  setupTaskFilters();
  setupSettingsForm();
  setupLogControls();
  setupModal();
  setupVisualReplyHandlers();
  setupProfileAnalysisHandlers();

  // Initial data loading
  fetchStatus();
  fetchTasks();
  fetchSession();
  fetchLogs();
  fetchVisualReplies();
  fetchProfileStatus();
  fetchAutostartStatus();

  // Start polling loop (every 2500ms)
  pollIntervalTimer = setInterval(() => {
    fetchStatus();
    if (currentView === 'tasks') fetchTasks();
    if (currentView === 'session') fetchSession();
    if (currentView === 'logs') fetchLogs();
    if (currentView === 'profile-analysis') fetchProfileStatus();
  }, 2500);
});

// Setup GitHub repository link from constant
function setupGitHubLink() {
  const githubLink = document.getElementById('sidebar-github-link');
  if (githubLink) {
    githubLink.href = GITHUB_REPO_URL;
  }
}

// 2. Navigation
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item[data-view]');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetView = item.getAttribute('data-view');
      if (targetView) {
        switchView(targetView);
      }
    });
  });
}

function switchView(viewName) {
  currentView = viewName;

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-view') === viewName);
  });

  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `view-${viewName}`);
  });

  if (viewName === 'tasks') fetchTasks();
  if (viewName === 'session') fetchSession();
  if (viewName === 'visual-replies') fetchVisualReplies();
  if (viewName === 'profile-analysis') loadProfileAnalysisView();
  if (viewName === 'settings') {
    fetchSettings();
    fetchAutostartStatus();
  }
  if (viewName === 'logs') fetchLogs();
}

// 3. API Fetchers
async function fetchStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.success) {
      updateDashboardUI(data);
    }
  } catch (err) {
    updateHeaderStatus('offline', '服务未响应');
  }
}

function updateDashboardUI(data) {
  const modeStr = data.botMode || (data.botEnabled ? 'AI_ENHANCED' : 'DISABLED');
  const stateStr = data.lifecycleState || (data.botEnabled ? 'RUNNING' : 'STOPPED');
  const isAuthed = data.sessionState === 'authenticated' || data.sessionState === 'resumed';

  // Update Header Badges
  if (data.emergencyStop) {
    updateHeaderStatus('danger', '🛑 紧急停止中');
  } else if (stateStr === 'ERROR') {
    updateHeaderStatus('danger', `❌ [${modeStr}] ERROR: ${data.lastError || '异常'}`);
  } else if (modeStr === 'DISABLED' || !data.botEnabled || stateStr === 'STOPPED') {
    updateHeaderStatus('warning', `⏸️ [${modeStr}] ${stateStr}`);
  } else {
    updateHeaderStatus('success', `▶️ [${modeStr}] ${stateStr}`);
  }

  // Update Power Button (Stop / Resume Bot)
  const btnPower = document.getElementById('btn-header-power');
  if (btnPower) {
    if (stateStr === 'STOPPED') {
      btnPower.className = 'btn btn-primary btn-sm';
      btnPower.innerHTML = '<span id="btn-header-power-text">▶️ 恢复机器人</span>';
      btnPower.disabled = false;
      btnPower.onclick = () => handleAction('/api/bot/resume', '机器人已恢复运行 (浏览器已初始化)');
    } else if (stateStr === 'STARTING') {
      btnPower.className = 'btn btn-secondary btn-sm';
      btnPower.innerHTML = '<span id="btn-header-power-text">⏳ 正在启动...</span>';
      btnPower.disabled = true;
      btnPower.onclick = null;
    } else if (stateStr === 'STOPPING') {
      btnPower.className = 'btn btn-secondary btn-sm';
      btnPower.innerHTML = '<span id="btn-header-power-text">⏳ 正在关闭...</span>';
      btnPower.disabled = true;
      btnPower.onclick = null;
    } else {
      // RUNNING or WAITING
      btnPower.className = 'btn btn-warning btn-sm';
      btnPower.innerHTML = '<span id="btn-header-power-text">⏸️ 关闭机器人</span>';
      btnPower.disabled = false;
      btnPower.onclick = () => handleAction('/api/bot/stop', '机器人已安全关闭 (浏览器已释放)');
    }
  }

  // Update Session Pill
  const sessionPill = document.getElementById('global-session-pill');
  const sessionText = document.getElementById('header-session-text');
  const sessionDot = sessionPill.querySelector('.status-dot');

  if (data.sessionState === 'authenticated' || data.sessionState === 'resumed') {
    sessionDot.className = 'status-dot success';
    sessionText.textContent = 'Steam 凭证正常';
  } else if (data.sessionState === 'waiting_for_login') {
    sessionDot.className = 'status-dot warning pulsating';
    sessionText.textContent = '等待 Steam 登录';
  } else {
    sessionDot.className = 'status-dot danger';
    sessionText.textContent = `会话状态: ${data.sessionState || '未知'}`;
  }

  // Update Top Metrics Cards
  const stats = data.stats || {};
  document.getElementById('metric-today-replies').textContent = stats.totalReplies || 0;
  document.getElementById('metric-local-replies').textContent = stats.localReplies || 0;
  document.getElementById('metric-ai-replies').textContent = stats.aiReplies || 0;
  const holidayElem = document.getElementById('metric-holiday-replies');
  if (holidayElem) {
    holidayElem.textContent = stats.holidayReplies || 0;
  }

  document.getElementById('metric-pending-tasks').textContent = stats.pendingTasks || 0;
  document.getElementById('metric-waiting-login-tasks').textContent = stats.waitingForLoginTasks || 0;
  document.getElementById('metric-uncertain-tasks').textContent = stats.uncertainTasks || 0;

  // Circuit Breaker and Queue Diagnostics
  const cbState = (data.circuitBreaker && data.circuitBreaker.state) || stats.circuitBreakerState || 'CLOSED';
  const cbElem = document.getElementById('metric-circuit-status');
  if (cbElem) {
    cbElem.textContent = cbState;
    cbElem.className = cbState === 'OPEN' ? 'text-danger' : (cbState === 'HALF_OPEN' ? 'text-warning' : 'text-success');
  }

  const oldestElem = document.getElementById('metric-oldest-pending');
  if (oldestElem) {
    const oldestIso = (data.queueDiagnostics && data.queueDiagnostics.oldestPendingTaskAt) || stats.oldestPendingTaskAt;
    oldestElem.textContent = oldestIso ? formatTime(oldestIso) : '-';
  }

  const lastSendElem = document.getElementById('metric-last-send');
  if (lastSendElem) {
    const lastSendIso = (data.queueDiagnostics && data.queueDiagnostics.lastSendAttemptAt) || stats.lastSendAttemptAt;
    const lastStatus = (data.queueDiagnostics && data.queueDiagnostics.lastSendStatus) || (data.lastSendResult && data.lastSendResult.status);
    lastSendElem.textContent = lastSendIso ? `${formatTime(lastSendIso)}${lastStatus ? ' (' + lastStatus + ')' : ''}` : '-';
  }

  const savedCount = (stats.localReplies || 0) + (stats.visualExpressionReplies || 0) + (stats.holidayReplies || 0);
  document.getElementById('metric-saved-requests').textContent = savedCount;
  document.getElementById('metric-spam-count').textContent = stats.spamCount || 0;
  document.getElementById('metric-visual-count').textContent = stats.visualExpressionReplies || 0;

  const sessionStatusText = isAuthed
    ? '🟢 正常登录'
    : (data.sessionState === 'waiting_for_login' ? '🔴 未登录' : '🔴 未登录');
  document.getElementById('metric-session-status').textContent = sessionStatusText;
  document.getElementById('metric-session-status').className = `metric-value ${isAuthed ? 'text-success' : 'text-danger'}`;
  document.getElementById('metric-account-name').textContent = data.accountName || '-';

  // Update Footer Info
  document.getElementById('uptime-label').textContent = formatSeconds(data.uptimeSeconds || 0);
  document.getElementById('memory-label').textContent = `${data.memoryMb || 0} MB`;

  // Update Human-Friendly Status Box
  const humanSessionVal = document.getElementById('human-session-val');
  const humanQueueVal = document.getElementById('human-queue-val');
  const humanReasonVal = document.getElementById('human-reason-val');
  const humanActionBox = document.getElementById('human-action-box');

  if (humanSessionVal) {
    humanSessionVal.innerHTML = isAuthed
      ? `<span class="text-success">🟢 正常登录 (${escapeHtml(data.accountName || '已连接')})</span>`
      : `<span class="text-danger">🔴 未登录</span>`;
  }

  if (humanQueueVal) {
    if (data.emergencyStop) {
      humanQueueVal.innerHTML = `<span class="text-danger">🛑 紧急停止</span>`;
    } else if (stateStr === 'ERROR') {
      humanQueueVal.innerHTML = `<span class="text-danger">❌ 异常 (${escapeHtml(data.lastError || 'ERROR')})</span>`;
    } else if (cbState === 'OPEN') {
      humanQueueVal.innerHTML = `<span class="text-danger">⚠️ 熔断冷却中 (OPEN)</span>`;
    } else if (cbState === 'HALF_OPEN') {
      humanQueueVal.innerHTML = `<span class="text-warning">🟡 熔断探测中 (HALF_OPEN)</span>`;
    } else if (modeStr === 'DISABLED' || !data.botEnabled) {
      humanQueueVal.innerHTML = `<span class="text-warning">⏸ [${modeStr}] ${stateStr}</span>`;
    } else {
      humanQueueVal.innerHTML = `<span class="text-success">▶️ [${modeStr}] ${stateStr}</span>`;
    }
  }

  if (humanReasonVal) {
    if (data.emergencyStop) {
      humanReasonVal.textContent = '管理员已触发紧急停止，所有任务已冻结';
      humanReasonVal.style.color = 'var(--color-danger)';
    } else if (data.sessionState === 'waiting_for_login') {
      humanReasonVal.textContent = 'Steam 登录会话无效，已自动暂停发送以保护账号';
      humanReasonVal.style.color = 'var(--color-warning)';
    } else if (cbState === 'OPEN') {
      const remSec = (data.circuitBreaker && data.circuitBreaker.remainingSeconds) || 0;
      humanReasonVal.textContent = `Steam 发送触发熔断保护 (OPEN)，安全冷却中${remSec ? ' (剩余 ' + remSec + 's)' : ''}，到期后自动探针恢复`;
      humanReasonVal.style.color = 'var(--color-danger)';
    } else if (cbState === 'HALF_OPEN') {
      humanReasonVal.textContent = '熔断冷却已到期，正在执行单次健康探针以验证 Steam 发送能力';
      humanReasonVal.style.color = 'var(--color-warning)';
    } else if (!data.botEnabled) {
      humanReasonVal.textContent = '管理员手动暂停了回复队列';
      humanReasonVal.style.color = 'var(--color-warning)';
    } else {
      humanReasonVal.textContent = 'Steam 登录正常，调度器自动频控运行中';
      humanReasonVal.style.color = 'var(--color-success)';
    }
  }

  // Update Mode Buttons active state
  document.querySelectorAll('#mode-btn-group .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === modeStr);
  });

  // Sync login in progress status
  const inProg = Boolean(data.loginInProgress || data.isInteractiveLoginActive);
  if (inProg) {
    setLoginButtonActive(true);
  } else if (isLoginWindowActive && !inProg) {
    setLoginButtonActive(false);
  }

  if (humanActionBox) {
    if (!isAuthed || data.sessionState === 'waiting_for_login') {
      humanActionBox.innerHTML = `<button class="btn btn-warning" id="btn-human-login">${isLoginWindowActive ? '⏳ 正在准备 Steam 登录窗口...' : '🔑 登录 Steam'}</button>`;
      const btnHLogin = document.getElementById('btn-human-login');
      if (btnHLogin) {
        btnHLogin.disabled = isLoginWindowActive;
        btnHLogin.addEventListener('click', triggerLogin);
      }
    } else if (data.emergencyStop || !data.botEnabled) {
      humanActionBox.innerHTML = `<button class="btn btn-primary" id="btn-human-resume">▶️ 恢复发送队列</button>`;
      const btnHResume = document.getElementById('btn-human-resume');
      if (btnHResume) {
        btnHResume.addEventListener('click', () => handleAction('/api/bot/resume', '发送队列已恢复正常'));
      }
    } else {
      humanActionBox.innerHTML = `<button class="btn btn-outline" id="btn-human-check">🔍 会话体检</button>`;
      const btnHCheck = document.getElementById('btn-human-check');
      if (btnHCheck) {
        btnHCheck.addEventListener('click', () => {
          showToast('正在体检 Steam 会话...', 'info');
          handleAction('/api/session/check', '会话体检完成');
        });
      }
    }
  }

  // Update Sidebar
  document.getElementById('uptime-label').textContent = formatSeconds(data.uptimeSeconds || 0);
  document.getElementById('memory-label').textContent = `${data.memoryMb || 0} MB`;

  const pendingBadge = document.getElementById('sidebar-pending-badge');
  if (stats.pendingTasks > 0) {
    pendingBadge.textContent = stats.pendingTasks;
    pendingBadge.style.display = 'inline-block';
  } else {
    pendingBadge.style.display = 'none';
  }

  // Update Inspector Details
  document.getElementById('disp-last-polled').textContent = formatTime(data.lastPolledAt);

  const dispNext = document.getElementById('disp-next-polled');
  if (dispNext) {
    if (data.nextPolledAt) {
      dispNext.textContent = formatTime(data.nextPolledAt);
    } else if (stateStr === 'STOPPED' || !data.isRunning) {
      dispNext.textContent = '已停止 (STOPPED)';
    } else {
      dispNext.textContent = '准备轮询中...';
    }
  }

  const dispMode = document.getElementById('disp-bot-mode');
  if (dispMode) {
    const badgeCls = modeStr === 'LOCAL_ONLY' ? 'badge-success' : (modeStr === 'AI_ENHANCED' ? 'badge-info' : 'badge-warning');
    dispMode.innerHTML = `<span class="badge ${badgeCls}">${escapeHtml(modeStr)}</span>`;
  }

  const dispBrowser = document.getElementById('disp-browser-state');
  if (dispBrowser) {
    const bState = data.browserState || 'RELEASED';
    const bCls = bState === 'ACTIVE' ? 'badge-success' : 'badge-secondary';
    dispBrowser.innerHTML = `<span class="badge ${bCls}">${escapeHtml(bState)}</span>`;
  }

  const dispLag = document.getElementById('disp-poll-lag');
  if (dispLag) {
    if (data.pollLag && data.pollLag.detected) {
      dispLag.innerHTML = `<span class="badge badge-danger">⚠️ 滞后 ${data.pollLag.lagSeconds}s</span>`;
    } else {
      dispLag.innerHTML = `<span class="badge badge-success">正常 (无滞后)</span>`;
    }
  }

  const dispCatchup = document.getElementById('disp-catchup-count');
  if (dispCatchup) {
    const count = (data.catchup && data.catchup.lastCatchupCommentsCount) || 0;
    const exceeded = (data.catchup && data.catchup.limitExceeded);
    dispCatchup.innerHTML = `${count} 条${exceeded ? ' <span class="badge badge-warning">达到500条上限</span>' : ''}`;
  }

  if (data.lastSendResult) {
    document.getElementById('disp-last-target').textContent = data.lastSendResult.target || '无';
    document.getElementById('disp-last-send-status').innerHTML = renderStatusBadge(data.lastSendResult.status);
    document.getElementById('disp-last-send-msg').textContent = data.lastSendResult.message || (data.lastSendResult.status === 'SUCCESS' ? '发送成功并校验上墙' : '-');
  }

  if (data.config) {
    document.getElementById('disp-config-profile').textContent = data.config.profileUrl || '-';
    document.getElementById('disp-config-mode').textContent = `${data.config.headless ? 'HEADLESS (无头)' : 'VISIBLE (可视)'}${data.config.dryRun ? ' | DRY-RUN' : ''}`;
  }

  // Notice box update
  const noticeBox = document.getElementById('dashboard-notice-box');
  const noticeText = document.getElementById('dashboard-notice-text');
  if (data.sessionState === 'waiting_for_login') {
    noticeBox.style.borderColor = 'var(--color-warning)';
    noticeText.innerHTML = '<b>会话提示:</b> 当前 Steam 登录会话无效，发送队列已自动暂停。请点击<b>「登录 Steam」</b>完成登录以恢复发送。';
  } else if (data.emergencyStop) {
    noticeBox.style.borderColor = 'var(--color-danger)';
    noticeText.innerHTML = '<b>急停生效中:</b> 紧急停止已被触发，所有轮询与发送已冻结。';
  } else if (!data.botEnabled) {
    noticeBox.style.borderColor = 'var(--color-warning)';
    noticeText.innerHTML = '<b>队列暂停中:</b> 发送队列处于暂停状态，监控仍在采集但不会发起评论。点击“继续发送队列”可恢复。';
  } else {
    noticeBox.style.borderColor = 'var(--color-info)';
    noticeText.innerHTML = '系统调度器正在正常工作中。自动频率保护与防重复机制处于活跃状态。';
  }

  document.getElementById('last-sync-time').textContent = `最后同步: ${new Date().toLocaleTimeString()}`;
}

function updateHeaderStatus(type, text) {
  const pill = document.getElementById('global-status-pill');
  const dot = pill.querySelector('.status-dot');
  const label = document.getElementById('header-status-text');

  dot.className = `status-dot ${type}`;
  label.textContent = text;
}

// 4. Tasks View Handling
async function fetchTasks() {
  try {
    const res = await fetch(`${API_BASE}/api/tasks?status=${currentTaskFilter}&limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      renderTasksTable(data.tasks);
    }
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
  }
}

function renderTasksTable(tasks) {
  const tbody = document.getElementById('tasks-table-body');
  if (!tasks || tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">当前暂无符合条件的回复任务</td></tr>`;
    return;
  }

  tbody.innerHTML = tasks.map(t => {
    const commenter = escapeHtml(t.commenter_name || t.target_steam_id || 'Steam用户');
    const commentSnippet = escapeHtml(t.comment_content || '-');
    const replySnippet = escapeHtml(t.reply_text || '-');
    const classification = t.classification || (t.reply_source ? t.reply_source.toUpperCase() : 'UNKNOWN');

    return `
      <tr>
        <td><code>${escapeHtml(t.task_id.substring(0, 10))}...</code></td>
        <td>
          <div><b>${commenter}</b></div>
          <small class="text-muted">${t.target_steam_id || ''}</small>
        </td>
        <td class="text-break" style="max-width: 220px;" title="${commentSnippet}">${commentSnippet.substring(0, 45)}${commentSnippet.length > 45 ? '...' : ''}</td>
        <td><span class="badge badge-info">${escapeHtml(classification)}</span></td>
        <td class="text-break" style="max-width: 220px;" title="${replySnippet}">${replySnippet.substring(0, 45)}${replySnippet.length > 45 ? '...' : ''}</td>
        <td>${renderStatusBadge(t.task_status)}</td>
        <td><small>${formatTime(t.created_at)}</small></td>
        <td>
          <button class="btn btn-outline btn-sm btn-view-task" data-json='${encodeURIComponent(JSON.stringify(t))}'>详情</button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.btn-view-task').forEach(btn => {
    btn.addEventListener('click', () => {
      const taskJson = JSON.parse(decodeURIComponent(btn.getAttribute('data-json')));
      showTaskModal(taskJson);
    });
  });
}

function setupTaskFilters() {
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentTaskFilter = pill.getAttribute('data-filter');
      fetchTasks();
    });
  });
}

// 5. Session View Handling
async function fetchSession() {
  try {
    const res = await fetch(`${API_BASE}/api/session`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.health) {
      renderSessionUI(data.health);
    }
  } catch (err) {
    console.error('Failed to fetch session:', err);
  }
}

function renderSessionUI(health) {
  const nameEl = document.getElementById('session-account-name');
  const steamIdEl = document.getElementById('session-steamid');
  const linkEl = document.getElementById('session-profile-link');
  const validBadge = document.getElementById('session-valid-badge');
  const cookieLogin = document.getElementById('session-cookie-login');
  const cookieSessid = document.getElementById('session-cookie-sessid');
  const lastCheck = document.getElementById('session-last-check');
  const failReason = document.getElementById('session-fail-reason');

  nameEl.textContent = health.accountName || (health.valid ? '已登录' : '未登录');
  document.getElementById('metric-account-name').textContent = health.accountName || '-';
  steamIdEl.textContent = `SteamID64: ${health.steamId64 || '(无)'}`;

  if (health.profileUrl) {
    linkEl.href = health.profileUrl;
    linkEl.style.display = 'inline-block';
  } else {
    linkEl.style.display = 'none';
  }

  if (health.valid) {
    validBadge.className = 'badge badge-success';
    validBadge.textContent = 'SESSION_VALID (有效)';
  } else {
    validBadge.className = 'badge badge-danger';
    validBadge.textContent = 'SESSION_INVALID (失效)';
  }

  cookieLogin.className = health.hasSteamLoginSecure ? 'badge badge-success' : 'badge badge-danger';
  cookieLogin.textContent = health.hasSteamLoginSecure ? '已加载 (Present)' : '缺失 (Absent)';

  cookieSessid.className = health.hasSessionIdCookie ? 'badge badge-success' : 'badge badge-secondary';
  cookieSessid.textContent = health.hasSessionIdCookie ? '已获取 (Present)' : '未生成 (按需动态获取)';

  lastCheck.textContent = formatTime(health.checkedAt);
  failReason.textContent = health.reason || '无 (健康)';
}

// 6. Settings View Handling
async function fetchSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.config) {
      populateSettingsForm(data.config);
    }
  } catch (err) {
    showToast('获取配置失败', 'danger');
  }
}

function populateSettingsForm(cfg) {
  document.getElementById('cfg-steam-profile').value = cfg.STEAM_PROFILE_URL || '';
  document.getElementById('cfg-poll-min').value = cfg.CHECK_INTERVAL_MIN_SECONDS || 90;
  document.getElementById('cfg-poll-max').value = cfg.CHECK_INTERVAL_MAX_SECONDS || 180;
  document.getElementById('cfg-delay-min').value = cfg.MIN_REPLY_DELAY_SECONDS || 0;
  document.getElementById('cfg-delay-max').value = cfg.MAX_REPLY_DELAY_SECONDS || 0;
  document.getElementById('cfg-hourly-limit').value = cfg.MAX_REPLIES_PER_HOUR || 10;
  document.getElementById('cfg-daily-limit').value = cfg.MAX_REPLIES_PER_DAY || 50;

  document.getElementById('cfg-deepseek-key').value = cfg.DEEPSEEK_API_KEY || '';
  document.getElementById('cfg-deepseek-model').value = cfg.DEEPSEEK_MODEL || 'deepseek-chat';
  document.getElementById('cfg-deepseek-url').value = cfg.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

  document.getElementById('cfg-dry-run').checked = Boolean(cfg.DRY_RUN);
  document.getElementById('cfg-headless').checked = cfg.HEADLESS !== false;

  const elHolidayMax = document.getElementById('cfg-holiday-max');
  if (elHolidayMax) elHolidayMax.value = cfg.MAX_HOLIDAY_MESSAGES_PER_DAY ?? 10;
  const elHolidayDays = document.getElementById('cfg-holiday-days');
  if (elHolidayDays) elHolidayDays.value = cfg.HOLIDAY_ACTIVE_DAYS ?? 90;
  const elHolidayStart = document.getElementById('cfg-holiday-start');
  if (elHolidayStart) elHolidayStart.value = cfg.HOLIDAY_SEND_START || '09:00';
  const elHolidayEnd = document.getElementById('cfg-holiday-end');
  if (elHolidayEnd) elHolidayEnd.value = cfg.HOLIDAY_SEND_END || '22:00';
  const elLang = document.getElementById('cfg-default-language');
  if (elLang) elLang.value = cfg.DEFAULT_LANGUAGE || 'zh';
}

function setupSettingsForm() {
  const btnSave = document.getElementById('btn-save-settings');
  btnSave.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isSavingConfig) return;

    const payload = {
      STEAM_PROFILE_URL: document.getElementById('cfg-steam-profile').value.trim(),
      CHECK_INTERVAL_MIN_SECONDS: parseInt(document.getElementById('cfg-poll-min').value, 10),
      CHECK_INTERVAL_MAX_SECONDS: parseInt(document.getElementById('cfg-poll-max').value, 10),
      MIN_REPLY_DELAY_SECONDS: parseInt(document.getElementById('cfg-delay-min').value, 10),
      MAX_REPLY_DELAY_SECONDS: parseInt(document.getElementById('cfg-delay-max').value, 10),
      MAX_REPLIES_PER_HOUR: parseInt(document.getElementById('cfg-hourly-limit').value, 10),
      MAX_REPLIES_PER_DAY: parseInt(document.getElementById('cfg-daily-limit').value, 10),
      DEEPSEEK_API_KEY: document.getElementById('cfg-deepseek-key').value.trim(),
      DEEPSEEK_MODEL: document.getElementById('cfg-deepseek-model').value.trim(),
      DEEPSEEK_BASE_URL: document.getElementById('cfg-deepseek-url').value.trim(),
      DRY_RUN: document.getElementById('cfg-dry-run').checked,
      HEADLESS: document.getElementById('cfg-headless').checked,
      MAX_HOLIDAY_MESSAGES_PER_DAY: parseInt(document.getElementById('cfg-holiday-max')?.value || '10', 10),
      HOLIDAY_ACTIVE_DAYS: parseInt(document.getElementById('cfg-holiday-days')?.value || '90', 10),
      HOLIDAY_SEND_START: document.getElementById('cfg-holiday-start')?.value?.trim() || '09:00',
      HOLIDAY_SEND_END: document.getElementById('cfg-holiday-end')?.value?.trim() || '22:00',
      DEFAULT_LANGUAGE: document.getElementById('cfg-default-language')?.value || 'zh'
    };

    isSavingConfig = true;
    btnSave.textContent = '保存中...';

    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('配置已成功保存并实时生效', 'success');
      } else {
        showToast(data.error || '保存配置失败', 'danger');
      }
    } catch (err) {
      showToast('网络请求失败: ' + err.message, 'danger');
    } finally {
      isSavingConfig = false;
      btnSave.textContent = '💾 保存配置修改';
    }
  });
}

// 6.5 Windows Autostart Handling
async function fetchAutostartStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/autostart/status`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      renderAutostartUI(data);
    }
  } catch (err) {
    console.error('Failed to fetch autostart status:', err);
  }
}

function renderAutostartUI(data) {
  const badge = document.getElementById('autostart-status-badge');
  const trig = document.getElementById('autostart-trigger-val');
  const details = document.getElementById('autostart-details-val');
  if (badge) {
    if (data.enabled) {
      badge.className = 'badge badge-success';
      badge.textContent = '已开启 (ACTIVE)';
    } else {
      badge.className = 'badge badge-secondary';
      badge.textContent = '未开启 (DISABLED)';
    }
  }
  if (trig) {
    trig.textContent = data.trigger || '无';
  }
  if (details) {
    details.textContent = data.details || (data.enabled ? '任务计划正常配置' : '未注册 Windows 计划任务');
  }
}

function setupAutostartHandlers() {
  const btnEnable = document.getElementById('btn-autostart-enable');
  const btnDisable = document.getElementById('btn-autostart-disable');
  const selTrigger = document.getElementById('autostart-trigger-select');

  if (btnEnable) {
    btnEnable.addEventListener('click', async () => {
      btnEnable.disabled = true;
      try {
        const trigger = selTrigger ? selTrigger.value : 'ONLOGON';
        const res = await fetch(`${API_BASE}/api/autostart/enable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger })
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || '自启动已成功开启', 'success');
        } else {
          showToast(data.error || '开启自启动失败', 'danger');
        }
        await fetchAutostartStatus();
      } catch (err) {
        showToast('请求失败: ' + err.message, 'danger');
      } finally {
        btnEnable.disabled = false;
      }
    });
  }

  if (btnDisable) {
    btnDisable.addEventListener('click', async () => {
      btnDisable.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/autostart/disable`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || '自启动已成功禁用', 'success');
        } else {
          showToast(data.error || '禁用自启动失败', 'danger');
        }
        await fetchAutostartStatus();
      } catch (err) {
        showToast('请求失败: ' + err.message, 'danger');
      } finally {
        btnDisable.disabled = false;
      }
    });
  }
}

let cachedRawLogs = [];
let currentLogCategory = 'all';
let showTechnicalLogs = false;
let isLoginWindowActive = false;

function setLoginButtonActive(inProgress) {
  isLoginWindowActive = inProgress;
  const buttons = [
    document.getElementById('btn-ctrl-open-login'),
    document.getElementById('btn-session-login'),
    document.getElementById('btn-human-login')
  ];
  buttons.forEach(btn => {
    if (!btn) return;
    btn.disabled = inProgress;
    if (inProgress) {
      if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
      btn.textContent = '⏳ 正在准备 Steam 登录窗口...';
    } else if (btn.dataset.origText) {
      btn.textContent = btn.dataset.origText;
    }
  });
}

// 7. Logs View Handling
async function fetchLogs() {
  try {
    const res = await fetch(`${API_BASE}/api/logs?limit=250`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.logs) {
      cachedRawLogs = data.logs;
      renderLogs(cachedRawLogs);
    }
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  }
}

function renderLogs(logs) {
  const userContainer = document.getElementById('user-log-container');
  const techContainer = document.getElementById('log-stream-container');
  const searchKw = (document.getElementById('log-search-input').value || '').toLowerCase().trim();
  const autoscroll = document.getElementById('log-autoscroll').checked;

  if (showTechnicalLogs) {
    if (userContainer) userContainer.style.display = 'none';
    if (techContainer) techContainer.style.display = 'block';

    const filtered = (logs || []).filter(l => {
      if (searchKw) {
        const str = (l.event + ' ' + JSON.stringify(l.details || '')).toLowerCase();
        if (!str.includes(searchKw)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      techContainer.innerHTML = `<div class="text-muted text-center py-4">无匹配技术日志</div>`;
      return;
    }

    techContainer.innerHTML = filtered.map(l => {
      const timeStr = l.timestamp ? l.timestamp.substring(11, 19) : '--:--:--';
      const badgeClass = l.level === 'ERROR' ? 'badge-danger' : (l.level === 'WARN' ? 'badge-warning' : 'badge-info');
      let detailPreview = '';
      if (l.details) {
        detailPreview = typeof l.details === 'object' ? JSON.stringify(l.details) : String(l.details);
      }

      return `
        <div class="log-entry ${l.level}" title="${escapeHtml(detailPreview)}">
          <span class="log-time">[${timeStr}]</span>
          <span class="log-badge ${badgeClass}">${l.level}</span>
          <span class="log-msg"><b>[${escapeHtml(l.event)}]</b> ${escapeHtml(detailPreview)}</span>
        </div>
      `;
    }).join('');

    if (autoscroll && techContainer) {
      techContainer.scrollTop = techContainer.scrollHeight;
    }
  } else {
    // Default: User-Friendly Log View
    if (techContainer) techContainer.style.display = 'none';
    if (userContainer) userContainer.style.display = 'flex';

    const mapper = (window.LogPresentation && window.LogPresentation.mapLogToPresentation)
      ? window.LogPresentation.mapLogToPresentation
      : function(l, idx) {
          return {
            id: 'log_' + idx,
            timeStr: l.timestamp ? l.timestamp.substring(11, 19) : '--:--:--',
            title: l.event,
            icon: l.level === 'ERROR' ? '🔴' : (l.level === 'WARN' ? '🟡' : 'ℹ️'),
            level: l.level === 'ERROR' ? 'error' : (l.level === 'WARN' ? 'warn' : 'info'),
            categories: ['all'],
            message: JSON.stringify(l.details || ''),
            technicalEvent: l.event,
            rawJson: JSON.stringify(l, null, 2)
          };
        };

    const mapped = (logs || []).map((l, i) => mapper(l, i));

    const filtered = mapped.filter(item => {
      // Category filter
      if (currentLogCategory !== 'all') {
        if (currentLogCategory === 'important') {
          if (!item.isImportant) return false;
        } else if (!item.categories.includes(currentLogCategory)) {
          return false;
        }
      }

      // Keyword search
      if (searchKw) {
        const fullSearchable = (item.title + ' ' + item.message + ' ' + (item.suggestion || '') + ' ' + item.technicalEvent + ' ' + item.rawJson).toLowerCase();
        if (!fullSearchable.includes(searchKw)) return false;
      }

      return true;
    });

    if (filtered.length === 0) {
      userContainer.innerHTML = `<div class="text-muted text-center py-4">当前分类下暂无运行日志</div>`;
      return;
    }

    userContainer.innerHTML = filtered.map(item => {
      const badgeClass = item.level === 'error' ? 'badge-danger' : (item.level === 'warn' ? 'badge-warning' : (item.level === 'success' ? 'badge-success' : 'badge-info'));
      return `
        <div class="user-log-card level-${item.level}">
          <div class="user-log-header">
            <div class="user-log-title-wrap">
              <span class="user-log-icon">${item.icon}</span>
              <span class="user-log-title">${escapeHtml(item.title)}</span>
              <span class="badge ${badgeClass}" style="font-size: 10px; padding: 1px 6px;">${item.level.toUpperCase()}</span>
            </div>
            <div class="user-log-meta">
              <span class="user-log-time">[${item.timeStr}]</span>
            </div>
          </div>
          <div class="user-log-message">${escapeHtml(item.message)}</div>
          ${item.suggestion ? `<div class="user-log-suggestion">👉 建议: ${escapeHtml(item.suggestion)}</div>` : ''}
          <div class="user-log-actions">
            <button class="btn-tech-detail" data-target="tech_${item.id}">[查看技术详情]</button>
          </div>
          <div class="user-log-tech-box" id="tech_${item.id}"><pre><code>${escapeHtml(item.rawJson)}</code></pre></div>
        </div>
      `;
    }).join('');

    if (autoscroll && userContainer) {
      userContainer.scrollTop = userContainer.scrollHeight;
    }
  }
}

function setupLogControls() {
  document.getElementById('log-search-input').addEventListener('input', () => renderLogs(cachedRawLogs));

  const techToggle = document.getElementById('toggle-tech-logs');
  if (techToggle) {
    techToggle.addEventListener('change', (e) => {
      showTechnicalLogs = e.target.checked;
      renderLogs(cachedRawLogs);
    });
  }

  const catPills = document.querySelectorAll('.log-cat-pill');
  catPills.forEach(pill => {
    pill.addEventListener('click', (e) => {
      catPills.forEach(p => p.classList.remove('active'));
      e.currentTarget.classList.add('active');
      currentLogCategory = e.currentTarget.dataset.cat || 'all';
      renderLogs(cachedRawLogs);
    });
  });

  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    cachedRawLogs = [];
    const uBox = document.getElementById('user-log-container');
    if (uBox) uBox.innerHTML = '<div class="text-muted text-center py-4">日志已清空</div>';
    const tBox = document.getElementById('log-stream-container');
    if (tBox) tBox.innerHTML = '<div class="text-muted text-center py-4">日志已清空</div>';
  });

  // Accordion toggle delegation for [查看技术详情]
  const userLogContainer = document.getElementById('user-log-container');
  if (userLogContainer) {
    userLogContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-tech-detail');
      if (!btn) return;
      const targetId = btn.dataset.target;
      if (!targetId) return;
      const box = document.getElementById(targetId);
      if (box) {
        box.classList.toggle('active');
        btn.textContent = box.classList.contains('active') ? '[收起技术详情]' : '[查看技术详情]';
      }
    });
  }
}

// 8. Action & Mode Handlers
async function handleAction(endpoint, successMsg) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(successMsg || data.message || '操作成功', 'success');
      await fetchStatus();
      return true;
    } else {
      showToast(data.error || '操作失败', 'danger');
      await fetchStatus();
      return false;
    }
  } catch (e) {
    showToast('网络请求异常: ' + e.message, 'danger');
    await fetchStatus();
    return false;
  }
}

async function triggerLogin() {
  if (isLoginWindowActive) {
    showToast('Steam 登录窗口已打开，请完成登录。', 'warning');
    return;
  }
  setLoginButtonActive(true);
  showToast('正在准备 Steam 登录窗口…', 'info');
  try {
    const res = await fetch(`${API_BASE}/api/session/login`, { method: 'POST' });
    const data = await res.json();
    if (res.status === 409 || data.alreadyInProgress) {
      showToast('Steam 登录窗口已打开，请完成登录。', 'warning');
    } else if (data.success) {
      showToast(data.message || '正在准备 Steam 登录窗口…', 'info');
    } else {
      setLoginButtonActive(false);
      showToast(data.error || '无法打开登录窗口', 'danger');
    }
  } catch (e) {
    setLoginButtonActive(false);
    showToast('请求异常: ' + e.message, 'danger');
  }
}

function setupModeButtons() {
  const modeBtns = document.querySelectorAll('#mode-btn-group .mode-btn');
  modeBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const mode = btn.getAttribute('data-mode');
      if (!mode) return;
      try {
        const res = await fetch(`${API_BASE}/api/bot/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`已切换回复模式为: ${mode}`, 'success');
          await fetchStatus();
        } else {
          showToast(data.error || '切换模式失败', 'danger');
        }
      } catch (err) {
        showToast('请求失败: ' + err.message, 'danger');
      }
    });
  });
}

function setupActionButtons() {
  // Header buttons
  document.getElementById('btn-header-pause').addEventListener('click', () => handleAction('/api/bot/pause', '发送队列已暂停'));
  document.getElementById('btn-header-resume').addEventListener('click', () => handleAction('/api/bot/resume', '发送队列已恢复正常'));
  document.getElementById('btn-header-emergency').addEventListener('click', () => {
    if (confirm('确认触发紧急停止 (Emergency Stop)？所有调度将全部冻结！')) {
      handleAction('/api/bot/emergency-stop', '紧急停止已生效');
    }
  });
  const btnHeaderExit = document.getElementById('btn-header-exit');
  if (btnHeaderExit) {
    btnHeaderExit.addEventListener('click', async () => {
      if (confirm('确认完全退出 SteamAIReplyBot？\n\n程序将停止所有任务、关闭 Playwright 浏览器、释放系统锁并退出后台进程。')) {
        showToast('正在完全退出程序...', 'warning');
        try {
          await fetch(`${API_BASE}/api/bot/exit`, { method: 'POST' });
        } catch {}
        setTimeout(() => {
          document.body.innerHTML = `
            <div style="display: flex; height: 100vh; justify-content: center; align-items: center; background: #171a21; color: #c5c3c0; font-family: sans-serif; flex-direction: column;">
              <h2 style="color: #66c0f4; margin-bottom: 8px;">SteamAIReplyBot 已完全退出</h2>
              <p style="color: #8f98a0; font-size: 14px;">后台调度器已安全停止，浏览器与数据锁均已释放。您可以安全关闭此浏览器标签页。</p>
            </div>
          `;
        }, 1000);
      }
    });
  }

  // Dashboard buttons
  document.getElementById('btn-ctrl-pause').addEventListener('click', () => handleAction('/api/bot/pause', '发送队列已暂停'));
  document.getElementById('btn-ctrl-resume').addEventListener('click', () => handleAction('/api/bot/resume', '发送队列已恢复正常'));
  document.getElementById('btn-ctrl-emergency').addEventListener('click', () => {
    if (confirm('确认触发紧急停止？')) {
      handleAction('/api/bot/emergency-stop', '紧急停止已生效');
    }
  });

  document.getElementById('btn-ctrl-check-session').addEventListener('click', () => {
    showToast('正在体检 Steam 会话...', 'info');
    handleAction('/api/session/check', '会话体检完成');
  });
  document.getElementById('btn-session-recheck').addEventListener('click', () => {
    showToast('正在体检 Steam 会话...', 'info');
    handleAction('/api/session/check', '会话体检完成');
  });

  const btnCtrlLogin = document.getElementById('btn-ctrl-open-login');
  if (btnCtrlLogin) btnCtrlLogin.addEventListener('click', triggerLogin);
  const btnSessLogin = document.getElementById('btn-session-login');
  if (btnSessLogin) btnSessLogin.addEventListener('click', triggerLogin);
  const btnHumanLogin = document.getElementById('btn-human-login');
  if (btnHumanLogin) btnHumanLogin.addEventListener('click', triggerLogin);

  const btnExportDiag = document.getElementById('btn-ctrl-export-diagnostics');
  if (btnExportDiag) {
    btnExportDiag.addEventListener('click', triggerExportDiagnostics);
  }

  document.getElementById('btn-manual-refresh').addEventListener('click', () => {
    fetchStatus();
    showToast('已更新状态', 'info');
  });
}

async function triggerExportDiagnostics() {
  showToast('正在生成并导出系统诊断包 (ZIP)...', 'info');
  try {
    const res = await fetch(`${API_BASE}/api/diagnostics/export`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition');
    let filename = 'steam-bot-diagnostics.zip';
    if (disposition && disposition.includes('filename=')) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) filename = match[1];
    }
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    showToast(`诊断包导出成功: ${filename}`, 'success');
  } catch (err) {
    showToast(`导出诊断包失败: ${err.message}`, 'danger');
  }
}

// 9. Modal Management
function setupModal() {
  const modal = document.getElementById('task-modal');
  const closeBtn = document.getElementById('modal-close-btn');

  closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });
}

function showTaskModal(task) {
  const modal = document.getElementById('task-modal');
  const title = document.getElementById('modal-task-title');
  const body = document.getElementById('modal-task-body');

  title.textContent = `任务详情: ${task.task_id}`;
  body.innerHTML = `
    <div class="detail-row"><span class="detail-label">任务ID:</span><span class="detail-value"><code>${task.task_id}</code></span></div>
    <div class="detail-row"><span class="detail-label">Steam评论ID:</span><span class="detail-value"><code>${task.steam_comment_id}</code></span></div>
    <div class="detail-row"><span class="detail-label">评论者昵称:</span><span class="detail-value">${escapeHtml(task.commenter_name || '-')}</span></div>
    <div class="detail-row"><span class="detail-label">评论者SteamID:</span><span class="detail-value">${task.target_steam_id}</span></div>
    <div class="detail-row"><span class="detail-label">目标主页URL:</span><span class="detail-value text-break"><a href="${task.target_profile_url}" target="_blank" class="profile-link">${task.target_profile_url}</a></span></div>
    <div class="detail-row"><span class="detail-label">分类识别策略:</span><span class="detail-value"><span class="badge badge-info">${task.classification || '-'}</span></span></div>
    <div class="detail-row"><span class="detail-label">当前任务状态:</span><span class="detail-value">${renderStatusBadge(task.task_status)}</span></div>
    <div class="detail-row"><span class="detail-label">重试次数:</span><span class="detail-value">${task.attempt_count} 次</span></div>
    <div class="detail-row"><span class="detail-label">创建时间:</span><span class="detail-value">${formatTime(task.created_at)}</span></div>
    <div class="detail-row"><span class="detail-label">计划执行时间:</span><span class="detail-value">${formatTime(task.scheduled_at)}</span></div>
    <div class="detail-row"><span class="detail-label">完成时间:</span><span class="detail-value">${formatTime(task.completed_at)}</span></div>

    <div class="mt-3">
      <label class="detail-label"><b>原留言内容 (Comment Content):</b></label>
      <div class="guide-box mt-2">${escapeHtml(task.comment_content || '(空)')}</div>
    </div>

    <div class="mt-3">
      <label class="detail-label"><b>拟回复内容 (Reply Text):</b></label>
      <div class="guide-box mt-2" style="border-left-color: var(--color-success);">${escapeHtml(task.reply_text || '(空)')}</div>
    </div>

    ${task.error_message ? `
      <div class="mt-3">
        <label class="detail-label text-danger"><b>错误记录 (Error Message):</b></label>
        <div class="guide-box mt-2" style="border-left-color: var(--color-danger); color: var(--color-danger);">${escapeHtml(task.error_message)}</div>
      </div>
    ` : ''}
  `;

  modal.classList.add('active');
}

// 10. UI Helpers
function renderStatusBadge(status) {
  if (!status) return '<span class="badge badge-secondary">-</span>';
  switch (status.toLowerCase()) {
    case 'replied':
    case 'success':
      return `<span class="badge badge-success">${status.toUpperCase()}</span>`;
    case 'waiting':
    case 'scheduled':
      return `<span class="badge badge-warning">${status.toUpperCase()}</span>`;
    case 'failed':
    case 'target_rejected':
    case 'permission_denied':
      return `<span class="badge badge-danger">${status.toUpperCase()}</span>`;
    case 'waiting_for_login':
      return `<span class="badge badge-warning">WAITING_LOGIN</span>`;
    case 'uncertain_send_state':
    case 'uncertain':
      return `<span class="badge badge-secondary">UNCERTAIN</span>`;
    case 'submitted_moderation_pending':
    case 'moderation_pending':
      return `<span class="badge badge-info">MOD_PENDING</span>`;
    default:
      return `<span class="badge badge-secondary">${status.toUpperCase()}</span>`;
  }
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function formatTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
  } catch {
    return isoStr;
  }
}

function formatSeconds(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================================================
// Visual Reply Library UI Management
// ==========================================================================
let visualRepliesData = [];

async function fetchVisualReplies() {
  try {
    const res = await fetch(`${API_BASE}/api/visual-replies`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.success && Array.isArray(data.items)) {
      visualRepliesData = data.items;
      renderVisualReplies();
    }
  } catch (err) {
    console.error('[fetchVisualReplies Error]:', err);
  }
}

function renderVisualReplies() {
  const container = document.getElementById('visual-items-container');
  const countLabel = document.getElementById('visual-count-label');
  if (!container) return;

  const typeFilter = document.getElementById('visual-type-filter')?.value || 'all';
  const enabledFilter = document.getElementById('visual-enabled-filter')?.value || 'all';

  let filtered = visualRepliesData.slice();

  if (typeFilter !== 'all') {
    filtered = filtered.filter(item => item.type === typeFilter);
  }

  if (enabledFilter === 'enabled') {
    filtered = filtered.filter(item => item.enabled);
  } else if (enabledFilter === 'disabled') {
    filtered = filtered.filter(item => !item.enabled);
  }

  if (countLabel) {
    countLabel.textContent = `共 ${filtered.length} / ${visualRepliesData.length} 个素材`;
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="card text-center text-muted py-4" style="grid-column: 1 / -1;">
      没有匹配的视觉回复素材。点击右上角“添加素材”创建新素材。
    </div>`;
    return;
  }

  container.innerHTML = filtered.map(item => {
    const typeBadgeClass = `badge-${item.type || 'custom'}`;
    const tagsHtml = (item.tags || []).map(t => `<span class="visual-pill">#${escapeHtml(t)}</span>`).join(' ');
    const moodHtml = (item.mood || []).map(m => `<span class="visual-pill">🎭 ${escapeHtml(m)}</span>`).join(' ');

    return `
      <div class="visual-card ${item.enabled ? '' : 'disabled'}" data-id="${escapeHtml(item.id)}">
        <div class="visual-card-header">
          <span class="visual-card-id" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</span>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="visual-pill ${typeBadgeClass}">${escapeHtml(item.type)}</span>
            <span class="visual-pill" title="权重 (Weight)">⚡ ${item.weight || 10}</span>
          </div>
        </div>

        <div class="visual-card-preview">${escapeHtml(item.content)}</div>

        ${item.description ? `<div class="text-muted text-sm" style="font-size: 12px;">${escapeHtml(item.description)}</div>` : ''}

        <div class="visual-card-meta">
          ${tagsHtml}
          ${moodHtml}
        </div>

        <div class="visual-card-actions">
          <button class="btn btn-sm ${item.enabled ? 'btn-secondary' : 'btn-success'} btn-toggle-visual" data-id="${escapeHtml(item.id)}" data-enabled="${item.enabled}">
            ${item.enabled ? '⏸️ 禁用' : '▶️ 启用'}
          </button>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-sm btn-secondary btn-edit-visual" data-id="${escapeHtml(item.id)}">✏️ 编辑</button>
            <button class="btn btn-sm btn-danger btn-delete-visual" data-id="${escapeHtml(item.id)}">🗑️ 删除</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Attach card event listeners
  container.querySelectorAll('.btn-toggle-visual').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const current = btn.getAttribute('data-enabled') === 'true';
      await toggleVisualItem(id, !current);
    });
  });

  container.querySelectorAll('.btn-edit-visual').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const item = visualRepliesData.find(i => i.id === id);
      if (item) openVisualModal(item);
    });
  });

  container.querySelectorAll('.btn-delete-visual').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (confirm(`确定要删除视觉素材 [${id}] 吗？`)) {
        await deleteVisualItem(id);
      }
    });
  });
}

async function toggleVisualItem(id, newState) {
  try {
    const res = await fetch(`${API_BASE}/api/visual-replies/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled: newState })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`素材 [${id}] 已${newState ? '启用' : '禁用'}`, 'success');
      await fetchVisualReplies();
    } else {
      showToast(`操作失败: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`网络请求错误: ${err.message}`, 'error');
  }
}

async function deleteVisualItem(id) {
  try {
    const res = await fetch(`${API_BASE}/api/visual-replies/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`素材 [${id}] 已删除`, 'success');
      await fetchVisualReplies();
    } else {
      showToast(`删除失败: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`删除失败: ${err.message}`, 'error');
  }
}

function openVisualModal(item = null) {
  const modal = document.getElementById('visual-modal');
  const title = document.getElementById('visual-modal-title');
  const idInput = document.getElementById('visual-form-id');
  const typeSelect = document.getElementById('visual-form-type');
  const weightInput = document.getElementById('visual-form-weight');
  const contentInput = document.getElementById('visual-form-content');
  const tagsInput = document.getElementById('visual-form-tags');
  const moodInput = document.getElementById('visual-form-mood');
  const descInput = document.getElementById('visual-form-desc');

  if (!modal) return;

  if (item) {
    title.textContent = `编辑视觉回复素材: ${item.id}`;
    idInput.value = item.id;
    idInput.readOnly = true;
    typeSelect.value = item.type || 'kaomoji';
    weightInput.value = item.weight || 15;
    contentInput.value = item.content || '';
    tagsInput.value = (item.tags || []).join(', ');
    moodInput.value = (item.mood || []).join(', ');
    descInput.value = item.description || '';
  } else {
    title.textContent = '添加视觉回复素材';
    idInput.value = '';
    idInput.readOnly = false;
    typeSelect.value = 'kaomoji';
    weightInput.value = 15;
    contentInput.value = '';
    tagsInput.value = '';
    moodInput.value = '';
    descInput.value = '';
  }

  modal.classList.add('active');
}

function closeVisualModal() {
  const modal = document.getElementById('visual-modal');
  if (modal) modal.classList.remove('active');
}

function setupVisualReplyHandlers() {
  // Top Filter Pills
  document.querySelectorAll('.visual-cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const type = pill.getAttribute('data-type') || 'all';
      document.querySelectorAll('.visual-cat-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const select = document.getElementById('visual-type-filter');
      if (select) select.value = type;

      renderVisualReplies();
    });
  });

  document.getElementById('visual-type-filter')?.addEventListener('change', (e) => {
    const selectedType = e.target.value;
    document.querySelectorAll('.visual-cat-pill').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-type') === selectedType);
    });
    renderVisualReplies();
  });

  document.getElementById('visual-enabled-filter')?.addEventListener('change', renderVisualReplies);

  document.getElementById('btn-add-visual-item')?.addEventListener('click', () => {
    openVisualModal();
  });

  document.getElementById('visual-modal-close-btn')?.addEventListener('click', closeVisualModal);
  document.getElementById('visual-modal-cancel-btn')?.addEventListener('click', closeVisualModal);

  document.getElementById('visual-item-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('visual-form-id').value.trim();
    const type = document.getElementById('visual-form-type').value;
    const weight = parseInt(document.getElementById('visual-form-weight').value, 10) || 10;
    const content = document.getElementById('visual-form-content').value;
    const tags = document.getElementById('visual-form-tags').value.split(',').map(s => s.trim()).filter(Boolean);
    const mood = document.getElementById('visual-form-mood').value.split(',').map(s => s.trim()).filter(Boolean);
    const description = document.getElementById('visual-form-desc').value.trim();

    if (!id || !content) {
      showToast('素材 ID 与回复内容不可为空', 'error');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/visual-replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          type,
          content,
          weight,
          tags,
          mood,
          description,
          enabled: true
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`素材 [${id}] 保存成功`, 'success');
        closeVisualModal();
        await fetchVisualReplies();
      } else {
        showToast(`保存失败: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`请求失败: ${err.message}`, 'error');
    }
  });
}

// ==========================================================================
// 8. Profile Analysis & Knowledge Base Handlers
// ==========================================================================

let currentProfileSubTab = 'overview';

function setupProfileAnalysisHandlers() {
  // Sub-tabs switching
  const pills = document.querySelectorAll('#profile-subtab-pills .visual-cat-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const tab = pill.getAttribute('data-tab');
      currentProfileSubTab = tab;
      switchProfileSubTab(tab);
    });
  });

  // Action Buttons
  document.getElementById('btn-profile-sync')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-profile-sync');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ 正在同步...';
    }
    showToast('正在同步 Steam 资料……', 'info');

    try {
      const res = await fetch(`${API_BASE}/api/profile-analysis/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔄 同步 Steam 资料';
        }
        showToast(`Steam 资料同步失败：${data.error || '请求失败'}`, 'error');
        return;
      }
      isProfileSyncing = true;
      previousProfileSyncStatus = 'syncing';
      await fetchProfileStatus();
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 同步 Steam 资料';
      }
      showToast(`Steam 资料同步失败：${err.message}`, 'error');
    }
  });

  document.getElementById('btn-profile-analyze')?.addEventListener('click', async () => {
    try {
      showToast('正在触发 Steam 画像低频分析...', 'info');
      const res = await fetch(`${API_BASE}/api/profile-analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false })
      });
      const data = await res.json();
      if (data.success) {
        showToast('画像分析任务已在后台启动', 'success');
        fetchProfileStatus();
      } else {
        showToast(`分析失败: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`分析请求失败: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-profile-force-analyze')?.addEventListener('click', async () => {
    if (!confirm('确定忽略指纹缓存，强制重新调用 DeepSeek 进行全量画像分析吗？')) return;
    try {
      showToast('正在强制触发全量画像分析...', 'info');
      const res = await fetch(`${API_BASE}/api/profile-analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
      });
      const data = await res.json();
      if (data.success) {
        showToast('强制分析任务已启动', 'success');
        fetchProfileStatus();
      } else {
        showToast(`强制分析失败: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`请求失败: ${err.message}`, 'error');
    }
  });

  // Formal Persona Form Submit
  document.getElementById('formal-persona-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('persona-form-name').value.trim();
    const tone = document.getElementById('persona-form-tone').value;
    const traits = document.getElementById('persona-form-traits').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    const favoriteGames = document.getElementById('persona-form-games').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    const recommendedTopics = document.getElementById('persona-form-topics').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    const communicationStyle = document.getElementById('persona-form-style').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);

    try {
      const res = await fetch(`${API_BASE}/api/profile-analysis/persona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          tone,
          traits,
          favoriteGames,
          recommendedTopics,
          communicationStyle,
          avoidTopics: [],
          updatedAt: new Date().toISOString()
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('正式 Persona 保存成功！日常回复将以此人格为准。', 'success');
      } else {
        showToast(`保存失败: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`保存出错: ${err.message}`, 'error');
    }
  });
}

function switchProfileSubTab(tabName) {
  document.querySelectorAll('.profile-tab-content').forEach(el => {
    el.style.display = el.id === `profile-tab-${tabName}` ? 'block' : 'none';
  });

  if (tabName === 'overview') loadProfileOverview();
  if (tabName === 'facts' || tabName === 'inferences') loadProfileKnowledge();
  if (tabName === 'suggestions') loadPersonaSuggestions();
  if (tabName === 'formal') loadFormalPersonaUI();
  if (tabName === 'raw') loadProfileRawSnapshot();
}

async function loadProfileAnalysisView() {
  await fetchProfileStatus();
  switchProfileSubTab(currentProfileSubTab);
}

async function fetchProfileStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/profile-analysis/status`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.meta) {
      const m = data.meta;
      const statusBadge = document.getElementById('profile-meta-status');
      if (statusBadge) {
        statusBadge.textContent = `状态: ${m.status.toUpperCase()}`;
        statusBadge.className = 'badge ' + (
          m.status === 'completed' ? 'badge-success' :
          m.status === 'analyzing' || m.status === 'syncing' ? 'badge-warning' :
          m.status === 'failed' ? 'badge-danger' : 'badge-secondary'
        );
      }
      const syncTime = document.getElementById('profile-meta-sync-time');
      if (syncTime) syncTime.textContent = `最后同步: ${m.lastSyncAt ? new Date(m.lastSyncAt).toLocaleString() : '从未'}`;
      const analyzeTime = document.getElementById('profile-meta-analyze-time');
      if (analyzeTime) analyzeTime.textContent = `最后分析: ${m.lastAnalyzedAt ? new Date(m.lastAnalyzedAt).toLocaleString() : '从未'}`;
      const fp = document.getElementById('profile-meta-fingerprint');
      if (fp) fp.textContent = m.currentFingerprint ? m.currentFingerprint.substring(0, 12) + '...' : '无';

      const syncBtn = document.getElementById('btn-profile-sync');

      // Check for sync status transition
      if (m.status === 'syncing') {
        if (syncBtn) {
          syncBtn.disabled = true;
          syncBtn.textContent = '⏳ 正在同步...';
        }
        isProfileSyncing = true;
      } else if (isProfileSyncing || previousProfileSyncStatus === 'syncing') {
        if (syncBtn) {
          syncBtn.disabled = false;
          syncBtn.textContent = '🔄 同步 Steam 资料';
        }
        isProfileSyncing = false;

        if (m.status === 'completed') {
          showToast('Steam 资料同步完成', 'success');
          loadProfileOverview();
          if (currentProfileSubTab === 'raw') loadProfileRawSnapshot();
          if (currentProfileSubTab === 'facts' || currentProfileSubTab === 'inferences') loadProfileKnowledge();
        } else if (m.status === 'failed') {
          showToast(`Steam 资料同步失败：${m.lastError || '未知错误'}`, 'error');
        }
      } else {
        if (syncBtn && syncBtn.disabled && syncBtn.textContent.includes('同步')) {
          syncBtn.disabled = false;
          syncBtn.textContent = '🔄 同步 Steam 资料';
        }
      }

      previousProfileSyncStatus = m.status;
    }
  } catch {}
}

async function loadProfileOverview() {
  try {
    const [snapRes, knowRes, personaRes] = await Promise.all([
      fetch(`${API_BASE}/api/profile-analysis/snapshot`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/api/profile-analysis/knowledge`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/api/profile-analysis/persona`).then(r => r.json()).catch(() => null)
    ]);

    const snap = snapRes?.snapshot;
    const know = knowRes?.knowledge;
    const persona = personaRes?.persona;

    const accEl = document.getElementById('profile-overview-account');
    if (accEl) {
      if (!snap) {
        accEl.innerHTML = '<span class="text-muted">尚未采集资料，请点击上方【同步 Steam 资料】</span>';
      } else {
        const p = snap.profile;
        accEl.innerHTML = `
          <div class="mb-2"><strong>昵称:</strong> ${escapeHtml(p.personaName)} (Lv.${p.level || '?'})</div>
          <div class="mb-2"><strong>SteamID:</strong> <code class="font-mono text-xs">${escapeHtml(p.steamId)}</code></div>
          <div class="mb-2"><strong>展柜:</strong> ${p.showcases?.length || 0} 个展柜</div>
          <div class="mb-2"><strong>简介:</strong> <span class="text-muted">${escapeHtml((p.summary || '').substring(0, 80))}${p.summary?.length > 80 ? '...' : ''}</span></div>
          ${p.customSymbols?.length ? `<div><strong>特色符号:</strong> ${escapeHtml(p.customSymbols.join(' '))}</div>` : ''}
        `;
      }
    }

    const gamesEl = document.getElementById('profile-overview-games');
    if (gamesEl) {
      if (!snap?.games?.topPlayedGames?.length) {
        gamesEl.innerHTML = '<span class="text-muted">尚未获取游戏历史</span>';
      } else {
        const top5 = snap.games.topPlayedGames.slice(0, 5);
        gamesEl.innerHTML = `
          <div class="mb-2"><strong>记录游戏总数:</strong> ${snap.games.totalGames} 款</div>
          <div><strong>主要游玩时长:</strong></div>
          <ul style="padding-left: 18px; margin: 4px 0 0 0;">
            ${top5.map(g => `<li>${escapeHtml(g.name)}: <strong>${Math.round(g.hours)}h</strong></li>`).join('')}
          </ul>
        `;
      }
    }

    const aesEl = document.getElementById('profile-overview-aesthetic');
    if (aesEl) {
      if (!persona && (!know || (!know.facts.length && !know.inferences.length))) {
        aesEl.innerHTML = '<span class="text-muted">尚未进行 DeepSeek 画像分析</span>';
      } else {
        aesEl.innerHTML = `
          <div class="mb-2"><strong>正式语气:</strong> <span class="badge badge-info">${escapeHtml(persona?.tone || 'friendly')}</span></div>
          <div class="mb-2"><strong>人设自称:</strong> ${escapeHtml(persona?.name || 'Steam玩家')}</div>
          <div class="mb-2"><strong>知识库条目:</strong> ${know?.facts?.length || 0} 条事实 / ${know?.inferences?.length || 0} 条推断</div>
          ${persona?.traits?.length ? `<div><strong>主要特征:</strong> ${escapeHtml(persona.traits.join('、'))}</div>` : ''}
        `;
      }
    }
  } catch {}
}

async function loadProfileKnowledge() {
  try {
    const res = await fetch(`${API_BASE}/api/profile-analysis/knowledge`);
    const data = await res.json();
    if (!data.success || !data.knowledge) return;

    const facts = data.knowledge.facts || [];
    const inferences = data.knowledge.inferences || [];

    // Facts
    const factsCount = document.getElementById('facts-count-label');
    if (factsCount) factsCount.textContent = `共 ${facts.length} 条事实`;

    const factsList = document.getElementById('facts-list-container');
    if (factsList) {
      if (!facts.length) {
        factsList.innerHTML = '<div class="text-muted text-center py-4">暂无事实记录，请先同步并分析资料。</div>';
      } else {
        factsList.innerHTML = facts.map(f => `
          <div class="card p-2 mb-2" style="background: rgba(255,255,255,0.02); border-left: 3px solid #10b981;">
            <div class="d-flex justify-content-between">
              <span class="badge badge-success text-xs">[事实] ${escapeHtml(f.category)}</span>
              <span class="text-muted text-xs">来源: ${escapeHtml(f.source)} | 置信度 100%</span>
            </div>
            <div class="mt-1 text-sm">${escapeHtml(f.content)}</div>
          </div>
        `).join('');
      }
    }

    // Inferences
    const infCount = document.getElementById('inferences-count-label');
    if (infCount) infCount.textContent = `共 ${inferences.length} 条推断`;

    const infList = document.getElementById('inferences-list-container');
    if (infList) {
      if (!inferences.length) {
        infList.innerHTML = '<div class="text-muted text-center py-4">暂无推断记录。</div>';
      } else {
        infList.innerHTML = inferences.map(inf => `
          <div class="card p-2 mb-2" style="background: rgba(255,255,255,0.02); border-left: 3px solid #3b82f6;">
            <div class="d-flex justify-content-between">
              <span class="badge badge-info text-xs">[推断] ${escapeHtml(inf.category)}</span>
              <span class="text-muted text-xs">置信度: ${Math.round((inf.confidence || 0.8) * 100)}%</span>
            </div>
            <div class="mt-1 text-sm">${escapeHtml(inf.content)}</div>
            ${inf.evidence?.length ? `<div class="mt-1 text-xs text-muted"><strong>证据:</strong> ${escapeHtml(inf.evidence.join('；'))}</div>` : ''}
          </div>
        `).join('');
      }
    }
  } catch {}
}

async function loadPersonaSuggestions() {
  try {
    const res = await fetch(`${API_BASE}/api/profile-analysis/persona-suggestions`);
    const data = await res.json();
    if (!data.success) return;

    const suggestions = data.suggestions || [];
    const countLabel = document.getElementById('suggestions-count-label');
    if (countLabel) countLabel.textContent = `共 ${suggestions.length} 条建议`;

    const container = document.getElementById('suggestions-list-container');
    if (!container) return;

    if (!suggestions.length) {
      container.innerHTML = '<div class="text-muted text-center py-4">暂无 Persona 人设建议。完成画像分析后此处将生成建议。</div>';
      return;
    }

    container.innerHTML = suggestions.map(s => {
      const isPending = s.status === 'pending';
      const isAccepted = s.status === 'accepted';
      const badgeCls = s.confidenceLevel === 'HIGH_CONFIDENCE' ? 'badge-success' : s.confidenceLevel === 'MEDIUM_CONFIDENCE' ? 'badge-info' : 'badge-warning';

      return `
        <div class="card p-3 mb-3" style="background: rgba(255,255,255,0.03); border-left: 4px solid ${isAccepted ? '#10b981' : isPending ? '#f59e0b' : '#6b7280'};">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <div>
              <span class="badge ${badgeCls} text-xs mr-2">${escapeHtml(s.confidenceLevel)}</span>
              <strong>${escapeHtml(s.title || s.suggestion)}</strong>
            </div>
            <div>
              <span class="badge ${isAccepted ? 'badge-success' : isPending ? 'badge-warning' : 'badge-secondary'} text-xs">
                ${isAccepted ? '已应用生效' : isPending ? '待审批' : '已忽略'}
              </span>
            </div>
          </div>
          <div class="text-sm mb-2">${escapeHtml(s.suggestion)}</div>
          ${s.evidence?.length ? `<div class="text-xs text-muted mb-2"><strong>推断证据:</strong> ${escapeHtml(s.evidence.join('；'))}</div>` : ''}
          ${isPending ? `
            <div class="mt-2 text-right">
              <button class="btn btn-sm btn-secondary mr-2" onclick="rejectPersonaSuggestion('${s.id}')">忽略</button>
              <button class="btn btn-sm btn-primary" onclick="applyPersonaSuggestion('${s.id}')">✅ 应用到正式 Persona</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } catch {}
}

async function applyPersonaSuggestion(id) {
  try {
    const res = await fetch(`${API_BASE}/api/profile-analysis/suggestions/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已成功应用到正式 Persona！', 'success');
      loadPersonaSuggestions();
      loadFormalPersonaUI();
    } else {
      showToast(`应用失败: ${data.message || data.error}`, 'error');
    }
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
}

async function rejectPersonaSuggestion(id) {
  try {
    const res = await fetch(`${API_BASE}/api/profile-analysis/suggestions/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已忽略该建议', 'info');
      loadPersonaSuggestions();
    }
  } catch {}
}

async function loadFormalPersonaUI() {
  try {
    const res = await fetch(`${API_BASE}/api/profile-analysis/persona`);
    const data = await res.json();
    if (!data.success || !data.persona) return;

    const p = data.persona;
    const nameInput = document.getElementById('persona-form-name');
    if (nameInput) nameInput.value = p.name || 'Steam玩家';

    const toneSelect = document.getElementById('persona-form-tone');
    if (toneSelect) toneSelect.value = p.tone || 'friendly';

    const traitsInput = document.getElementById('persona-form-traits');
    if (traitsInput) traitsInput.value = (p.traits || []).join(', ');

    const gamesInput = document.getElementById('persona-form-games');
    if (gamesInput) gamesInput.value = (p.favoriteGames || []).join(', ');

    const topicsInput = document.getElementById('persona-form-topics');
    if (topicsInput) topicsInput.value = (p.recommendedTopics || []).join(', ');

    const styleInput = document.getElementById('persona-form-style');
    if (styleInput) styleInput.value = (p.communicationStyle || []).join(', ');
  } catch {}
}

async function loadProfileRawSnapshot() {
  const container = document.getElementById('profile-raw-json');
  if (!container) return;
  try {
    container.textContent = '载入中...';
    const res = await fetch(`${API_BASE}/api/profile-analysis/snapshot`);
    const data = await res.json();
    if (data.success && data.snapshot) {
      container.textContent = JSON.stringify(data.snapshot, null, 2);
    } else {
      container.textContent = '暂无原始快照，请先点击【同步 Steam 资料】。';
    }
  } catch (err) {
    container.textContent = `载入快照出错: ${err.message}`;
  }
}


