/* MediaPipe selfie segmentation — tracks you, hides the room behind. */

const MP_VER = '0.10.14';
const MP_ESM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/+esm`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';

let segmenter = null;
let segmenterInit = null;
let maskCanvas = null;
let maskCtx = null;
let maskReady = false;
let loopId = null;
let activeVideo = null;
let timestamp = 0;
let frameBusy = false;

export function isSegmentationMaskReady() {
  return maskReady && !!maskCanvas;
}

export function getSegmentationMaskCanvas() {
  return maskCanvas;
}

async function createSegmenter(delegate = 'GPU') {
  const { ImageSegmenter, FilesetResolver } = await import(MP_ESM);
  const vision = await FilesetResolver.forVisionTasks(MP_WASM);
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

export async function ensureSegmenter() {
  if (segmenter) return segmenter;
  if (segmenterInit) return segmenterInit;
  segmenterInit = (async () => {
    try {
      segmenter = await createSegmenter('GPU');
    } catch (gpuErr) {
      console.warn('GPU segmenter failed, trying CPU:', gpuErr);
      segmenter = await createSegmenter('CPU');
    }
    return segmenter;
  })();
  return segmenterInit;
}

function writeMaskFromFloats(floats, w, h) {
  if (!maskCanvas) {
    maskCanvas = document.createElement('canvas');
    maskCtx = maskCanvas.getContext('2d');
  }
  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
  }
  const imageData = maskCtx.createImageData(w, h);
  const d = imageData.data;
  for (let i = 0; i < floats.length; i++) {
    const t = floats[i];
    const a = t <= 0.08 ? 0 : Math.min(255, Math.round(((t - 0.08) / 0.72) * 255));
    const j = i * 4;
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = a;
  }
  maskCtx.putImageData(imageData, 0, 0);
  maskReady = true;
}

async function processFrame(video) {
  if (!segmenter || !video?.videoWidth) return;
  timestamp += 33;
  const result = segmenter.segmentForVideo(video, timestamp);
  const mask = result.confidenceMasks?.[0];
  if (!mask) return;
  try {
    const floats = mask.getAsFloat32Array();
    writeMaskFromFloats(floats, mask.width, mask.height);
  } finally {
    mask.close?.();
  }
  result.close?.();
}

function runLoop() {
  loopId = requestAnimationFrame(runLoop);
  if (frameBusy || !activeVideo || activeVideo.readyState < 2) return;
  frameBusy = true;
  processFrame(activeVideo)
    .catch(err => console.warn('Segmentation frame:', err))
    .finally(() => { frameBusy = false; });
}

export function startSegmentationLoop(video) {
  if (!video) return;
  activeVideo = video;
  maskReady = false;
  ensureSegmenter()
    .then(() => {
      if (activeVideo !== video) return;
      if (!loopId) runLoop();
    })
    .catch(err => console.warn('Segmentation unavailable:', err));
}

export function stopSegmentationLoop() {
  activeVideo = null;
  maskReady = false;
  if (loopId) {
    cancelAnimationFrame(loopId);
    loopId = null;
  }
}

export async function disposeSegmenter() {
  stopSegmentationLoop();
  if (segmenter) {
    try { segmenter.close(); } catch (_) {}
    segmenter = null;
  }
  segmenterInit = null;
  maskCanvas = null;
  maskCtx = null;
}
