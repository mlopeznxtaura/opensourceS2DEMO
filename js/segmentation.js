/*
 * Virtual background — BodyPix person mask + temporal smoothing (Broadcast-style).
 * Runs on WebGL or CPU WASM — no NVIDIA GPU required.
 */

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.esm.js';
const BODYPIX_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/body-pix@2.2.1/dist/body-pix.esm.js';
const PROCESS_SIZE = 384;
const TEMPORAL_BLEND = 0.38;
const SEG_INTERVAL_MS = 72;

let net = null;
let netInit = null;
let outputCanvas = null;
let outputCtx = null;
let bgCanvas = null;
let bgCtx = null;
let fgCanvas = null;
let fgCtx = null;
let maskSmall = null;
let maskSmallCtx = null;
let smoothMask = null;
let compositorReady = false;
let loopId = null;
let activeVideo = null;
let frameBusy = false;
let lastSegAt = 0;
let segStatus = '';

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

/** @deprecated use getCompositedWebcamCanvas */
export function getSegmentationMaskCanvas() {
  return outputCanvas;
}

export function getSegmentationStatus() {
  return segStatus;
}

export function setSegmentationOptions(opts = {}) {
  Object.assign(segOptions, opts);
}

function ensureCanvases() {
  if (!outputCanvas) {
    outputCanvas = document.createElement('canvas');
    outputCtx = outputCanvas.getContext('2d');
    bgCanvas = document.createElement('canvas');
    bgCtx = bgCanvas.getContext('2d');
    fgCanvas = document.createElement('canvas');
    fgCtx = fgCanvas.getContext('2d');
    maskSmall = document.createElement('canvas');
    maskSmallCtx = maskSmall.getContext('2d');
  }
  if (outputCanvas.width !== PROCESS_SIZE) {
    outputCanvas.width = bgCanvas.width = fgCanvas.width = PROCESS_SIZE;
    outputCanvas.height = bgCanvas.height = fgCanvas.height = PROCESS_SIZE;
  }
}

function drawVideoCover(ctx, video, w, h) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawImageCover(ctx, img, w, h) {
  const ir = img.naturalWidth / img.naturalHeight;
  const r = w / h;
  let dw, dh, dx, dy;
  if (ir > r) {
    dh = h;
    dw = h * ir;
    dx = (w - dw) / 2;
    dy = 0;
  } else {
    dw = w;
    dh = w / ir;
    dx = 0;
    dy = (h - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

function updateSmoothMask(seg) {
  const { data, width, height } = seg;
  const n = data.length;
  if (!smoothMask || smoothMask.length !== n) {
    smoothMask = new Float32Array(n);
    for (let i = 0; i < n; i++) smoothMask[i] = data[i];
  } else {
    const keep = 1 - TEMPORAL_BLEND;
    for (let i = 0; i < n; i++) {
      smoothMask[i] = smoothMask[i] * keep + data[i] * TEMPORAL_BLEND;
    }
  }

  if (maskSmall.width !== width || maskSmall.height !== height) {
    maskSmall.width = width;
    maskSmall.height = height;
  }
  const imageData = maskSmallCtx.createImageData(width, height);
  const d = imageData.data;
  for (let i = 0; i < n; i++) {
    const t = smoothMask[i];
    const a = t < 0.12 ? 0 : Math.min(255, Math.round(((t - 0.12) / 0.78) * 255));
    const j = i * 4;
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = a;
  }
  maskSmallCtx.putImageData(imageData, 0, 0);
}

function composeFrame(video) {
  ensureCanvases();
  const blurAmt = Math.max(10, segOptions.blurPx * 1.4);

  bgCtx.clearRect(0, 0, PROCESS_SIZE, PROCESS_SIZE);
  if (segOptions.mode === 'image' && segOptions.bgImage?.complete) {
    drawImageCover(bgCtx, segOptions.bgImage, PROCESS_SIZE, PROCESS_SIZE);
  } else {
    bgCtx.filter = `blur(${blurAmt}px) saturate(1.06)`;
    drawVideoCover(bgCtx, video, PROCESS_SIZE, PROCESS_SIZE);
    bgCtx.filter = 'none';
  }

  fgCtx.clearRect(0, 0, PROCESS_SIZE, PROCESS_SIZE);
  drawVideoCover(fgCtx, video, PROCESS_SIZE, PROCESS_SIZE);
  fgCtx.globalCompositeOperation = 'destination-in';
  fgCtx.drawImage(maskSmall, 0, 0, PROCESS_SIZE, PROCESS_SIZE);
  fgCtx.globalCompositeOperation = 'source-over';

  outputCtx.clearRect(0, 0, PROCESS_SIZE, PROCESS_SIZE);
  outputCtx.drawImage(bgCanvas, 0, 0);
  outputCtx.drawImage(fgCanvas, 0, 0);
  compositorReady = true;
  segStatus = 'Background tracking active';
}

async function ensureModel() {
  if (net) return net;
  if (netInit) return netInit;
  segStatus = 'Loading background AI…';
  netInit = (async () => {
    const tf = await import(TF_URL);
    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch (_) {
      await tf.setBackend('cpu');
      await tf.ready();
    }
    const bodyPix = await import(BODYPIX_URL);
    net = await bodyPix.load({
      architecture: 'MobileNetV1',
      outputStride: 16,
      multiplier: 0.75,
      quantBytes: 2,
    });
    segStatus = 'Background AI ready';
    return net;
  })();
  return netInit;
}

async function processFrame(video) {
  if (!net || !video?.videoWidth) return;
  const segmentation = await net.segmentPerson(video, {
    flipHorizontal: false,
    internalResolution: 'medium',
    segmentationThreshold: 0.55,
    maxDetections: 1,
  });
  updateSmoothMask(segmentation);
  composeFrame(video);
}

function runLoop() {
  loopId = requestAnimationFrame(runLoop);
  if (frameBusy || !activeVideo || activeVideo.readyState < 2) return;
  const now = performance.now();
  if (now - lastSegAt < SEG_INTERVAL_MS) return;
  lastSegAt = now;
  frameBusy = true;
  processFrame(activeVideo)
    .catch(err => {
      console.warn('Segmentation frame:', err);
      segStatus = 'Background AI error — try refreshing';
    })
    .finally(() => { frameBusy = false; });
}

export function startSegmentationLoop(video) {
  if (!video) return;
  activeVideo = video;
  compositorReady = false;
  smoothMask = null;
  ensureModel()
    .then(() => {
      if (activeVideo !== video) return;
      if (!loopId) runLoop();
    })
    .catch(err => {
      console.warn('BodyPix unavailable:', err);
      segStatus = 'Background AI failed to load (check network)';
    });
}

export function stopSegmentationLoop() {
  activeVideo = null;
  compositorReady = false;
  smoothMask = null;
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
  netInit = null;
  outputCanvas = null;
  outputCtx = null;
  bgCanvas = null;
  bgCtx = null;
  fgCanvas = null;
  fgCtx = null;
  maskSmall = null;
  maskSmallCtx = null;
}
