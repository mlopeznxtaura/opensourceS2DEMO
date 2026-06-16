/* Webcam PiP — virtual background from BodyPix compositor output. */

import { getCompositedWebcamCanvas, isSegmentationMaskReady } from './segmentation.js';

function squareVideoCrop(video) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);
  return {
    sx: (vw - side) / 2,
    sy: (vh - side) / 2,
    side,
  };
}

/**
 * Draw webcam into circular PiP with optional blurred or image background.
 */
export function drawWebcamWithBackground(ctx, video, x, y, dim, opts = {}) {
  const mode = opts.mode || 'none';
  const cx = x + dim / 2;
  const cy = y + dim / 2;
  const r = dim / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (mode === 'image' || mode === 'blur') {
    const comp = getCompositedWebcamCanvas();
    if (isSegmentationMaskReady() && comp) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(comp, x, y, dim, dim);
    } else {
      const { sx, sy, side } = squareVideoCrop(video);
      ctx.drawImage(video, sx, sy, side, side, x, y, dim, dim);
    }
  } else {
    const { sx, sy, side } = squareVideoCrop(video);
    ctx.drawImage(video, sx, sy, side, side, x, y, dim, dim);
  }

  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(2, dim * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.stroke();
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
