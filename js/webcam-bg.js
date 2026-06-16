/* Webcam PiP background — blur or static image (session-only, in-memory). */

/**
 * @typedef {'none'|'blur'|'image'} BgMode
 */

function bufferScale(video, dim) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);
  return Math.min(2.5, Math.max(1.5, side / Math.max(dim, 1)));
}

/** Crop biased upward so the face sits in the middle of the PiP. */
function faceVideoCrop(video) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = Math.max(0, (vh - side) * 0.22);
  return { sx, sy, side: Math.min(side, vh - sy) };
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
    drawFaceCutout(ctx, video, x, y, dim);
  } else if (mode === 'blur') {
    drawBlurredFill(ctx, video, x, y, dim, blurPx);
    drawFaceCutout(ctx, video, x, y, dim);
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
  const { sx, sy, side } = faceVideoCrop(video);
  ctx.drawImage(video, sx, sy, side, side, x, y, dim, dim);
}

/** Entire circle — only blurred pixels, no sharp room visible. */
function drawBlurredFill(ctx, video, x, y, dim, blurPx) {
  const scale = bufferScale(video, dim);
  const buf = Math.round(dim * scale);
  const off = document.createElement('canvas');
  off.width = buf;
  off.height = buf;
  const octx = off.getContext('2d');
  const { sx, sy, side } = faceVideoCrop(video);
  const zoom = 1.25;
  const z = side * zoom;
  const zx = sx - (z - side) / 2;
  const zy = sy - (z - side) * 0.35;
  const blurAmt = Math.max(12, blurPx * (buf / dim) * 0.85);
  octx.filter = `blur(${blurAmt}px) saturate(1.05)`;
  octx.drawImage(video, zx, zy, z, z, 0, 0, buf, buf);
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

/** Small sharp face island — hard edge, no soft ring exposing the room. */
function drawFaceCutout(ctx, video, x, y, dim) {
  const faceCx = x + dim / 2;
  const faceCy = y + dim / 2 - dim * 0.05;
  const rx = dim * 0.2;
  const ry = dim * 0.24;

  const scale = bufferScale(video, dim);
  const bufSize = Math.round(dim * scale);
  const { sx, sy, side } = faceVideoCrop(video);
  const zoom = 1.22;
  const z = side / zoom;
  const zx = sx + (side - z) / 2;
  const zy = sy + (side - z) * 0.15;

  const off = document.createElement('canvas');
  off.width = bufSize;
  off.height = bufSize;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(video, zx, zy, z, z, 0, 0, bufSize, bufSize);

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(faceCx, faceCy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, x, y, dim, dim);
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
