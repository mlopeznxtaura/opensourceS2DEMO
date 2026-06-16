/* Webcam PiP background — blur or static image (session-only, in-memory). */

/**
 * @typedef {'none'|'blur'|'image'} BgMode
 */

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

function bufferScale(video, dim) {
  const { side } = squareVideoCrop(video);
  return Math.min(2.5, Math.max(1.5, side / Math.max(dim, 1)));
}

/**
 * Draw webcam into circular PiP with optional blurred or image background.
 */
export function drawWebcamWithBackground(ctx, video, x, y, dim, opts = {}) {
  const mode = opts.mode || 'none';
  const bgImage = opts.bgImage || null;
  const blurPx = opts.blurPx ?? 14;

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
    drawForegroundOval(ctx, video, x, y, dim, 0.72);
  } else if (mode === 'blur') {
    drawBlurredBackground(ctx, video, x, y, dim, blurPx);
    drawForegroundOval(ctx, video, x, y, dim, 0.7);
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

function drawBlurredBackground(ctx, video, x, y, dim, blurPx) {
  const scale = bufferScale(video, dim);
  const buf = Math.round(dim * scale);
  const off = document.createElement('canvas');
  off.width = buf;
  off.height = buf;
  const octx = off.getContext('2d');
  const { sx, sy, side } = squareVideoCrop(video);
  const blurAmt = Math.max(6, blurPx * (buf / dim) * 0.55);
  octx.filter = `blur(${blurAmt}px) saturate(1.08)`;
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

/** Soft oval cutout — center stays sharp (portrait-style without ML). */
function drawForegroundOval(ctx, video, x, y, dim, ovalScale) {
  const scale = bufferScale(video, dim);
  const bufSize = Math.round(dim * scale);
  const { sx, sy, side } = squareVideoCrop(video);

  const off = document.createElement('canvas');
  off.width = bufSize;
  off.height = bufSize;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(video, sx, sy, side, side, 0, 0, bufSize, bufSize);

  const mask = document.createElement('canvas');
  mask.width = bufSize;
  mask.height = bufSize;
  const mctx = mask.getContext('2d');
  const rw = (bufSize / 2) * ovalScale;
  const rh = (bufSize / 2) * ovalScale * 1.05;
  const grad = mctx.createRadialGradient(
    bufSize / 2, bufSize / 2, bufSize * 0.1,
    bufSize / 2, bufSize / 2, bufSize * 0.5,
  );
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  mctx.fillStyle = grad;
  mctx.beginPath();
  mctx.ellipse(bufSize / 2, bufSize / 2, rw, rh, 0, 0, Math.PI * 2);
  mctx.fill();

  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(mask, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, x, y, dim, dim);
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
