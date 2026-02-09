// FYX Camera Tracker — Content Script Bridge
// Receives face landmark state from the background offscreen document
// and dispatches sleepinessMetrics events for content.js to consume.
// No camera is opened here — the offscreen document handles all detection.

class CameraTracker {
  constructor() {
    this.isRunning = false;
    this.pollTimer = null;

    this.sleepinessScore = 100;
    this.userState = 'focused';
    this.faceDetected = false;
    this.faceAbsentDuration = 0;
    this.detectorMode = 'mediapipe-landmarker';

    // Landmark data from background
    this.landmarks = null;

    // Calibration (kept for compatibility)
    this.calibratedCenter = null;
    this.calibratedArea = null;
    this.lookAwayThreshold = 0.12;
    this.motionThreshold = 0.04;
  }

  async initialize() {
    // No local initialization needed — offscreen handles MediaPipe
    return true;
  }

  async requestCameraAccess() {
    // Camera is managed by the offscreen document, not here
    return true;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Poll background for landmark data every 200ms
    this.pollTimer = setInterval(() => this.pollLandmarks(), 200);
    console.log('[CameraTracker] Started (bridge mode — offscreen provides landmarks)');
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log('[CameraTracker] Stopped');
  }

  async pollLandmarks() {
    if (!this.isRunning) return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_LANDMARK_DATA' });
      if (!response || !response.success) return;

      this.landmarks = response.landmarks;
      this.sleepinessScore = typeof response.sleepinessScore === 'number' ? response.sleepinessScore : 0;
      this.userState = response.cameraUserState || 'unknown';
      this.faceDetected = response.landmarks?.facePresent || false;
      this.faceAbsentDuration = response.faceAbsentDuration || 0;

      if (this.landmarks) {
        this.detectorMode = 'mediapipe-landmarker';
      }

      this.dispatchMetrics();
    } catch {
      // Extension context may be invalid during navigation
    }
  }

  calibrate(type) {
    // Calibration with landmarks: store current head position as baseline
    if (!this.landmarks || !this.landmarks.facePresent) {
      console.warn('[CameraTracker] No landmark data for calibration');
      return {};
    }

    if (type === 'normal') {
      this.calibratedCenter = this.landmarks.headPosition;
      this.calibratedArea = 1; // normalized
    } else if (type === 'smile') {
      this.motionThreshold = Math.max(this.motionThreshold, 0.035);
    } else if (type === 'look_away' && this.calibratedCenter) {
      const hp = this.landmarks.headPosition;
      const offset = Math.hypot(hp.x - this.calibratedCenter.x, hp.y - this.calibratedCenter.y);
      this.lookAwayThreshold = Math.max(0.08, offset * 0.65);
    }

    return {
      normalCenter: this.calibratedCenter,
      normalArea: this.calibratedArea,
      motionThreshold: this.motionThreshold,
      lookAwayThreshold: this.lookAwayThreshold
    };
  }

  loadCalibration(data) {
    if (data.normalCenter) this.calibratedCenter = data.normalCenter;
    if (data.normalArea) this.calibratedArea = data.normalArea;
    if (data.motionThreshold) this.motionThreshold = data.motionThreshold;
    if (data.lookAwayThreshold) this.lookAwayThreshold = data.lookAwayThreshold;
  }

  dispatchMetrics() {
    const lm = this.landmarks || {};
    const hp = lm.headPose || {};

    const event = new CustomEvent('sleepinessMetrics', {
      detail: {
        leftEyeEAR: lm.leftEAR || 0,
        rightEyeEAR: lm.rightEAR || 0,
        avgEAR: lm.avgEAR || 0,
        blinkCount: 0,
        lastBlinkDuration: 0,
        blinkRate: 0,
        perclos: 0,
        sleepinessScore: this.sleepinessScore,
        faceDetected: this.faceDetected,
        userState: this.userState,
        headPose: { yaw: hp.yaw || 0, pitch: hp.pitch || 0, roll: hp.roll || 0 },
        avgMovement: 0,
        faceAbsentDuration: this.faceAbsentDuration,
        detectorMode: this.detectorMode,
        eyesClosed: lm.eyesClosed || false,
        lookingAway: lm.lookingAway || false,
        mouthOpen: lm.mouthOpen || false,
        blendshapes: lm.blendshapes || {}
      }
    });

    window.dispatchEvent(event);
  }

  getMetrics() {
    return {
      sleepinessScore: this.sleepinessScore,
      userState: this.userState,
      faceDetected: this.faceDetected
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CameraTracker;
}
