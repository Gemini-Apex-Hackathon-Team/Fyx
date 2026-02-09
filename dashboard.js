// FYX Dashboard JavaScript

let dashSessionActive = false;
let dashSessionStartTime = null;
let dashSessionDuration = 25 * 60; // seconds
let dashTimerInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  await loadDashboardData();
  await restoreSessionState();
  setupSessionControls();

  document.getElementById('refresh-insights').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-insights');
    btn.textContent = 'Analyzing...';
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'ANALYZE_PATTERNS' });
      await loadDashboardData();
    } catch (e) {
      console.error('Analysis failed:', e);
    }
    btn.textContent = 'Refresh Insights';
    btn.disabled = false;
  });
});

// Restore session from background
async function restoreSessionState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' });
    if (state && state.active) {
      showActiveSession(state.startTime, state.goal, state.duration);
    }
    // Always load reasoning log (shows history even when no session active)
    if (state && state.geminiReasoningLog && state.geminiReasoningLog.length > 0) {
      renderReasoningLog(state.geminiReasoningLog);
    }
  } catch {
    // Background not ready — try loading from storage
    try {
      const stored = await chrome.storage.local.get(['geminiReasoningLog']);
      if (stored.geminiReasoningLog && stored.geminiReasoningLog.length > 0) {
        renderReasoningLog(stored.geminiReasoningLog);
      }
    } catch {
      // ignore
    }
  }
}

function showActiveSession(startTime, goal, duration) {
  dashSessionActive = true;
  dashSessionStartTime = startTime;
  dashSessionDuration = (duration || 25 * 60 * 1000) / 1000;

  document.getElementById('session-idle').style.display = 'none';
  document.getElementById('session-active').style.display = 'block';

  const badge = document.getElementById('live-badge');
  badge.className = 'live-badge';
  document.getElementById('live-badge-text').textContent = 'Active';

  if (goal) {
    document.getElementById('dash-goal-display').textContent = goal;
  }

  updateDashTimer();
  dashTimerInterval = setInterval(updateDashTimer, 1000);
}

function showIdleSession() {
  dashSessionActive = false;
  dashSessionStartTime = null;

  if (dashTimerInterval) {
    clearInterval(dashTimerInterval);
    dashTimerInterval = null;
  }

  document.getElementById('session-idle').style.display = 'block';
  document.getElementById('session-active').style.display = 'none';

  const badge = document.getElementById('live-badge');
  badge.className = 'live-badge inactive';
  document.getElementById('live-badge-text').textContent = 'No Session';
}

function updateDashTimer() {
  if (!dashSessionStartTime) return;

  const elapsed = Math.floor((Date.now() - dashSessionStartTime) / 1000);
  const remaining = Math.max(0, dashSessionDuration - elapsed);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  document.getElementById('dash-timer').textContent =
    `${minutes}:${seconds.toString().padStart(2, '0')}`;

  if (remaining === 0) {
    showIdleSession();
  }
}

function setupSessionControls() {
  document.getElementById('dash-start-btn').addEventListener('click', async () => {
    const goal = document.getElementById('dash-goal').value.trim() || 'General focus';

    await chrome.runtime.sendMessage({
      type: 'START_FOCUS_SESSION',
      duration: 25,
      goal
    });

    showActiveSession(Date.now(), goal, 25 * 60 * 1000);

    // Clear reasoning list
    const list = document.getElementById('dash-reasoning-list');
    list.innerHTML = '';
  });

  document.getElementById('dash-stop-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_SESSION' });
    showIdleSession();
  });
}

// Reasoning feed
function renderReasoningLog(log) {
  const list = document.getElementById('dash-reasoning-list');
  if (!list) return;

  const recent = log.slice(-20).reverse();
  list.innerHTML = '';

  for (const entry of recent) {
    appendReasoningItem(list, entry);
  }
}

function appendReasoningItem(list, entry) {
  const li = document.createElement('li');
  li.className = `reasoning-item type-${entry.type || 'observation'}`;
  const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `<span class="r-time">${time}</span> ${entry.message || entry.reason || ''}`;
  list.prepend(li);

  while (list.children.length > 20) {
    list.removeChild(list.lastChild);
  }
}

// Listen for live messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'GEMINI_REASONING') {
    const list = document.getElementById('dash-reasoning-list');
    if (list) appendReasoningItem(list, message.entry);
  }

  if (message.type === 'SESSION_STARTED') {
    if (!dashSessionActive) {
      showActiveSession(message.startTime || Date.now(), message.goal, message.duration);
    }
  }

  if (message.type === 'SESSION_ENDED') {
    showIdleSession();
  }

  if (message.type === 'ATTENTION_UPDATE') {
    // Could update a live score display if desired
  }
});

// Main data load
async function loadDashboardData() {
  let data;
  try {
    data = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' });
  } catch (e) {
    data = await chrome.storage.local.get([
      'sessionHistory', 'dailyScores', 'dailyStats',
      'geminiInsights', 'userName', 'lastAnalysisTime'
    ]);
  }

  if (!data) return;

  const name = data.userName || '';
  document.getElementById('greeting').textContent = name ? `Hey ${name}!` : 'Hello!';

  renderStats(data);
  renderScoreChart(data.dailyScores || []);
  renderInsights(data.geminiInsights);
  renderSessionHistory(data.sessionHistory || []);
}

function renderStats(data) {
  const stats = data.dailyStats || { sessions: 0, focusTime: 0, breaks: 0 };
  const sessions = data.sessionHistory || [];

  document.getElementById('stat-sessions').textContent = stats.sessions || sessions.length;

  const focusMinutes = Math.round((stats.focusTime || 0) / 60);
  document.getElementById('stat-focus-time').textContent =
    focusMinutes >= 60 ? `${Math.floor(focusMinutes / 60)}h ${focusMinutes % 60}m` : `${focusMinutes}m`;

  document.getElementById('stat-breaks').textContent = stats.breaks || 0;

  const dailyScores = data.dailyScores || [];
  const allScores = dailyScores.flatMap(d => d.scores.map(s => s.score));
  const avg = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : '--';
  document.getElementById('stat-avg-score').textContent = avg;
}

function renderScoreChart(dailyScores) {
  const canvas = document.getElementById('score-chart');
  const ctx = canvas.getContext('2d');

  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * 2;
  canvas.height = rect.height * 2;
  ctx.scale(2, 2);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  let allPoints = [];
  dailyScores.forEach(day => {
    day.scores.forEach(s => {
      allPoints.push({ score: s.score, label: s.time, date: day.date });
    });
  });

  if (allPoints.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No score data yet. Start a focus session!', width / 2, height / 2);
    return;
  }

  if (allPoints.length > 50) allPoints = allPoints.slice(-50);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(100 - i * 25, padding.left - 10, y + 4);
  }

  const greenTop = padding.top;
  const greenBottom = padding.top + chartH * 0.3;
  const grad1 = ctx.createLinearGradient(0, greenTop, 0, greenBottom);
  grad1.addColorStop(0, 'rgba(16, 185, 129, 0.08)');
  grad1.addColorStop(1, 'rgba(16, 185, 129, 0.02)');
  ctx.fillStyle = grad1;
  ctx.fillRect(padding.left, greenTop, chartW, greenBottom - greenTop);

  const redTop = padding.top + chartH * 0.6;
  const redBottom = padding.top + chartH;
  const grad2 = ctx.createLinearGradient(0, redTop, 0, redBottom);
  grad2.addColorStop(0, 'rgba(239, 68, 68, 0.02)');
  grad2.addColorStop(1, 'rgba(239, 68, 68, 0.08)');
  ctx.fillStyle = grad2;
  ctx.fillRect(padding.left, redTop, chartW, redBottom - redTop);

  ctx.beginPath();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  allPoints.forEach((point, i) => {
    const x = padding.left + (i / (allPoints.length - 1 || 1)) * chartW;
    const y = padding.top + (1 - point.score / 100) * chartH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  const lineGrad = ctx.createLinearGradient(padding.left, 0, width - padding.right, 0);
  lineGrad.addColorStop(0, '#6366f1');
  lineGrad.addColorStop(0.5, '#8b5cf6');
  lineGrad.addColorStop(1, '#a78bfa');
  ctx.strokeStyle = lineGrad;
  ctx.stroke();

  ctx.lineTo(padding.left + chartW, padding.top + chartH);
  ctx.lineTo(padding.left, padding.top + chartH);
  ctx.closePath();

  const fillGrad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
  fillGrad.addColorStop(0, 'rgba(99, 102, 241, 0.15)');
  fillGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  const dotsToShow = Math.min(allPoints.length, 20);
  const startDot = allPoints.length - dotsToShow;
  for (let i = startDot; i < allPoints.length; i++) {
    const x = padding.left + (i / (allPoints.length - 1 || 1)) * chartW;
    const y = padding.top + (1 - allPoints[i].score / 100) * chartH;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    const color = allPoints[i].score >= 70 ? '#10b981' : allPoints[i].score >= 40 ? '#f59e0b' : '#ef4444';
    ctx.fillStyle = color;
    ctx.fill();
  }

  const uniqueDates = [...new Set(allPoints.map(p => p.date))];
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  uniqueDates.forEach((date, i) => {
    const x = padding.left + (i / (uniqueDates.length - 1 || 1)) * chartW;
    const shortDate = new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    ctx.fillText(shortDate, x, height - 10);
  });
}

function renderInsights(insights) {
  const list = document.getElementById('insights-list');
  const suggestion = document.getElementById('suggestion-box');

  if (!insights || !insights.insights || insights.insights.length === 0) return;

  const icons = ['*', '#', '>', '!', '?'];
  list.innerHTML = insights.insights.map((text, i) =>
    `<li class="insight-item">
      <span class="insight-icon">${icons[i % icons.length]}</span>
      <span>${text}</span>
    </li>`
  ).join('');

  if (insights.bestFocusTime) {
    document.getElementById('pat-time').textContent = capitalize(insights.bestFocusTime);
  }
  if (insights.optimalDuration) {
    document.getElementById('pat-duration').textContent = insights.optimalDuration;
  }
  if (insights.trend) {
    const trendArrow = insights.trend === 'improving' ? '^' : insights.trend === 'declining' ? 'v' : '->';
    document.getElementById('pat-trend').textContent = trendArrow + ' ' + capitalize(insights.trend);
  }

  if (insights.suggestion) {
    suggestion.style.display = 'block';
    suggestion.innerHTML = `<strong>Suggestion:</strong> ${insights.suggestion}`;
  }
}

function renderSessionHistory(sessions) {
  const list = document.getElementById('session-list');
  if (sessions.length === 0) return;

  const recent = sessions.slice(-10).reverse();

  list.innerHTML = recent.map(s => {
    const date = new Date(s.date);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const rating = s.focusRating || 5;
    const ratingClass = rating >= 7 ? 'high' : rating >= 4 ? 'mid' : 'low';

    return `
      <li class="session-item">
        <div class="session-rating ${ratingClass}">${rating}</div>
        <div class="session-info">
          <div class="session-goal">${s.goal || 'Focus Session'}</div>
          <div class="session-meta">${dateStr} at ${timeStr} - ${s.duration || 0}min</div>
          ${s.summary ? `<div class="session-summary">${s.summary}</div>` : ''}
        </div>
      </li>
    `;
  }).join('');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
