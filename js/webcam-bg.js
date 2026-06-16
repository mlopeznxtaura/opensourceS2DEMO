/* Webcam PiP — circular crop for compositor burn-in */

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

export function drawWebcamPip(ctx, video, x, y, dim) {
  const cx = x + dim / 2;
  const cy = y + dim / 2;
  const r = dim / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const { sx, sy, side } = squareVideoCrop(video);
  ctx.drawImage(video, sx, sy, side, side, x, y, dim, dim);

  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(2, dim * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.stroke();
}
