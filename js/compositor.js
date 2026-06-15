/* Canvas compositor — screen + webcam PiP + captions into one video stream */

import { drawWebcamWithBackground } from './webcam-bg.js';

export function createCompositor({ screenVideo, webcamVideo, canvas }) {
  const ctx = canvas.getContext('2d');
  let rafId = null;
  let pip = { x: 0.82, y: 0.82, size: 0.14 };
  let captionText = '';
  let webcamBg = { mode: 'none', bgImage: null, blurPx: 18 };

  function setWebcamBackground(opts) {
    webcamBg = { ...webcamBg, ...opts };
  }

  function setPipFromElement(pipEl, containerEl) {
    if (!pipEl || !containerEl || pipEl.classList.contains('hidden')) return;
    const c = containerEl.getBoundingClientRect();
    const p = pipEl.getBoundingClientRect();
    if (!c.width || !c.height) return;
    const size = Math.max(p.width, p.height) / Math.min(c.width, c.height);
    pip = {
      x: (p.left - c.left + p.width / 2) / c.width,
      y: (p.top - c.top + p.height / 2) / c.height,
      size: Math.max(0.06, Math.min(0.35, size)),
    };
  }

  function setCaption(text) {
    captionText = (text || '').trim();
  }

  function letterbox(srcW, srcH, dstW, dstH) {
    const scale = Math.min(dstW / srcW, dstH / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h, scale };
  }

  function drawFrame() {
    const vw = screenVideo.videoWidth || 1280;
    const vh = screenVideo.videoHeight || 720;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);

    if (screenVideo.readyState >= 2) {
      ctx.drawImage(screenVideo, 0, 0, vw, vh);
    }

    const camOn = webcamVideo && webcamVideo.srcObject && webcamVideo.readyState >= 2;
    if (camOn && webcamVideo.videoWidth > 0) {
      const dim = Math.min(vw, vh) * pip.size;
      const cx = pip.x * vw;
      const cy = pip.y * vh;
      const x = Math.max(dim / 2, Math.min(vw - dim / 2, cx)) - dim / 2;
      const y = Math.max(dim / 2, Math.min(vh - dim / 2, cy)) - dim / 2;

      ctx.save();
      drawWebcamWithBackground(ctx, webcamVideo, x, y, dim, {
        mode: webcamBg.mode,
        bgImage: webcamBg.bgImage,
        blurPx: webcamBg.blurPx,
      });
      ctx.restore();
    }

    if (captionText) {
      const pad = Math.max(12, vw * 0.012);
      const fontSize = Math.max(16, Math.round(vh * 0.028));
      ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
      const maxW = vw * 0.82;
      const lines = wrapText(ctx, captionText, maxW);
      const lineH = fontSize * 1.35;
      const boxH = lines.length * lineH + pad * 2;
      const boxY = vh - boxH - pad * 2;
      const boxX = (vw - maxW) / 2 - pad;

      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      roundRect(ctx, boxX, boxY, maxW + pad * 2, boxH, 8);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      lines.forEach((line, i) => {
        ctx.fillText(line, vw / 2, boxY + pad + fontSize + i * lineH);
      });
    }

    rafId = requestAnimationFrame(drawFrame);
  }

  function start() {
    stop();
    rafId = requestAnimationFrame(drawFrame);
  }

  function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  return { start, stop, setPipFromElement, setCaption, setWebcamBackground, getPip: () => ({ ...pip }) };
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
