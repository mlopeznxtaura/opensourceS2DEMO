/* Webcam PiP background — blur or static image (session-only, in-memory). */

/**
 * @typedef {'none'|'blur'|'image'} BgMode
 */

/**
 * Draw webcam into circular PiP with optional blurred or image background.
 */
export function drawWebcamWithBackground(ctx, video, x, y, dim, opts = {}) {
  const mode = opts.mode || 'none';
  const bgImage = opts.bgImage || null;
  const blurPx = opts.blurPx ?? 18;

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
    const scale = 1.35;
    const bw = dim * scale;
    const bh = dim * scale;
    ctx.filter = `blur(${Math.max(8, blurPx)}px) saturate(1.15) brightness(0.95)`;
    ctx.drawImage(video, cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.filter = 'none';
    drawForegroundOval(ctx, video, x, y, dim, 0.75);
  } else {
    ctx.drawImage(video, x, y, dim, dim);
  }

  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(2, dim * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.stroke();
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
  const cx = x + dim / 2;
  const cy = y + dim / 2;
  const rw = (dim / 2) * ovalScale;
  const rh = (dim / 2) * ovalScale * 1.05;

  const off = document.createElement('canvas');
  off.width = dim;
  off.height = dim;
  const octx = off.getContext('2d');
  octx.drawImage(video, 0, 0, dim, dim);

  const mask = document.createElement('canvas');
  mask.width = dim;
  mask.height = dim;
  const mctx = mask.getContext('2d');
  const grad = mctx.createRadialGradient(
    dim / 2, dim / 2, dim * 0.12,
    dim / 2, dim / 2, dim * 0.5,
  );
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  mctx.fillStyle = grad;
  mctx.beginPath();
  mctx.ellipse(dim / 2, dim / 2, rw, rh, 0, 0, Math.PI * 2);
  mctx.fill();

  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(mask, 0, 0);

  ctx.drawImage(off, x, y);
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
