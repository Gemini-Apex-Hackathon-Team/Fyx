// FYX Offscreen Camera — MediaPipe FaceLandmarker via WASM + Gemini Vision fallback
// Runs in an offscreen document so the camera persists across tab switches.

const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

let faceLandmarker = null;
let started = false;
let heartbeatTimer = null;
let signalTimer = null;
let streamRef = null;
let lastTimestamp = -1;
let detectorMode = 'none'; // 'mediapipe-landmarker' | 'gemini-vision' | 'none'

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function initLandmarker() {
  try {
    const { FaceLandmarker, FilesetResolver } = await import('./mediapipe/vision_bundle.mjs');

    const wasmPath = chrome.runtime.getURL('mediapipe/wasm');
    const filesetResolver = await FilesetResolver.forVisionTasks(wasmPath);

    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('mediapipe/face_landmarker.task'),
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true
    });
    console.log('[FYX Offscreen] FaceLandmarker initialized (GPU)');
    return true;
  } catch (err) {
    console.warn('[FYX Offscreen] GPU init failed, trying CPU:', err);
    try {
      const { FaceLandmarker, FilesetResolver } = await import('./mediapipe/vision_bundle.mjs');

      const wasmPath = chrome.runtime.getURL('mediapipe/wasm');
      const filesetResolver = await FilesetResolver.forVisionTasks(wasmPath);

      faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL('mediapipe/face_landmarker.task'),
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true
      });
      console.log('[FYX Offscreen] FaceLandmarker initialized (CPU fallback)');
      return true;
    } catch (err2) {
      console.error('[FYX Offscreen] FaceLandmarker init failed entirely:', err2);
      return false;
    }
  }
}

function extractLandmarkData(result) {
  if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
    return { facePresent: false };
  }

  const landmarks = result.faceLandmarks[0];

  const leftEyeTop = landmarks[159];
  const leftEyeBottom = landmarks[145];
  const rightEyeTop = landmarks[386];
  const rightEyeBottom = landmarks[374];
  const noseTip = landmarks[1];
  const topLip = landmarks[13];
  const bottomLip = landmarks[14];

  const leftEyeOuter = landmarks[33];
  const leftEyeInner = landmarks[133];
  const rightEyeOuter = landmarks[362];
  const rightEyeInner = landmarks[263];

  const leftEAR = Math.abs(leftEyeTop.y - leftEyeBottom.y) /
    (Math.abs(leftEyeOuter.x - leftEyeInner.x) || 0.001);
  const rightEAR = Math.abs(rightEyeTop.y - rightEyeBottom.y) /
    (Math.abs(rightEyeOuter.x - rightEyeInner.x) || 0.001);
  const avgEAR = (leftEAR + rightEAR) / 2;

  const mouthOpenness = Math.abs(topLip.y - bottomLip.y);

  const headX = noseTip.x;
  const headY = noseTip.y;

  let blendshapes = {};
  if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
    const shapes = result.faceBlendshapes[0].categories;
    for (const shape of shapes) {
      blendshapes[shape.categoryName] = Math.round(shape.score * 1000) / 1000;
    }
  }

  let headPose = { yaw: 0, pitch: 0, roll: 0 };
  if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
    const matrix = result.facialTransformationMatrixes[0].data;
    if (matrix && matrix.length >= 16) {
      headPose.pitch = Math.asin(-matrix[6]) * (180 / Math.PI);
      headPose.yaw = Math.atan2(matrix[2], matrix[10]) * (180 / Math.PI);
      headPose.roll = Math.atan2(matrix[4], matrix[5]) * (180 / Math.PI);
    }
  }

  const eyesClosed = avgEAR < 0.15;
  const lookingAway = Math.abs(headPose.yaw) > 25 || Math.abs(headPose.pitch) > 20;
  const mouthOpen = mouthOpenness > 0.04;

  const eyeBlinkLeft = blendshapes.eyeBlinkLeft || 0;
  const eyeBlinkRight = blendshapes.eyeBlinkRight || 0;
  const eyeSquintLeft = blendshapes.eyeSquintLeft || 0;
  const eyeSquintRight = blendshapes.eyeSquintRight || 0;
  const browDownLeft = blendshapes.browDownLeft || 0;
  const browDownRight = blendshapes.browDownRight || 0;
  const browInnerUp = blendshapes.browInnerUp || 0;
  const jawOpen = blendshapes.jawOpen || 0;
  const mouthSmileLeft = blendshapes.mouthSmileLeft || 0;
  const mouthSmileRight = blendshapes.mouthSmileRight || 0;
  const eyeLookUpLeft = blendshapes.eyeLookUpLeft || 0;
  const eyeLookDownLeft = blendshapes.eyeLookDownLeft || 0;
  const eyeLookInLeft = blendshapes.eyeLookInLeft || 0;
  const eyeLookOutLeft = blendshapes.eyeLookOutLeft || 0;

  return {
    facePresent: true,
    eyesClosed,
    lookingAway,
    mouthOpen,
    leftEAR: Math.round(leftEAR * 1000) / 1000,
    rightEAR: Math.round(rightEAR * 1000) / 1000,
    avgEAR: Math.round(avgEAR * 1000) / 1000,
    mouthOpenness: Math.round(mouthOpenness * 1000) / 1000,
    headPose: {
      yaw: Math.round(headPose.yaw * 10) / 10,
      pitch: Math.round(headPose.pitch * 10) / 10,
      roll: Math.round(headPose.roll * 10) / 10
    },
    headPosition: {
      x: Math.round(headX * 1000) / 1000,
      y: Math.round(headY * 1000) / 1000
    },
    blendshapes: {
      eyeBlinkLeft: Math.round(eyeBlinkLeft * 100) / 100,
      eyeBlinkRight: Math.round(eyeBlinkRight * 100) / 100,
      eyeSquintLeft: Math.round(eyeSquintLeft * 100) / 100,
      eyeSquintRight: Math.round(eyeSquintRight * 100) / 100,
      browDownLeft: Math.round(browDownLeft * 100) / 100,
      browDownRight: Math.round(browDownRight * 100) / 100,
      browInnerUp: Math.round(browInnerUp * 100) / 100,
      jawOpen: Math.round(jawOpen * 100) / 100,
      mouthSmileLeft: Math.round(mouthSmileLeft * 100) / 100,
      mouthSmileRight: Math.round(mouthSmileRight * 100) / 100,
      eyeLookUpLeft: Math.round(eyeLookUpLeft * 100) / 100,
      eyeLookDownLeft: Math.round(eyeLookDownLeft * 100) / 100,
      eyeLookInLeft: Math.round(eyeLookInLeft * 100) / 100,
      eyeLookOutLeft: Math.round(eyeLookOutLeft * 100) / 100
    }
  };
}

function analyzeFrame() {
  if (!started || !faceLandmarker) return;

  if (video.readyState < 2) return;

  const now = performance.now();
  if (now === lastTimestamp) return;
  lastTimestamp = now;

  try {
    const result = faceLandmarker.detectForVideo(video, now);
    const data = extractLandmarkData(result);

    send({
      type: 'CAMERA_SIGNAL',
      ts: Date.now(),
      detectorMode: 'mediapipe-landmarker',
      ...data
    });
  } catch (err) {
    console.error('[FYX Offscreen] Detection error:', err);
    send({
      type: 'CAMERA_SIGNAL',
      ts: Date.now(),
      facePresent: null,
      detectorMode: 'mediapipe-landmarker',
      error: err.message
    });
  }
}

// --- Gemini Vision Fallback ---
// Captures frames as base64 JPEG and sends to background for Gemini Vision analysis

function captureFrameAsBase64() {
  if (!started || video.readyState < 2) return null;

  canvas.width = 320;
  canvas.height = 240;
  ctx.drawImage(video, 0, 0, 320, 240);

  // Export as JPEG with low quality to keep payload small
  const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
  // Strip the data:image/jpeg;base64, prefix
  return dataUrl.split(',')[1];
}

function sendVisionFrame() {
  if (!started) return;

  const base64 = captureFrameAsBase64();
  if (!base64) return;

  send({
    type: 'CAMERA_FRAME',
    frame: base64,
    ts: Date.now()
  });
}

function startVisionFallback() {
  detectorMode = 'gemini-vision';
  console.log('[FYX Offscreen] Starting Gemini Vision fallback mode');

  send({
    type: 'CAMERA_STATUS',
    ok: true,
    detector: 'gemini-vision'
  });

  // Capture and send frames every 4 seconds
  signalTimer = setInterval(sendVisionFrame, 4000);
  // Send first frame immediately
  setTimeout(sendVisionFrame, 500);
}

async function startCamera() {
  if (started) return;

  try {
    // Try MediaPipe first
    const landmarkerReady = await initLandmarker();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 }, facingMode: 'user' },
      audio: false
    });

    streamRef = stream;
    video.srcObject = stream;
    await video.play();

    started = true;

    heartbeatTimer = setInterval(() => {
      send({
        type: 'CAMERA_HEARTBEAT',
        ts: Date.now(),
        readyState: video.readyState,
        detectorMode
      });
    }, 2000);

    if (landmarkerReady) {
      // MediaPipe WASM works — use it
      detectorMode = 'mediapipe-landmarker';
      send({
        type: 'CAMERA_STATUS',
        ok: true,
        detector: 'mediapipe-landmarker'
      });
      signalTimer = setInterval(analyzeFrame, 100);
      console.log('[FYX Offscreen] Camera started with MediaPipe FaceLandmarker');
    } else {
      // MediaPipe failed — fall back to Gemini Vision
      startVisionFallback();
    }
  } catch (e) {
    console.error('[FYX Offscreen] Camera start failed:', e);
    send({
      type: 'CAMERA_STATUS',
      ok: false,
      error: String(e)
    });
  }
}

function stopCamera() {
  started = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (signalTimer) {
    clearInterval(signalTimer);
    signalTimer = null;
  }
  if (streamRef) {
    streamRef.getTracks().forEach((t) => t.stop());
    streamRef = null;
  }
  video.srcObject = null;
  if (faceLandmarker) {
    faceLandmarker.close();
    faceLandmarker = null;
  }
  detectorMode = 'none';
  send({ type: 'CAMERA_STATUS', ok: false, stopped: true });
  console.log('[FYX Offscreen] Camera stopped');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_CAMERA_START') {
    startCamera()
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_CAMERA_STOP') {
    stopCamera();
    sendResponse({ success: true });
    return true;
  }
});
