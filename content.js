// FYX Content Script
// Tracks user engagement on pages and shows interventions

console.log('[FYX Content] 🚀 FYX Content Script loading on:', window.location.href);

// Guard against double-injection (manifest + scripting API)
if (typeof window.__fyxContentLoaded !== 'undefined') {
  console.log('[FYX Content] ⏭️ Already loaded, skipping re-execution');
  // Already loaded — skip re-execution
} else {
window.__fyxContentLoaded = true;
console.log('[FYX Content] ✅ First load - initializing...');
console.log('[FYX Content] 📰 Page Title:', document.title);

let engagementData = {
  timeVisible: 0,
  scrollCount: 0,
  mouseMovements: 0,
  isVisible: true,
  startTime: Date.now(),
  lastActivityTime: Date.now(),
  scrollPosition: 0,
  pageContent: ''
};

let visibilityCheckInterval;
let activityCheckInterval;
let signalInterval;
const popupPositionPrefix = 'fyxPopupPos:';
let latestCameraState = {
  faceDetected: true,
  cameraUserState: 'unknown'
};
let recentTabSwitches = 0;
let cameraMetricsBridgeInstalled = false;
let cameraPanelInitialized = false;

// Initialize tracking
function initializeTracking() {
  // Visibility tracking
  document.addEventListener('visibilitychange', () => {
    engagementData.isVisible = !document.hidden;
    if (document.hidden) recentTabSwitches += 1;

    if (document.hidden) {
      engagementData.timeVisible = Date.now() - engagementData.startTime;
    } else {
      engagementData.startTime = Date.now();
    }
  });

  // Scroll tracking
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    engagementData.scrollCount++;
    engagementData.lastActivityTime = Date.now();
    engagementData.scrollPosition = window.scrollY;

    clearTimeout(scrollTimeout);
  }, { passive: true });

  // Mouse movement tracking
  let mouseMoveTimeout;
  document.addEventListener('mousemove', () => {
    clearTimeout(mouseMoveTimeout);
    mouseMoveTimeout = setTimeout(() => {
      engagementData.mouseMovements++;
      engagementData.lastActivityTime = Date.now();
    }, 100);
  }, { passive: true });

  // Keyboard activity tracking
  document.addEventListener('keydown', () => {
    engagementData.keyPresses = (engagementData.keyPresses || 0) + 1;
    engagementData.lastActivityTime = Date.now();
  }, { passive: true });

  // Periodic visibility check
  visibilityCheckInterval = setInterval(() => {
    if (!document.hidden) {
      engagementData.timeVisible += 1;
    }
  }, 1000);

  // Activity check (detect if user went idle)
  activityCheckInterval = setInterval(() => {
    const timeSinceActivity = Date.now() - engagementData.lastActivityTime;
    if (timeSinceActivity > 60000) { // 1 minute idle
      // User might be distracted
      engagementData.isVisible = false;
    }
  }, 30000);

  // Inactivity quiz trigger — after 10 seconds of no activity, request a quiz
  let inactivityQuizFired = false;
  setInterval(() => {
    try {
      if (!chrome.runtime?.id) return;
      const idleMs = Date.now() - engagementData.lastActivityTime;
      if (idleMs >= 10000 && !inactivityQuizFired && !document.hidden) {
        inactivityQuizFired = true;
        // Tell background to generate and push a quiz to this tab
        chrome.runtime.sendMessage({
          type: 'REQUEST_INACTIVITY_QUIZ'
        }).catch(() => {});
      }
      // Reset flag once user becomes active again
      if (idleMs < 5000) {
        inactivityQuizFired = false;
      }
    } catch { /* context invalidated */ }
  }, 2000);

  // Cheap local signals to background agent runtime
  let signalCount = 0;
  signalInterval = setInterval(() => {
    try {
      if (!chrome.runtime?.id) return; // extension context invalidated
      const idleSeconds = Math.floor((Date.now() - engagementData.lastActivityTime) / 1000);
      const interactionBursts = (engagementData.mouseMovements || 0) + (engagementData.keyPresses || 0);
      
      signalCount++;
      // Log every 5th signal to avoid console spam
      if (signalCount % 5 === 1) {
        console.log('[FYX Content] 📡 Sending signal to background:', {
          idleSeconds,
          visible: !document.hidden,
          faceDetected: latestCameraState.faceDetected,
          tabSwitches: recentTabSwitches
        });
      }
      
      chrome.runtime.sendMessage({
        type: 'SIGNAL',
        payload: {
          idleSeconds,
          visible: !document.hidden,
          scrollCount: engagementData.scrollCount || 0,
          interactionBursts,
          faceDetected: latestCameraState.faceDetected,
          cameraUserState: latestCameraState.cameraUserState,
          tabSwitchesLastMinute: recentTabSwitches
        }
      }).catch(() => {});
    } catch { return; }

    // decay counters so bursts represent recent activity
    engagementData.mouseMovements = 0;
    engagementData.keyPresses = 0;
    if (recentTabSwitches > 0) recentTabSwitches -= 1;
  }, 2000);

  if (!cameraMetricsBridgeInstalled) {
    cameraMetricsBridgeInstalled = true;
    // Bridge page-level camera metrics to background runtime when available.
    window.addEventListener('sleepinessMetrics', (event) => {
      const metrics = event.detail || {};
      latestCameraState.faceDetected = !!metrics.faceDetected;
      latestCameraState.cameraUserState = metrics.userState || 'unknown';
      try {
        if (!chrome.runtime?.id) return;
        chrome.runtime.sendMessage({
          type: 'CAMERA_METRICS',
          metrics
        }).catch(() => {});
      } catch { /* context invalidated */ }

      updateCameraPanelStatus(metrics);
    });
  }
}

// Get page content for quiz generation and Gemini context
function getPageContent() {
  console.log('[FYX Content] 📄 Grabbing page content for Gemini analysis...');
  
  const article = document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('.content') ||
    document.querySelector('[role="main"]') ||
    document.body;

  const text = article.innerText || article.textContent || '';
  console.log(`[FYX Content] 📰 Page Title: "${document.title}"`);
  console.log(`[FYX Content] 📝 Content length: ${text.length} chars (sending first 2000)`);
  console.log(`[FYX Content] 🔍 Content preview: "${text.substring(0, 150)}..."`)

  // Detect content type
  let contentType = 'webpage';
  if (window.location.hostname.includes('youtube.com')) {
    contentType = 'video';
  } else if (document.querySelector('article')) {
    contentType = 'article';
  } else if (document.querySelector('pre, code, .highlight')) {
    contentType = 'documentation';
  }

  // Calculate scroll progress
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const scrollProgress = scrollHeight > 0 ? Math.round((window.scrollY / scrollHeight) * 100) : 0;

  // Get video state if on YouTube
  let videoState = null;
  if (contentType === 'video') {
    const video = document.querySelector('video');
    if (video) {
      videoState = {
        currentTime: Math.round(video.currentTime),
        duration: Math.round(video.duration),
        paused: video.paused
      };
    }
  }

  const result = {
    text: text.substring(0, 2000),
    contentType: contentType,
    scrollPosition: engagementData.scrollPosition,
    scrollProgress: scrollProgress,
    timeOnPage: Math.floor((Date.now() - engagementData.startTime) / 1000),
    videoState: videoState,
    mouseActivity: engagementData.mouseMovements,
    isIdle: (Date.now() - engagementData.lastActivityTime) > 60000
  };
  
  console.log(`[FYX Content] ✅ Content grabbed:`, {
    contentType: result.contentType,
    scrollProgress: result.scrollProgress + '%',
    timeOnPage: result.timeOnPage + 's',
    isIdle: result.isIdle
  });
  
  return result;
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_ENGAGEMENT_DATA') {
    sendResponse({
      ...engagementData,
      keyPresses: engagementData.keyPresses || 0,
      idleSeconds: Math.floor((Date.now() - engagementData.lastActivityTime) / 1000)
    });
    return true;
  }

  if (message.type === 'GET_PAGE_CONTEXT') {
    sendResponse(getPageContent());
    return true;
  }

  if (message.type === 'GET_CONTEXT') {
    const page = getPageContent();
    sendResponse({
      title: document.title,
      url: location.href,
      snippet: page.text || '',
      contentType: page.contentType || 'webpage'
    });
    return true;
  }

  if (message.type === 'GET_PAGE_CONTENT') {
    sendResponse(getPageContent());
    return true;
  }

  if (message.type === 'SHOW_INTERVENTION') {
    showInterventionOverlay(message);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'INTERVENTION') {
    if (message.action === 'SHOW_NUDGE') {
      showInterventionOverlay({
        attentionScore: message.payload?.score || 50,
        suggestion: message.payload?.message || 'Quick focus reset.',
        reason: 'agent'
      });
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'START_QUIZ') {
      const quiz = message.payload?.quiz || {
        question: 'What is the main idea of this page?',
        options: ['Main concept', 'Minor detail', 'Unrelated point'],
        correctIndex: 0,
        explanation: 'Recall of the main concept restores focus.'
      };
      showQuizOverlay(quiz);
      sendResponse({ success: true });
      return true;
    }
  }

  if (message.type === 'SHOW_QUIZ') {
    const quiz = message.quiz && message.quiz.options ? message.quiz : {
      question: 'What is the main idea of this page?',
      options: ['Main concept', 'Minor detail', 'Unrelated point'],
      correctIndex: 0,
      explanation: 'Recall of the main concept restores focus.'
    };
    showQuizOverlay(quiz);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SHOW_BREAK_SCREEN') {
    showBreakScreen(message.duration);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'ATTENTION_UPDATE') {
    updateAttentionIndicator(message.score);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_ENHANCED_CONTENT') {
    sendResponse(getEnhancedPageContent());
    return true;
  }

  if (message.type === 'SHOW_INTELLIGENT_INTERVENTION') {
    showIntelligentIntervention(message);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SHOW_CONTEXTUAL_QUIZ') {
    showContextualQuiz(message);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SHOW_GEMINI_SUGGESTION') {
    showGeminiSuggestion(message);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SHOW_RELEVANCE_WARNING') {
    showRelevanceWarning(message);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'ENABLE_CAMERA') {
    if (message.enabled) {
      initializeCameraTracking();
      showCameraPanel();
    } else {
      stopCameraTracking();
      hideCameraPanel();
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SHOW_FUN_POPUP') {
    showFunPopup(message);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SHOW_BLINK_SCREEN') {
    showBlinkScreen(message);
    sendResponse({ success: true });
    return true;
  }
});

// Show intervention overlay
function showInterventionOverlay(data) {
  // Remove existing overlay
  const existing = document.getElementById('fyx-intervention-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'fyx-intervention-overlay';
  overlay.className = 'fyx-overlay';

  overlay.innerHTML = `
    <div class="fyx-intervention-card">
      <div class="fyx-header fyx-drag-handle">
        <span class="fyx-logo">🧠 FYX</span>
        <div>
          <button class="fyx-close" id="fyx-reset-intervention" title="Reset position">⤾</button>
          <button class="fyx-close" id="fyx-close-intervention">×</button>
        </div>
      </div>
      <div class="fyx-score-bar">
        <div class="fyx-score-fill" style="width: ${data.attentionScore}%"></div>
        <span class="fyx-score-text">Focus: ${data.attentionScore}%</span>
      </div>
      <div class="fyx-message">
        ${data.suggestion}
      </div>
      <div class="fyx-actions">
        <button class="fyx-btn fyx-btn-secondary" id="fyx-generate-quiz">Generate Quiz</button>
        <button class="fyx-btn fyx-btn-primary" id="fyx-take-break">Take a Break</button>
        <button class="fyx-btn fyx-btn-secondary" id="fyx-continue">Keep Going</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  makePopupDraggable(overlay, overlay.querySelector('.fyx-intervention-card'), 'intervention');

  // Add event listeners
  document.getElementById('fyx-close-intervention').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'INTERVENTION_DISMISSED', reason: 'closed' });
    overlay.remove();
  });

  document.getElementById('fyx-reset-intervention').addEventListener('click', async () => {
    await resetPopupPosition('intervention');
    positionPopup(overlay.querySelector('.fyx-intervention-card'), null);
  });

  document.getElementById('fyx-take-break').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REQUEST_BREAK' });
    overlay.remove();
  });

  document.getElementById('fyx-generate-quiz').addEventListener('click', async () => {
    await requestGeneratedQuiz(overlay);
  });

  document.getElementById('fyx-continue').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'INTERVENTION_DISMISSED', reason: 'continue' });
    overlay.remove();
  });

  // Auto-hide after 15 seconds
  setTimeout(() => {
    if (overlay.parentNode) {
      chrome.runtime.sendMessage({ type: 'INTERVENTION_DISMISSED', reason: 'timeout' });
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 300);
    }
  }, 15000);
}

// Show quiz overlay
function showQuizOverlay(quiz) {
  // Guard against undefined/malformed quiz data
  if (!quiz || !Array.isArray(quiz.options) || quiz.options.length === 0) {
    quiz = {
      question: quiz?.question || 'What is the main idea of this page?',
      options: ['Main concept', 'Minor detail', 'Unrelated point'],
      correctIndex: 0,
      explanation: quiz?.explanation || 'Quick recall helps your focus snap back.'
    };
  }

  const existing = document.getElementById('fyx-quiz-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'fyx-quiz-overlay';
  overlay.className = 'fyx-overlay';

  const startTime = Date.now();

  overlay.innerHTML = `
    <div class="fyx-quiz-card">
      <div class="fyx-header fyx-drag-handle">
        <span class="fyx-logo">🧠 FYX Focus Check</span>
        <button class="fyx-close" id="fyx-reset-quiz" title="Reset position">⤾</button>
      </div>
      <div class="fyx-quiz-question">
        ${quiz.question}
      </div>
      <div class="fyx-quiz-options">
        ${quiz.options.map((option, index) => `
          <button class="fyx-quiz-option" data-index="${index}">
            ${option}
          </button>
        `).join('')}
      </div>
      <div class="fyx-quiz-timer">Time's ticking... ⏱️</div>
    </div>
  `;

  document.body.appendChild(overlay);
  makePopupDraggable(overlay, overlay.querySelector('.fyx-quiz-card'), 'quiz');
  document.getElementById('fyx-reset-quiz').addEventListener('click', async () => {
    await resetPopupPosition('quiz');
    positionPopup(overlay.querySelector('.fyx-quiz-card'), null);
  });

  // Handle option selection
  overlay.querySelectorAll('.fyx-quiz-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const selectedIndex = parseInt(e.target.dataset.index);
      const correct = selectedIndex === quiz.correctIndex;
      const timeTaken = Date.now() - startTime;

      // Show result
      showQuizResult(overlay, correct, quiz.explanation);

      // Send result to background
      chrome.runtime.sendMessage({
        type: 'QUIZ_COMPLETED',
        correct: correct,
        timeTaken: timeTaken
      });

      chrome.runtime.sendMessage({
        type: 'RESULT',
        kind: 'quiz',
        correct: correct ? 1 : 0,
        durationMs: timeTaken,
        dismissed: false
      }).catch(() => {});
    });
  });
}

function showQuizResult(overlay, correct, explanation) {
  const card = overlay.querySelector('.fyx-quiz-card');

  card.innerHTML = `
    <div class="fyx-header">
      <span class="fyx-logo">🧠 FYX</span>
    </div>
    <div class="fyx-quiz-result ${correct ? 'correct' : 'incorrect'}">
      <div class="fyx-result-icon">${correct ? '✓' : '✗'}</div>
      <div class="fyx-result-text">
        ${correct ? 'Great job staying focused!' : 'No worries, let\'s refocus'}
      </div>
      <div class="fyx-result-explanation">
        ${explanation}
      </div>
      <button class="fyx-btn fyx-btn-primary" id="fyx-close-quiz">Continue</button>
    </div>
  `;

  document.getElementById('fyx-close-quiz').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'RESULT',
      kind: 'quiz',
      correct: 0,
      durationMs: 0,
      dismissed: true
    }).catch(() => {});
    overlay.remove();
  });

  // Auto-close after 5 seconds
  setTimeout(() => overlay.remove(), 5000);
}

async function requestGeneratedQuiz(existingOverlay = null) {
  try {
    const page = getPageContent();
    const response = await chrome.runtime.sendMessage({
      type: 'GEN_QUIZ',
      content: page.text || '',
      title: document.title || page.contentType || 'Current Page'
    });

    if (response && response.success && response.quiz) {
      if (existingOverlay && existingOverlay.parentNode) existingOverlay.remove();
      showQuizOverlay(response.quiz);
      return;
    }

    const fallback = {
      question: 'What is the main idea of what you are reading right now?',
      options: ['Core concept', 'A side detail', 'An unrelated point'],
      correctIndex: 0,
      explanation: response?.error || 'Quick recall helps your focus snap back.'
    };
    if (existingOverlay && existingOverlay.parentNode) existingOverlay.remove();
    showQuizOverlay(fallback);
  } catch (error) {
    const fallback = {
      question: 'Pause and summarize the page headline in your own words.',
      options: ['Done', 'Not yet', 'Need more context'],
      correctIndex: 0,
      explanation: error.message || 'Unable to fetch quiz from worker.'
    };
    if (existingOverlay && existingOverlay.parentNode) existingOverlay.remove();
    showQuizOverlay(fallback);
  }
}

// Show break screen
function showBreakScreen(duration) {
  const existing = document.getElementById('fyx-break-screen');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'fyx-break-screen';
  overlay.className = 'fyx-overlay fyx-break-overlay';

  const durationMinutes = Math.floor(duration / 60000);
  let timeLeft = durationMinutes * 60;

  overlay.innerHTML = `
    <div class="fyx-break-card">
      <div class="fyx-break-header">
        <h2>🌟 Break Time!</h2>
        <p>Your brain needs a reset</p>
      </div>
      <div class="fyx-break-timer" id="fyx-break-timer">
        ${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, '0')}
      </div>
      <div class="fyx-break-activities">
        <h3>Suggested Activities:</h3>
        <div class="fyx-activity-grid">
          <button class="fyx-activity-btn" data-activity="breathe">
            🫁 Deep Breathing
          </button>
          <button class="fyx-activity-btn" data-activity="stretch">
            🤸 Stretch
          </button>
          <button class="fyx-activity-btn" data-activity="walk">
            🚶 Walk Around
          </button>
          <button class="fyx-activity-btn" data-activity="water">
            💧 Get Water
          </button>
        </div>
      </div>
      <div class="fyx-motivational">
        "Small breaks lead to big breakthroughs"
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Countdown timer
  const timerInterval = setInterval(() => {
    timeLeft--;
    const timerEl = document.getElementById('fyx-break-timer');
    if (timerEl) {
      timerEl.textContent = `${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, '0')}`;
    }

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      showBreakComplete(overlay);
    }
  }, 1000);

  // Activity buttons (could trigger specific break exercises)
  overlay.querySelectorAll('.fyx-activity-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const activity = e.target.dataset.activity;
      // Could show specific instructions for each activity
      console.log('Starting activity:', activity);
    });
  });
}

function showBreakComplete(overlay) {
  const card = overlay.querySelector('.fyx-break-card');

  card.innerHTML = `
    <div class="fyx-break-header">
      <h2>✨ Break Complete!</h2>
      <p>Ready to refocus?</p>
    </div>
    <div class="fyx-break-complete">
      <p>You've recharged your focus. Time to dive back in with renewed energy!</p>
      <button class="fyx-btn fyx-btn-primary fyx-btn-large" id="fyx-resume-work">
        Resume Work
      </button>
    </div>
  `;

  document.getElementById('fyx-resume-work').addEventListener('click', () => {
    overlay.remove();
  });
}

// Persistent attention indicator
function createAttentionIndicator() {
  if (document.getElementById('fyx-attention-indicator')) return;

  const indicator = document.createElement('div');
  indicator.id = 'fyx-attention-indicator';
  indicator.className = 'fyx-attention-indicator';

  indicator.innerHTML = `
    <div class="fyx-indicator-circle">
      <div class="fyx-indicator-fill"></div>
      <span class="fyx-indicator-score">100</span>
    </div>
  `;

  document.body.appendChild(indicator);

  // Make it draggable (optional)
  let isDragging = false;
  let currentX, currentY, initialX, initialY;

  indicator.addEventListener('mousedown', (e) => {
    isDragging = true;
    initialX = e.clientX - indicator.offsetLeft;
    initialY = e.clientY - indicator.offsetTop;
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      indicator.style.left = currentX + 'px';
      indicator.style.top = currentY + 'px';
      indicator.style.right = 'auto';
      indicator.style.bottom = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
}

function updateAttentionIndicator(score) {
  let indicator = document.getElementById('fyx-attention-indicator');
  if (!indicator) {
    createAttentionIndicator();
    indicator = document.getElementById('fyx-attention-indicator');
  }

  const fill = indicator.querySelector('.fyx-indicator-fill');
  const scoreText = indicator.querySelector('.fyx-indicator-score');

  if (fill && scoreText) {
    fill.style.height = score + '%';
    scoreText.textContent = Math.round(score);

    // Color coding
    if (score >= 70) {
      fill.style.background = '#4ade80'; // Green
    } else if (score >= 40) {
      fill.style.background = '#fbbf24'; // Yellow
    } else {
      fill.style.background = '#f87171'; // Red
    }
  }
}

// === FUN POPUP ("Are you bored?") ===
function showFunPopup(data) {
  const existing = document.getElementById('fyx-fun-popup');
  if (existing) existing.remove();

  const name = data.userName || 'there';
  const overlay = document.createElement('div');
  overlay.id = 'fyx-fun-popup';
  overlay.innerHTML = `
    <div class="fyx-fun-popup-card">
      <div class="fyx-fun-emoji fyx-drag-handle">👋</div>
      <h2 class="fyx-fun-title">Hey ${name}, still with us?</h2>
      <p class="fyx-fun-message">${data.message || 'Looks like your focus drifted a bit.'}</p>
      <p class="fyx-fun-topic">You were learning about: <strong>${data.topic || 'this page'}</strong></p>
      <div class="fyx-fun-actions">
        <button class="fyx-fun-btn fyx-fun-btn-focus" id="fyx-im-focused">
          💪 I'm focused!
        </button>
        <button class="fyx-fun-btn fyx-fun-btn-break" id="fyx-take-break-fun">
          ☕ Take a break
        </button>
      </div>
      <div class="fyx-fun-score">Focus: ${data.attentionScore || 0}%</div>
    </div>
  `;

  // Add styles
  const style = document.createElement('style');
  style.id = 'fyx-fun-popup-styles';
  style.textContent = `
    #fyx-fun-popup {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: fyx-fun-fadein 0.3s ease;
    }
    @keyframes fyx-fun-fadein { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fyx-fun-bounce {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(-20px) scale(1.05); }
    }
    @keyframes fyx-fun-shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-5px); }
      75% { transform: translateX(5px); }
    }
    .fyx-fun-popup-card {
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%);
      border-radius: 24px; padding: 40px; max-width: 480px; width: 90%;
      box-shadow: 0 25px 80px rgba(99, 102, 241, 0.4), 0 0 60px rgba(139, 92, 246, 0.2);
      animation: fyx-fun-bounce 0.6s ease; text-align: center; color: white;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .fyx-fun-emoji { font-size: 64px; margin-bottom: 16px; animation: fyx-fun-shake 1.5s ease infinite; }
    .fyx-fun-title { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
    .fyx-fun-message { font-size: 16px; color: rgba(255,255,255,0.8); margin-bottom: 12px; line-height: 1.5; }
    .fyx-fun-topic { font-size: 14px; color: rgba(255,255,255,0.6); margin-bottom: 24px; }
    .fyx-fun-topic strong { color: #a78bfa; }
    .fyx-fun-actions { display: flex; gap: 12px; margin-bottom: 16px; }
    .fyx-fun-btn {
      flex: 1; padding: 14px 20px; border: none; border-radius: 14px;
      font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s;
    }
    .fyx-fun-btn:hover { transform: translateY(-3px); }
    .fyx-fun-btn-focus { background: linear-gradient(135deg, #10b981, #059669); color: white; }
    .fyx-fun-btn-focus:hover { box-shadow: 0 8px 20px rgba(16, 185, 129, 0.4); }
    .fyx-fun-btn-break { background: rgba(255,255,255,0.15); color: white; border: 1px solid rgba(255,255,255,0.2); }
    .fyx-fun-btn-break:hover { background: rgba(255,255,255,0.25); }
    .fyx-fun-score { font-size: 12px; color: rgba(255,255,255,0.4); }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);
  makePopupDraggable(overlay, overlay.querySelector('.fyx-fun-popup-card'), 'fun');

  // Event handlers
  document.getElementById('fyx-im-focused').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FUN_POPUP_RESPONSE', action: 'focused' });
    overlay.remove();
    style.remove();
  });

  document.getElementById('fyx-take-break-fun').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REQUEST_BREAK' });
    overlay.remove();
    style.remove();
  });

  // Escalate to blink screen after 10 seconds if no response
  setTimeout(() => {
    if (overlay.parentNode) {
      chrome.runtime.sendMessage({ type: 'INTERVENTION_DISMISSED', reason: 'fun-timeout' });
      overlay.remove();
      style.remove();
      showBlinkScreen(data);
    }
  }, 10000);
}

async function getPopupPosition(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([`${popupPositionPrefix}${key}`], (result) => {
      resolve(result[`${popupPositionPrefix}${key}`] || null);
    });
  });
}

async function setPopupPosition(key, position) {
  return chrome.storage.local.set({ [`${popupPositionPrefix}${key}`]: position });
}

async function resetPopupPosition(key) {
  return chrome.storage.local.remove(`${popupPositionPrefix}${key}`);
}

function clampToViewport(panel, pos) {
  const margin = 12;
  const maxX = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
  return {
    x: Math.min(maxX, Math.max(margin, pos.x)),
    y: Math.min(maxY, Math.max(margin, pos.y))
  };
}

function positionPopup(panel, savedPosition) {
  const margin = 16;
  const defaultPos = {
    x: window.innerWidth - panel.offsetWidth - margin,
    y: window.innerHeight - panel.offsetHeight - margin
  };
  const target = clampToViewport(panel, savedPosition || defaultPos);
  panel.style.position = 'fixed';
  panel.style.left = `${target.x}px`;
  panel.style.top = `${target.y}px`;
}

async function makePopupDraggable(overlay, panel, storageKey) {
  if (!panel) return;
  overlay.style.background = 'transparent';
  overlay.style.backdropFilter = 'none';
  overlay.style.pointerEvents = 'none';
  panel.style.pointerEvents = 'auto';

  const savedPosition = await getPopupPosition(storageKey);
  positionPopup(panel, savedPosition);

  const handle = panel.querySelector('.fyx-drag-handle') || panel;
  handle.style.cursor = 'move';

  let dragging = false;
  let originX = 0;
  let originY = 0;

  const onPointerMove = (e) => {
    if (!dragging) return;
    const next = clampToViewport(panel, {
      x: e.clientX - originX,
      y: e.clientY - originY
    });
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
  };

  const onPointerUp = async () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    await setPopupPosition(storageKey, {
      x: parseInt(panel.style.left, 10) || 0,
      y: parseInt(panel.style.top, 10) || 0
    });
  };

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    originX = e.clientX - panel.offsetLeft;
    originY = e.clientY - panel.offsetTop;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });
}

// === COLORFUL BLINKING ATTENTION SCREEN ===
function showBlinkScreen(data) {
  const existing = document.getElementById('fyx-blink-screen');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'fyx-blink-screen';
  overlay.innerHTML = `
    <div class="fyx-blink-content">
      <div class="fyx-blink-icon">🚨</div>
      <h1 class="fyx-blink-title">Come back!</h1>
      <p class="fyx-blink-topic">You were learning about:<br><strong>${data.topic || 'something interesting'}</strong></p>
      <p class="fyx-blink-hint">Click anywhere or press any key to continue</p>
    </div>
  `;

  const style = document.createElement('style');
  style.id = 'fyx-blink-styles';
  style.textContent = `
    @keyframes fyx-gradient-shift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes fyx-pulse-glow {
      0%, 100% { text-shadow: 0 0 20px rgba(255,255,255,0.5); }
      50% { text-shadow: 0 0 60px rgba(255,255,255,0.9), 0 0 120px rgba(139,92,246,0.5); }
    }
    @keyframes fyx-icon-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.3); }
    }
    #fyx-blink-screen {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: linear-gradient(-45deg, #ee7752, #e73c7e, #23a6d5, #8b5cf6, #10b981);
      background-size: 400% 400%;
      animation: fyx-gradient-shift 3s ease infinite;
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      cursor: pointer;
    }
    .fyx-blink-content { text-align: center; color: white; }
    .fyx-blink-icon { font-size: 80px; animation: fyx-icon-pulse 1s ease infinite; margin-bottom: 20px; }
    .fyx-blink-title {
      font-size: 56px; font-weight: 800; margin-bottom: 16px;
      animation: fyx-pulse-glow 2s ease infinite;
    }
    .fyx-blink-topic { font-size: 20px; opacity: 0.9; margin-bottom: 40px; line-height: 1.5; }
    .fyx-blink-topic strong { font-size: 24px; }
    .fyx-blink-hint { font-size: 14px; opacity: 0.6; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // Dismiss on any interaction, then show quiz
  const dismiss = () => {
    overlay.remove();
    style.remove();
    // After dismissing blink screen, trigger a quiz on current content
    chrome.runtime.sendMessage({ type: 'REQUEST_QUIZ_AFTER_BLINK' });
  };

  overlay.addEventListener('click', dismiss);
  document.addEventListener('keydown', function handler() {
    dismiss();
    document.removeEventListener('keydown', handler);
  });
}

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeTracking);
} else {
  initializeTracking();
}

// Create attention indicator
createAttentionIndicator();

// Get initial attention score
chrome.runtime.sendMessage({ type: 'GET_ATTENTION_SCORE' }, (response) => {
  if (response) {
    updateAttentionIndicator(response.score);
  }
});

// Camera tracking setup
let cameraTracker = null;
let cameraVideo = null;
let cameraCanvas = null;
let cameraStatus = null;

function ensureCameraPanel() {
  if (cameraPanelInitialized) return;
  cameraPanelInitialized = true;

  const existing = document.getElementById('fyx-camera-panel');
  if (existing) return;

  const panel = document.createElement('div');
  panel.id = 'fyx-camera-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="fyx-camera-header">
      <span>Camera Tracking</span>
      <button id="fyx-camera-hide">Hide</button>
    </div>
    <video id="fyx-video" autoplay playsinline muted></video>
    <canvas id="fyx-canvas" width="320" height="240"></canvas>
    <div id="fyx-camera-status">Starting…</div>
  `;
  document.body.appendChild(panel);

  cameraVideo = panel.querySelector('#fyx-video');
  cameraCanvas = panel.querySelector('#fyx-canvas');
  cameraStatus = panel.querySelector('#fyx-camera-status');

  panel.querySelector('#fyx-camera-hide').addEventListener('click', () => {
    panel.style.display = 'none';
  });
}

function showCameraPanel() {
  ensureCameraPanel();
  const panel = document.getElementById('fyx-camera-panel');
  if (panel) panel.style.display = 'block';
}

function hideCameraPanel() {
  const panel = document.getElementById('fyx-camera-panel');
  if (panel) panel.style.display = 'none';
}

function updateCameraPanelStatus(metrics) {
  if (!cameraStatus) return;
  const mode = metrics.detectorMode || 'unknown';
  const face = metrics.faceDetected ? 'face present' : 'face missing';
  const state = metrics.userState || 'unknown';
  cameraStatus.textContent = `${mode} • ${face} • ${state}`;
}

function stopCameraTracking() {
  if (cameraTracker) {
    cameraTracker.stop();
    cameraTracker = null;
  }
}

async function initializeCameraTracking() {
  // Check if camera is enabled
  const config = await chrome.storage.local.get('userConfig');
  if (!config.userConfig?.cameraEnabled) {
    console.log('[FYX] Camera tracking disabled');
    return;
  }

  try {
    ensureCameraPanel();
    showCameraPanel();
    if (!cameraVideo || !cameraCanvas) return;

    // Initialize camera tracker
    if (typeof CameraTracker !== 'undefined') {
      if (cameraTracker) return;
      cameraTracker = new CameraTracker();
      const initialized = await cameraTracker.initialize();
      if (!initialized) {
        if (cameraStatus) cameraStatus.textContent = 'Face detector unavailable.';
        return;
      }

      const calibrationData = await chrome.storage.local.get('faceCalibration');
      if (calibrationData.faceCalibration) {
        cameraTracker.loadCalibration(calibrationData.faceCalibration);
      }

      await cameraTracker.start(cameraVideo, cameraCanvas);

      if (cameraStatus) cameraStatus.textContent = 'Camera active.';
    } else {
      console.log('[FYX] CameraTracker not available');
      if (cameraStatus) cameraStatus.textContent = 'Camera tracker unavailable.';
    }
  } catch (error) {
    console.error('[FYX] Failed to initialize camera tracking:', error);
    if (cameraStatus) cameraStatus.textContent = `Error: ${error.message || 'failed to start camera'}`;
  }
}


// Camera runtime is managed by offscreen document from background.js.

} // end double-injection guard
