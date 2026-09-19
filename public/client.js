document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const viewInput = document.getElementById('view-input');
  const viewQueue = document.getElementById('view-queue');
  const viewDashboard = document.getElementById('view-dashboard');
  const viewVictory = document.getElementById('view-victory');

  const clonerForm = document.getElementById('cloner-form');
  const tokenInput = document.getElementById('token-input');
  const sourceIdInput = document.getElementById('source-id-input');
  const targetIdInput = document.getElementById('target-id-input');
  const channelsModeSelect = document.getElementById('channels-mode');
  const rolesModeSelect = document.getElementById('roles-mode');
  const emojisModeSelect = document.getElementById('emojis-mode');
  const copyServerInfoCheck = document.getElementById('copy-server-info');
  const toggleTokenBtn = document.getElementById('toggle-token-btn');
  const startBtn = document.getElementById('start-btn');
  const errorBox = document.getElementById('error-box');

  const slotsText = document.getElementById('slots-text');
  const forceResetBtn = document.getElementById('force-reset-btn');
  const queuePositionText = document.getElementById('queue-position-text');
  const queueBadgeText = document.getElementById('queue-badge-text');
  const leaveQueueBtn = document.getElementById('leave-queue-btn');

  const liveTargetName = document.getElementById('live-target-name');
  const liveStepTag = document.getElementById('live-step-tag');
  const liveStatusText = document.getElementById('live-status-text');
  const sessionTimer = document.getElementById('session-timer');
  const abortBtn = document.getElementById('abort-btn');

  const progressFill = document.getElementById('progress-fill');
  const progressStepText = document.getElementById('progress-step-text');
  const progressPercentText = document.getElementById('progress-percent-text');

  const statRoles = document.getElementById('stat-roles');
  const statChannels = document.getElementById('stat-channels');
  const statEmojis = document.getElementById('stat-emojis');
  const statRetries = document.getElementById('stat-retries');
  const activeBannerMsg = document.getElementById('active-banner-msg');

  const terminalLogs = document.getElementById('terminal-logs');
  const logCountText = document.getElementById('log-count');
  const clearLogsBtn = document.getElementById('clear-logs-btn');

  const finalRoles = document.getElementById('final-roles');
  const finalChannels = document.getElementById('final-channels');
  const finalEmojis = document.getElementById('final-emojis');
  const finalRetries = document.getElementById('final-retries');
  const restartBtn = document.getElementById('restart-btn');

  // State
  let activeJobId = null;
  let eventSource = null;
  let logEventCount = 0;
  let timerInterval = null;
  let timerSeconds = 0;

  // ── Cursor Glow Effect ────────────────────────────────────────────────────────
  const cursorGlow = document.getElementById('cursor-glow');
  window.addEventListener('pointermove', (e) => {
    if (cursorGlow) {
      cursorGlow.style.left = `${e.clientX}px`;
      cursorGlow.style.top = `${e.clientY}px`;
    }
  });

  // ── Password Visibility Toggle ───────────────────────────────────────────────
  toggleTokenBtn.addEventListener('click', () => {
    if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
      toggleTokenBtn.textContent = '🔒';
    } else {
      tokenInput.type = 'password';
      toggleTokenBtn.textContent = '👁';
    }
  });

  // ── Global Slots Telemetry Polling ──────────────────────────────────────────
  async function updatePoolStats() {
    try {
      const res = await fetch('/api/pool-stats');
      const data = await res.json();
      if (data.ok) {
        if (slotsText) {
          slotsText.textContent = `SLOTS: ${data.activeCount}/${data.maxConcurrent} OCCUPIED`;
        }
        if (forceResetBtn) {
          forceResetBtn.style.display = data.activeCount > 0 ? 'inline-block' : 'none';
        }
      }
    } catch (e) {}
  }
  updatePoolStats();
  setInterval(updatePoolStats, 4000);

  // ── Force Reset Slots Handler ───────────────────────────────────────────────
  forceResetBtn?.addEventListener('click', async () => {
    if (!confirm('Force reset all slots and purge engine? This will free any stuck slots.')) return;
    try {
      const res = await fetch('/api/force-reset', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        localStorage.removeItem('a4ku_cloner_active_job');
        alert('Engine reset! All slots are now IDLE.');
        resetToStart();
        updatePoolStats();
      }
    } catch (e) {
      alert('Error resetting engine: ' + e.message);
    }
  });

  // ── View Transitions ─────────────────────────────────────────────────────────
  function showView(targetView) {
    [viewInput, viewQueue, viewDashboard, viewVictory].forEach(v => {
      if (v) v.style.display = 'none';
    });
    if (targetView) targetView.style.display = 'flex';
  }

  // ── Error Banner ─────────────────────────────────────────────────────────────
  function showError(msg) {
    if (errorBox) {
      errorBox.textContent = `[ERROR] ${msg}`;
      errorBox.style.display = 'block';
    }
  }

  function clearError() {
    if (errorBox) {
      errorBox.textContent = '';
      errorBox.style.display = 'none';
    }
  }

  // ── Web Audio Synthesizer Chimes ─────────────────────────────────────────────
  function playAudio(type = 'success') {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();

      if (type === 'success') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880.00, ctx.currentTime + 0.15); // A5
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      } else if (type === 'error') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch (e) {}
  }

  // ── Session Timer ────────────────────────────────────────────────────────────
  function startTimer(initialSeconds = 0) {
    clearInterval(timerInterval);
    timerSeconds = initialSeconds;
    const updateDisplay = () => {
      const mins = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
      const secs = String(timerSeconds % 60).padStart(2, '0');
      if (sessionTimer) sessionTimer.textContent = `${mins}:${secs}`;
    };
    updateDisplay();
    timerInterval = setInterval(() => {
      timerSeconds++;
      updateDisplay();
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  // ── Terminal Log Appender ────────────────────────────────────────────────────
  function appendLog(logEvent) {
    if (!terminalLogs) return;

    logEventCount++;
    if (logCountText) logCountText.textContent = `${logEventCount} events`;

    const row = document.createElement('div');
    row.className = `log-entry log-${logEvent.type || 'info'}`;
    
    const timePrefix = logEvent.timestamp ? `[${logEvent.timestamp}] ` : '';
    row.textContent = `${timePrefix}${logEvent.message}`;

    terminalLogs.appendChild(row);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;

    // Update active banner with rate-limit status if applicable
    if (activeBannerMsg) {
      if (logEvent.isRateLimit) {
        activeBannerMsg.innerHTML = `<span style="color: #ffcc00; font-weight: 700;">⏳ DISCORD RATE LIMIT IN EFFECT:</span> Cooling down for ${logEvent.cooldownSec || 15}s (Automatic Safe Backoff - please leave tab open!)`;
      } else {
        activeBannerMsg.textContent = logEvent.message;
      }
    }
  }

  clearLogsBtn?.addEventListener('click', () => {
    if (terminalLogs) terminalLogs.innerHTML = '';
    logEventCount = 0;
    if (logCountText) logCountText.textContent = '0 events';
  });

  // ── Form Submission ──────────────────────────────────────────────────────────
  clonerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const token = tokenInput.value.trim();
    const sourceGuildId = sourceIdInput.value.trim();
    const targetGuildId = targetIdInput.value.trim();

    if (!token) return showError('Discord User Token is required.');
    if (!targetGuildId) return showError('Target Server ID is required.');

    const channelsMode = channelsModeSelect.value;
    const rolesMode = rolesModeSelect.value;
    const emojisMode = emojisModeSelect.value;
    const copyServerInfo = copyServerInfoCheck.checked;

    const requiresSource = (
      channelsMode !== 'delete_only' ||
      rolesMode !== 'delete_only' ||
      emojisMode !== 'delete_only' ||
      copyServerInfo
    );

    if (requiresSource && !sourceGuildId) {
      return showError('Source Server ID is required for cloning actions.');
    }

    if (sourceGuildId && sourceGuildId === targetGuildId) {
      return showError('Source Server ID and Target Server ID cannot be identical.');
    }

    startBtn.disabled = true;
    startBtn.innerHTML = '<span>INITIALIZING TASK...</span>';

    try {
      const res = await fetch('/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          sourceGuildId: sourceGuildId || null,
          targetGuildId,
          channelsMode,
          rolesMode,
          emojisMode,
          copyServerInfo
        })
      });

      const data = await res.json();
      if (!data.ok) {
        showError(data.error || 'Failed to initialize cloning task.');
        startBtn.disabled = false;
        startBtn.innerHTML = '<span>INITIALIZE SERVER CLONE</span><span>→</span>';
        return;
      }

      activeJobId = data.jobId;
      localStorage.setItem('a4ku_cloner_active_job', activeJobId);

      if (data.status === 'QUEUED') {
        // Show Queue View
        showView(viewQueue);
        if (queuePositionText) queuePositionText.textContent = `#${data.queuePosition} IN LINE`;
        if (queueBadgeText) queueBadgeText.textContent = `SYSTEM BUSY // ${data.activeSlots} SLOTS OCCUPIED`;
        connectStream(activeJobId);
      } else {
        // Show Dashboard View directly
        showView(viewDashboard);
        startTimer(0);
        connectStream(activeJobId);
      }

    } catch (err) {
      showError('Network error connecting to cloner engine: ' + err.message);
      startBtn.disabled = false;
      startBtn.innerHTML = '<span>INITIALIZE SERVER CLONE</span><span>→</span>';
    }
  });

  // ── SSE Stream Connection ────────────────────────────────────────────────────
  function connectStream(jobId) {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource(`/api/stream/${jobId}`);

    eventSource.addEventListener('log', (e) => {
      try {
        const logData = JSON.parse(e.data);
        appendLog(logData);

        // Update progress & metrics
        if (logData.percent !== undefined) {
          updateProgress(logData.percent, logData.step);
        }
        if (logData.stats) {
          updateStats(logData.stats);
        }
      } catch (err) {}
    });

    eventSource.addEventListener('queue_update', (e) => {
      try {
        const qData = JSON.parse(e.data);
        if (queuePositionText) queuePositionText.textContent = `#${qData.position} IN LINE`;
        if (queueBadgeText) queueBadgeText.textContent = `SYSTEM BUSY // ${qData.activeSlots} SLOTS OCCUPIED`;
      } catch (err) {}
    });

    eventSource.addEventListener('status', (e) => {
      try {
        const sData = JSON.parse(e.data);
        if (sData.status === 'RUNNING') {
          // If was in queue, transition to active dashboard
          if (viewQueue.style.display !== 'none') {
            showView(viewDashboard);
            startTimer();
          }
          if (liveStatusText) liveStatusText.textContent = 'CLONING ACTIVE';
          if (liveStepTag) liveStepTag.textContent = `CURRENT STEP: ${sData.step || 'RUNNING'}`;
        }
      } catch (err) {}
    });

    eventSource.addEventListener('finish', (e) => {
      try {
        const finishData = JSON.parse(e.data);
        stopTimer();
        eventSource.close();

        if (finishData.status === 'COMPLETED') {
          playAudio('success');
          // Show victory screen
          if (finalRoles) finalRoles.textContent = finishData.stats?.rolesCreated || 0;
          if (finalChannels) finalChannels.textContent = (finishData.stats?.categoriesCreated || 0) + (finishData.stats?.channelsCreated || 0);
          if (finalEmojis) finalEmojis.textContent = finishData.stats?.emojisCreated || 0;
          if (finalRetries) finalRetries.textContent = finishData.stats?.retries || 0;
          showView(viewVictory);
        } else if (finishData.status === 'ABORTED') {
          playAudio('error');
          alert('Cloning task was aborted.');
          resetToStart();
        } else if (finishData.status === 'FAILED') {
          playAudio('error');
          alert('Task failed: ' + (finishData.error || 'Unknown error'));
          resetToStart();
        }
      } catch (err) {}
    });

    eventSource.onerror = () => {
      // Automatic browser reconnect handled by EventSource
    };
  }

  function updateProgress(percent, step) {
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressPercentText) progressPercentText.textContent = `${percent}%`;
    if (progressStepText) progressStepText.textContent = `Step: ${step || 'Processing'}`;
    if (liveStepTag) liveStepTag.textContent = `CURRENT STEP: ${step || 'WORKING'}`;
  }

  function updateStats(stats) {
    if (statRoles) statRoles.textContent = stats.rolesCreated || 0;
    if (statChannels) statChannels.textContent = (stats.categoriesCreated || 0) + (stats.channelsCreated || 0);
    if (statEmojis) statEmojis.textContent = stats.emojisCreated || 0;
    if (statRetries) statRetries.textContent = stats.retries || 0;
  }

  // ── Abort & Leave Queue ──────────────────────────────────────────────────────
  async function abortActiveJob() {
    if (!activeJobId) return;
    if (!confirm('Are you sure you want to cancel this cloning task?')) return;
    try {
      await fetch(`/api/abort/${activeJobId}`, { method: 'POST' });
    } catch (e) {}
    resetToStart();
  }

  abortBtn?.addEventListener('click', abortActiveJob);
  leaveQueueBtn?.addEventListener('click', abortActiveJob);

  function resetToStart() {
    if (eventSource) eventSource.close();
    stopTimer();
    activeJobId = null;
    localStorage.removeItem('a4ku_cloner_active_job');
    startBtn.disabled = false;
    startBtn.innerHTML = '<span>INITIALIZE SERVER CLONE</span><span>→</span>';
    showView(viewInput);
  }

  restartBtn?.addEventListener('click', resetToStart);

  // ── Auto-Resume on Page Reload / Reconnect ──────────────────────────────────
  async function checkExistingActiveJob() {
    const savedJobId = localStorage.getItem('a4ku_cloner_active_job');
    if (savedJobId) {
      try {
        const res = await fetch(`/api/status/${savedJobId}`);
        const data = await res.json();
        if (data.ok && (data.status === 'RUNNING' || data.status === 'QUEUED')) {
          activeJobId = savedJobId;
          if (data.status === 'QUEUED') {
            showView(viewQueue);
            if (queuePositionText) queuePositionText.textContent = `#${data.queuePosition || 1} IN LINE`;
            if (queueBadgeText) queueBadgeText.textContent = `SYSTEM BUSY // ${data.activeSlots || '1/10'} SLOTS OCCUPIED`;
          } else {
            showView(viewDashboard);
            startTimer(data.durationSec || 0);
          }
          connectStream(activeJobId);
          return;
        } else {
          localStorage.removeItem('a4ku_cloner_active_job');
        }
      } catch (e) {}
    }

    // Fallback: check if server has an active job for this client session
    try {
      const res = await fetch('/api/active-job');
      const data = await res.json();
      if (data.ok && data.active && data.active.length > 0) {
        const latestJob = data.active[0];
        activeJobId = latestJob.jobId;
        localStorage.setItem('a4ku_cloner_active_job', activeJobId);
        showView(viewDashboard);
        startTimer(latestJob.durationSec || 0);
        connectStream(activeJobId);
      }
    } catch (e) {}
  }

  // Auto-restore any active session on load
  checkExistingActiveJob();
});
