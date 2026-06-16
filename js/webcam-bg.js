/* Webcam PiP — blur/image background with MediaPipe person mask when available. */

import { getSegmentationMaskCanvas, isSegmentationMaskReady } from './segmentation.js';

let personBuf = null;

function bufferScale(video, dim) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);
  return Math.min(2.5, Math.max(1.5, side / Math.max(dim, 1)));
}

function squareVideoCrop(video) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;
  return { sx, sy, side };
}

function getPersonBuf(dim) {
  if (!personBuf || personBuf.width !== dim) {
    personBuf = document.createElement('canvas');
    personBuf.width = dim;
    personBuf.height = dim;
  }
  return personBuf;
}

/**
 * Draw webcam into circular PiP with optional blurred or image background.
 */
export function drawWebcamWithBackground(ctx, video, x, y, dim, opts = {}) {
  const mode = opts.mode || 'none';
  const bgImage = opts.bgImage || null;
  const blurPx = opts.blurPx ?? 16;

  const cx = x + dim / 2;
  const cy = y + dim / 2;
  const r = dim / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (mode === 'image' && bgImage && bgImage.complete && bgImage.naturalWidth) {
    drawCover(ctx, bgImage, x, y, dim, dim);
    if (isSegmentationMaskReady()) {
      drawSegmentedPerson(ctx, video, x, y, dim);
    } else {
      drawLoadingPerson(ctx, video, x, y, dim);
    }
  } else if (mode === 'blur') {
    drawBlurredFill(ctx, video, x, y, dim, blurPx);
    if (isSegmentationMaskReady()) {
      drawSegmentedPerson(ctx, video, x, y, dim);
    } else {
      drawLoadingPerson(ctx, video, x, y, dim);
    }
  } else {
    drawSharpSquare(ctx, video, x, y, dim);
  }

  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(2, dim * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSharpSquare(ctx, video, x, y, dim) {
  const { sx, sy, side } = squareVideoCrop(video);
  ctx.drawImage(video, sx, sy, side, side, x, y, dim, dim);
}

function drawBlurredFill(ctx, video, x, y, dim, blurPx) {
  const scale = bufferScale(video, dim);
  const buf = Math.round(dim * scale);
  const off = document.createElement('canvas');
  off.width = buf;
  off.height = buf;
  const octx = off.getContext('2d');
  const { sx, sy, side } = squareVideoCrop(video);
  const blurAmt = Math.max(14, blurPx * (buf / dim) * 0.9);
  octx.filter = `blur(${blurAmt}px) saturate(1.05)`;
  octx.drawImage(video, sx, sy, side, side, 0, 0, buf, buf);
  octx.filter = 'none';
  ctx.drawImage(off, x, y, dim, dim);
}

function drawCover(ctx, img, x, y, w, h) {
  const ir = img.naturalWidth / img.naturalHeight;
  const r = w / h;
  let dw, dh, dx, dy;
  if (ir > r) {
    dh = h;
    dw = h * ir;
    dx = x + (w - dw) / 2;
    dy = y;
  } else {
    dw = w;
    dh = w / ir;
    dx = x;
    dy = y + (h - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

/** Person cutout from MediaPipe mask — body/face tracked, room hidden. */
function drawSegmentedPerson(ctx, video, x, y, dim) {
  const mask = getSegmentationMaskCanvas();
  if (!mask || !video.videoWidth) return;

  const { sx, sy, side } = squareVideoCrop(video);
  const buf = getPersonBuf(dim);
  const octx = buf.getContext('2d');
  octx.clearRect(0, 0, dim, dim);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(video, sx, sy, side, side, 0, 0, dim, dim);
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(mask, sx, sy, side, side, 0, 0, dim, dim);
  octx.globalCompositeOperation = 'source-over';

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(buf, x, y);
}

/** Brief fallback while the segmenter model loads (~1–2s). */
function drawLoadingPerson(ctx, video, x, y, dim) {
  drawBlurredFill(ctx, video, x, y, dim, 22);
  const faceCx = x + dim / 2;
  const faceCy = y + dim / 2 - dim * 0.04;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(faceCx, faceCy, dim * 0.17, dim * 0.2, 0, 0, Math.PI * 2);
  ctx.clip();
  const { sx, sy, side } = squareVideoCrop(video);
  ctx.drawImage(video, sx, sy, side, side, x, y, dim, dim);
  ctx.restore();
}

export function loadSessionBackground(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image'));
    };
    img.src = url;
  });
}
