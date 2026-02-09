// FYX Focus App — Integrated with background service worker
// Camera analysis runs through offscreen → background pipeline
// Session state shared with popup and dashboard

const ui = {
  goal: document.getElementById('goal'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  focusScore: document.getElementById('focus-score'),
  faceState: document.getElementById('face-state'),
  sessionTime: document.getElementById('session-time'),
  video: document.getElementById('camera'),
  overlay: document.getElementById('overlay'),
  agentStatus: document.getElementById('agent-status'),
  agentLog: document.getElementById('agent-log')
};

const state = {
  running: false,
  stream: null,
  startTs: 0,
  focusScore: 100,
  tickTimer: null,
  landmarkPollTimer: null,
  goal: ''
};

function init() {
  const savedGoal = localStorage.getItem('fyx_goal') || '';
  ui.goal.value = savedGoal;

  ui.startBtn.addEventListener('click', startSession);
  ui.stopBtn.addEventListener('click', stopSession);

  // Restore session if one is already active in background
  restoreSession();

  // Listen for live messages from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'GEMINI_REASONING') {
      addLog(message.entry.message || message.entry.reason || '');
    }

    if (message.type === 'ATTENTION_UPDATE') {
      state.focusScore = message.score;
      ui.focusScore.textContent = String(Math.round(message.score));
    }

    if (message.type === 'SESSION_ENDED') {
      handleSessionEnded();
    }

    if (message.type === 'SESSION_STARTED') {
      if (!state.running) {
        state.running = true;
        state.startTs = message.startTime || Date.now();
        state.goal = message.goal || '';
        ui.startBtn.disabled = true;
        ui.stopBtn.disabled = false;
        ui.faceState.textContent = 'Tracking';
        updateClock();
        state.tickTimer = setInterval(updateClock, 1000);
        setAgentStatus('Session started from another page.', 'normal');
      }
    }
  });
}

async function restoreSession() {
  try {
    const sessionState = await chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' });
    if (sessionState && sessionState.active) {
      state.running = true;
      state.startTs = sessionState.startTime;
      state.focusScore = sessionState.attentionScore || 100;
      state.goal = sessionState.goal || '';

      ui.goal.value = state.goal;
      ui.startBtn.disabled = true;
      ui.stopBtn.disabled = false;
      ui.focusScore.textContent = String(Math.round(state.focusScore));
      ui.faceState.textContent = 'Tracking';

      updateClock();
      state.tickTimer = setInterval(updateClock, 1000);

      // Start polling landmark data for face state display
      startLandmarkPolling();

      // Render existing reasoning log
      const log = sessionState.geminiReasoningLog || [];
      for (const entry of log.slice(-8)) {
        addLog(entry.message || entry.reason || '');
      }

      setAgentStatus('Session restored. Monitoring active.', 'normal');

      // Start local video preview
      await startVideoPreview();
    }
  } catch {
    // Background not ready
  }
}

async function startVideoPreview() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 } },
      audio: false
    });
    ui.video.srcObject = state.stream;
    await ui.video.play();
  } catch {
    // Camera may already be in use by offscreen document, that's OK
    ui.faceState.textContent = 'Camera in use by background';
    ui.faceState.className = 'metric-value small status-warn';
  }
}

function stopVideoPreview() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  ui.video.srcObject = null;
  const ctx = ui.overlay.getContext('2d');
  ctx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
}

async function startSession() {
  const goal = ui.goal.value.trim() || 'Stay focused on the active task';

  state.goal = goal;
  localStorage.setItem('fyx_goal', goal);

  setAgentStatus('Starting session...', 'normal');

  try {
    // Tell background to start the focus session
    await chrome.runtime.sendMessage({
      type: 'START_FOCUS_SESSION',
      duration: 25,
      goal
    });

    state.running = true;
    state.startTs = Date.now();
    state.focusScore = 100;

    ui.startBtn.disabled = true;
    ui.stopBtn.disabled = false;
    ui.focusScore.textContent = '100';
    ui.faceState.textContent = 'Tracking';

    state.tickTimer = setInterval(updateClock, 1000);
    updateClock();

    // Start polling landmark data
    startLandmarkPolling();

    // Start local video preview
    await startVideoPreview();

    setAgentStatus('Session active. Camera analysis running via background.', 'normal');
    addLog('Session started. Background monitoring active.');
  } catch (error) {
    setAgentStatus('Failed to start session: ' + error.message, 'danger');
  }
}

async function stopSession() {
  if (!state.running) return;

  try {
    await chrome.runtime.sendMessage({ type: 'STOP_SESSION' });
  } catch {
    // Background may not respond
  }

  handleSessionEnded();
}

function handleSessionEnded() {
  state.running = false;
  clearInterval(state.tickTimer);
  stopLandmarkPolling();
  stopVideoPreview();

  ui.startBtn.disabled = false;
  ui.stopBtn.disabled = true;
  ui.faceState.textContent = 'Idle';

  addLog('Session ended.');
  setAgentStatus('Session stopped.', 'normal');
}

function updateClock() {
  if (!state.startTs) return;
  const elapsed = Math.floor((Date.now() - state.startTs) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  ui.sessionTime.textContent = `${mm}:${ss}`;
}

// Poll background for latest landmark/face data to update UI
function startLandmarkPolling() {
  stopLandmarkPolling();
  state.landmarkPollTimer = setInterval(pollLandmarkData, 1500);
  pollLandmarkData();
}

function stopLandmarkPolling() {
  if (state.landmarkPollTimer) {
    clearInterval(state.landmarkPollTimer);
    state.landmarkPollTimer = null;
  }
}

async function pollLandmarkData() {
  if (!state.running) return;

  try {
    const data = await chrome.runtime.sendMessage({ type: 'GET_LANDMARK_DATA' });
    if (!data || !data.success) return;

    const lm = data.landmarks;
    const camState = data.cameraUserState || 'unknown';

    if (!lm || !lm.facePresent) {
      ui.faceState.textContent = 'Face not found';
      ui.faceState.className = 'metric-value small status-danger';
      return;
    }

    if (lm.eyesClosed) {
      ui.faceState.textContent = 'Eyes closing';
      ui.faceState.className = 'metric-value small status-danger';
    } else if (lm.lookingAway) {
      const yaw = lm.headPose ? lm.headPose.yaw : 0;
      ui.faceState.textContent = `Looking away (yaw: ${Math.round(yaw)})`;
      ui.faceState.className = 'metric-value small status-warn';
    } else if (camState === 'bored') {
      ui.faceState.textContent = 'Drowsy';
      ui.faceState.className = 'metric-value small status-warn';
    } else {
      const ear = lm.avgEAR ? lm.avgEAR.toFixed(2) : '--';
      ui.faceState.textContent = `Focused (EAR: ${ear})`;
      ui.faceState.className = 'metric-value small';
    }

    // Update focus score from background
    const scoreResp = await chrome.runtime.sendMessage({ type: 'GET_ATTENTION_SCORE' });
    if (scoreResp && typeof scoreResp.score === 'number') {
      state.focusScore = scoreResp.score;
      ui.focusScore.textContent = String(Math.round(scoreResp.score));
    }
  } catch {
    // Background not ready
  }
}

function setAgentStatus(text, level) {
  ui.agentStatus.textContent = text;
  ui.agentStatus.className = '';
  if (level === 'warn') ui.agentStatus.classList.add('status-warn');
  if (level === 'danger') ui.agentStatus.classList.add('status-danger');
}

function addLog(text) {
  const item = document.createElement('li');
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.textContent = `${ts} - ${text}`;
  ui.agentLog.prepend(item);
  if (ui.agentLog.children.length > 12) {
    ui.agentLog.removeChild(ui.agentLog.lastChild);
  }
}

init();
