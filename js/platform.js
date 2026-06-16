/* Safari / iOS compatibility helpers — no-op on Chrome/Edge when APIs match. */

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isSafari = (
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  || (isIOS && !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(navigator.userAgent))
);

export function supportsDisplayCapture() {
  return !!(navigator.mediaDevices?.getDisplayMedia);
}

export function supportsMediaRecorderPause() {
  return typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.prototype.pause === 'function';
}

export function prepareVideoElement(video) {
  if (!video) return;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
}

export async function playVideo(video) {
  prepareVideoElement(video);
  try {
    await video.play();
  } catch (_) {
    await new Promise(resolve => {
      if (video.readyState >= 2) { resolve(); return; }
      video.addEventListener('loadedmetadata', resolve, { once: true });
    });
    await video.play().catch(() => {});
  }
}

export async function waitForVideoFrame(video, timeoutMs = 8000) {
  if (video.videoWidth > 0 && video.readyState >= 2) return;
  await Promise.race([
    new Promise((resolve, reject) => {
      const check = () => {
        if (video.videoWidth > 0 && video.readyState >= 2) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('playing', check);
        video.removeEventListener('resize', check);
      };
      video.addEventListener('loadeddata', check);
      video.addEventListener('playing', check);
      video.addEventListener('resize', check);
      check();
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Camera or screen preview did not start')), timeoutMs);
    }),
  ]);
}

let audioCtx = null;

export async function mixAudioTracks(tracks) {
  if (!tracks.length) return [];
  if (tracks.length === 1) return [tracks[0]];

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return [tracks[0]];

  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const dest = audioCtx.createMediaStreamDestination();
  tracks.forEach(track => {
    try {
      audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest);
    } catch (err) {
      console.warn('Skipped audio track in mix:', err);
    }
  });
  return dest.stream.getAudioTracks();
}

export async function getUserMediaVideo(deviceId, { audio = false } = {}) {
  const attempts = deviceId
    ? [
        { video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio },
        { video: { deviceId: { ideal: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio },
        { video: { deviceId: { ideal: deviceId } }, audio },
        { video: { facingMode: 'environment' }, audio },
        { video: true, audio },
      ]
    : [
        { video: { facingMode: 'user' }, audio },
        { video: true, audio },
      ];

  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }
  throw lastErr || new Error('Could not open video device');
}

export function getDisplayMediaOptions(sourceValue, includeSystemAudio) {
  if (isSafari || isIOS) {
    return {
      video: true,
      audio: !!includeSystemAudio,
    };
  }
  const opts = {
    video: { cursor: 'always' },
    audio: !!includeSystemAudio,
  };
  if (sourceValue === 'tab') opts.preferCurrentTab = true;
  return opts;
}

export function getRecorderMimeTypes() {
  if (isSafari || isIOS) {
    return [
      'video/mp4',
      'video/mp4;codecs="avc1,mp4a.40.2"',
      'video/mp4;codecs=avc1',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
  }
  return [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
}

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of getRecorderMimeTypes()) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch (_) {}
  }
  return '';
}

export function createRecorder(stream, bitrate) {
  const preferred = pickMimeType();
  const options = {};
  if (preferred) options.mimeType = preferred;
  if (bitrate && !isIOS) options.videoBitsPerSecond = bitrate;

  try {
    const recorder = Object.keys(options).length
      ? new MediaRecorder(stream, options)
      : new MediaRecorder(stream);
    const mimeType = recorder.mimeType || preferred || 'video/mp4';
    return { recorder, mimeType };
  } catch (err) {
    const recorder = new MediaRecorder(stream);
    return { recorder, mimeType: recorder.mimeType || preferred || 'video/mp4' };
  }
}

export function canvasCaptureFps() {
  return (isIOS || isSafari) ? 15 : 30;
}

export function mimeToExtension(mimeType) {
  if ((mimeType || '').includes('mp4')) return 'mp4';
  return 'webm';
}

export async function requestVideoPermission() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach(t => t.stop());
    return true;
  } catch (_) {
    return false;
  }
}

/** HDMI capture cards usually expose audio on a sibling audioinput (same groupId / label). */
export function findPairedAudioDevice(videoDeviceId, devices) {
  const video = devices.find(d => d.deviceId === videoDeviceId && d.kind === 'videoinput');
  if (!video) return null;

  if (video.groupId) {
    const mate = devices.find(
      d => d.kind === 'audioinput' && d.groupId === video.groupId && d.deviceId,
    );
    if (mate) return mate;
  }

  const stem = video.label.split('(')[0].trim().toLowerCase();
  if (stem.length > 2) {
    const mate = devices.find(
      d => d.kind === 'audioinput'
        && d.deviceId
        && d.label.toLowerCase().includes(stem),
    );
    if (mate) return mate;
  }

  return null;
}

function captureAudioConstraints(audioDeviceId) {
  const processing = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (audioDeviceId) {
    return { deviceId: { ideal: audioDeviceId }, ...processing };
  }
  return processing;
}

/**
 * Open a capture-card / HDMI input. Binds HDMI audio to the capture hardware,
 * not the default microphone (audio: true alone is wrong for Chromecast-in-HDMI).
 */
export async function getCaptureCardStream(videoDeviceId, { audio = false, audioDeviceId = null } = {}) {
  if (!videoDeviceId) throw new Error('Select a capture card device first.');

  const devices = await navigator.mediaDevices.enumerateDevices();
  const paired = audio && !audioDeviceId
    ? findPairedAudioDevice(videoDeviceId, devices)
    : null;
  const audioId = audioDeviceId || paired?.deviceId || null;
  const audioC = audio ? captureAudioConstraints(audioId) : false;

  const videoAttempts = [
    { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    { width: { ideal: 1280 }, height: { ideal: 720 } },
    true,
  ];

  let lastErr;
  for (const video of videoAttempts) {
    const videoExact = video === true
      ? { deviceId: { exact: videoDeviceId } }
      : { deviceId: { exact: videoDeviceId }, ...video };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoExact, audio: audioC });
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
    const videoIdeal = video === true
      ? { deviceId: { ideal: videoDeviceId } }
      : { deviceId: { ideal: videoDeviceId }, ...video };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoIdeal, audio: audioC });
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }

  if (audio) {
    for (const video of videoAttempts) {
      const videoIdeal = video === true
        ? { deviceId: { ideal: videoDeviceId } }
        : { deviceId: { ideal: videoDeviceId }, ...video };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: videoIdeal, audio: false });
        console.warn('Capture card video OK but HDMI audio unavailable:', lastErr);
        return stream;
      } catch (err) {
        lastErr = err;
      }
    }
  }

  throw lastErr || new Error('Could not open capture card');
}
