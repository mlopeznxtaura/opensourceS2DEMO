/*
 * Virtual background — BodyPix drawBokehEffect (you sharp, room blurred/replaced).
 * Uses UMD scripts from /vendor/ (see index.html).
 */

const TEMPORAL_BLEND = 0.42;
const SEG_INTERVAL_MS = 66;

let net = null;
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

function bodyPixApi() {
  return globalThis['body-pix'] || globalThis.bodyPix;
}

function tfApi() {
  return globalThis.tf;
}

function libsLoaded() {
  return !!(tfApi() && bodyPixApi());
}

function videoReady(video) {
  const w = video?.videoWidth;
  const h = video?.videoHeight;
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h);
}

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
  if (!outputCanvas) outputCanvas = document.createElement('canvas');
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

function drawCoverImage(ctx, img, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawPersonOverBackground(canvas, video, seg, edgeBlur) {
  const bodyPix = bodyPixApi();
  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  drawCoverImage(ctx, segOptions.bgImage, w, h);

  const personCanvas = document.createElement('canvas');
  personCanvas.width = w;
  personCanvas.height = h;
  const pctx = personCanvas.getContext('2d');
  pctx.drawImage(video, 0, 0, w, h);

  const maskImage = bodyPix.toMask(
    seg,
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 0, g: 0, b: 0, a: 0 },
  );
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  mctx.putImageData(maskImage, 0, 0);
  if (edgeBlur > 0) {
    mctx.filter = `blur(${edgeBlur}px)`;
    mctx.drawImage(maskCanvas, 0, 0);
    mctx.filter = 'none';
  }

  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(maskCanvas, 0, 0);
  ctx.drawImage(personCanvas, 0, 0);
}

async function renderFrame(video) {
  const bodyPix = bodyPixApi();
  if (!net || !bodyPix || !videoReady(video)) return;
  ensureOutputCanvas();

  const segmentation = await net.segmentPerson(video, {
    flipHorizontal: false,
    internalResolution: 'medium',
    segmentationThreshold: 0.5,
    maxDetections: 1,
  });
  if (!videoReady(video)) return;

  const smoothed = buildSmoothedSegmentation(segmentation);
  const edgeBlur = 5;
  const blur = Math.min(20, Math.max(1, Math.round(segOptions.blurPx)));

  if (segOptions.mode === 'image' && segOptions.bgImage?.complete) {
    drawPersonOverBackground(outputCanvas, video, smoothed, edgeBlur);
  } else {
    bodyPix.drawBokehEffect(outputCanvas, video, smoothed, blur, edgeBlur, false);
  }

  compositorReady = true;
  segError = '';
  segStatus = 'You sharp — background replaced';
}

async function ensureModel() {
  if (net) return net;
  if (!libsLoaded()) {
    throw new Error('AI libraries missing — hard refresh the page');
  }
  const tf = tfApi();
  const bodyPix = bodyPixApi();
  segStatus = 'Loading background AI…';
  segError = '';
  try {
    await tf.setBackend('webgl');
    await tf.ready();
  } catch (_) {
    await tf.setBackend('cpu');
    await tf.ready();
  }
  net = await bodyPix.load({
    architecture: 'MobileNetV1',
    outputStride: 16,
    multiplier: 0.75,
    quantBytes: 2,
  });
  segStatus = videoReady(activeVideo) ? 'Tracking you…' : 'Waiting for camera frames…';
  return net;
}

function runLoop() {
  loopId = requestAnimationFrame(runLoop);
  if (frameBusy || !activeVideo) return;
  if (!videoReady(activeVideo)) {
    segStatus = 'Waiting for camera frames…';
    return;
  }
  const now = performance.now();
  if (now - lastSegAt < SEG_INTERVAL_MS) return;
  lastSegAt = now;
  frameBusy = true;
  renderFrame(activeVideo)
    .catch(err => {
      if (!videoReady(activeVideo)) return;
      console.error('Virtual background frame:', err);
      segError = err.message || String(err);
      segStatus = 'Background AI error';
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
  segError = '';
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
  segError = '';
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
  outputCanvas = null;
}
