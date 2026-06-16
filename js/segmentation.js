/*
 * Virtual background — BodyPix drawBokehEffect (person sharp, room blurred/replaced).
 * Models served from /vendor/ on same origin (no CDN dependency).
 */

const TF_URL = '/vendor/tfjs/tf.esm.js';
const BODYPIX_URL = '/vendor/body-pix/body-pix.esm.js';
const PROCESS_SIZE = 384;
const TEMPORAL_BLEND = 0.42;
const SEG_INTERVAL_MS = 66;

let net = null;
let bodyPixApi = null;
let netInit = null;
let outputCanvas = null;
let smoothFloat = null;
let smoothU8 = null;
let compositorReady = false;
let loopId = null;
let activeVideo = null;
let frameBusy = false;
let lastSegAt = 0;
let segStatus = '';
let segError = '';

const segOptions = {
  mode: 'none',
  bgImage: null,
  blurPx: 14,
};

export function isSegmentationMaskReady() {
  return compositorReady && !!outputCanvas;
}

export function getCompositedWebcamCanvas() {
  return outputCanvas;
}

export function getSegmentationMaskCanvas() {
  return outputCanvas;
}

export function getSegmentationStatus() {
  return segStatus;
}

export function getSegmentationError() {
  return segError;
}

export function setSegmentationOptions(opts = {}) {
  Object.assign(segOptions, opts);
}

function ensureOutputCanvas() {
  if (!outputCanvas) {
    outputCanvas = document.createElement('canvas');
  }
  if (outputCanvas.width !== PROCESS_SIZE) {
    outputCanvas.width = PROCESS_SIZE;
    outputCanvas.height = PROCESS_SIZE;
  }
}

function buildSmoothedSegmentation(seg) {
  const { data, width, height } = seg;
  const n = data.length;
  if (!smoothFloat || smoothFloat.length !== n) {
    smoothFloat = new Float32Array(n);
    for (let i = 0; i < n; i++) smoothFloat[i] = data[i];
  } else {
    const keep = 1 - TEMPORAL_BLEND;
    for (let i = 0; i < n; i++) {
      smoothFloat[i] = smoothFloat[i] * keep + data[i] * TEMPORAL_BLEND;
    }
  }
  if (!smoothU8 || smoothU8.length !== n) smoothU8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) smoothU8[i] = smoothFloat[i] > 0.35 ? 1 : 0;
  return { data: smoothU8, width, height };
}

async function renderFrame(video) {
  if (!net || !bodyPixApi || !video?.videoWidth) return;
  ensureOutputCanvas();

  const segmentation = await net.segmentPerson(video, {
    flipHorizontal: false,
    internalResolution: 'high',
    segmentationThreshold: 0.35,
    maxDetections: 1,
  });
  const smoothed = buildSmoothedSegmentation(segmentation);
  const edgeBlur = 5;
  const blur = Math.min(22, Math.max(8, segOptions.blurPx));

  if (segOptions.mode === 'image' && segOptions.bgImage?.complete) {
    await bodyPixApi.drawBokehEffect(
      outputCanvas,
      video,
      0,
      smoothed,
      false,
      0,
      edgeBlur,
      { image: segOptions.bgImage },
    );
  } else {
    await bodyPixApi.drawBokehEffect(
      outputCanvas,
      video,
      blur,
      smoothed,
      false,
      blur,
      edgeBlur,
    );
  }

  compositorReady = true;
  segStatus = 'You sharp — background replaced';
}

async function ensureModel() {
  if (net) return net;
  if (netInit) return netInit;
  segStatus = 'Loading background AI…';
  segError = '';
  netInit = (async () => {
    const tf = await import(TF_URL);
    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch (_) {
      await tf.setBackend('cpu');
      await tf.ready();
    }
    bodyPixApi = await import(BODYPIX_URL);
    net = await bodyPixApi.load({
      architecture: 'MobileNetV1',
      outputStride: 16,
      multiplier: 0.75,
      quantBytes: 2,
    });
    segStatus = 'Tracking you…';
    return net;
  })();
  return netInit;
}

function runLoop() {
  loopId = requestAnimationFrame(runLoop);
  if (frameBusy || !activeVideo || activeVideo.readyState < 2) return;
  const now = performance.now();
  if (now - lastSegAt < SEG_INTERVAL_MS) return;
  lastSegAt = now;
  frameBusy = true;
  renderFrame(activeVideo)
    .catch(err => {
      console.error('Virtual background frame:', err);
      segError = err.message || String(err);
      segStatus = 'Background AI error — see console';
      compositorReady = false;
    })
    .finally(() => { frameBusy = false; });
}

export function startSegmentationLoop(video) {
  if (!video) return;
  activeVideo = video;
  compositorReady = false;
  smoothFloat = null;
  smoothU8 = null;
  ensureModel()
    .then(() => {
      if (activeVideo !== video) return;
      if (!loopId) runLoop();
    })
    .catch(err => {
      console.error('BodyPix load failed:', err);
      segError = err.message || String(err);
      segStatus = 'Could not load background AI';
      compositorReady = false;
    });
}

export function stopSegmentationLoop() {
  activeVideo = null;
  compositorReady = false;
  smoothFloat = null;
  smoothU8 = null;
  segStatus = '';
  if (loopId) {
    cancelAnimationFrame(loopId);
    loopId = null;
  }
}

export async function disposeSegmenter() {
  stopSegmentationLoop();
  if (net) {
    try { net.dispose(); } catch (_) {}
    net = null;
  }
  bodyPixApi = null;
  netInit = null;
  outputCanvas = null;
}
