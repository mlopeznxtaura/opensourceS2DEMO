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
  video.controls = false;
  video.disablePictureInPicture = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
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
let hdmiMonitorCtx = null;
let hdmiMonitorNodes = [];

function isHdmiCaptureAudioLabel(label) {
  const l = (label || '').toLowerCase();
  return /digital audio|hdmi|capture|line in|interface|ccd10|nearstream|gc3101/.test(l)
    && !/webcam|microphone array|headset/.test(l);
}

/** Hear HDMI in speakers using a cloned track — does not block mic or recording. */
export async function startHdmiAudioMonitor(tracks) {
  stopHdmiAudioMonitor();
  const live = (tracks || []).filter(t => t.readyState === 'live');
  if (!live.length) return false;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;

  hdmiMonitorCtx = hdmiMonitorCtx || new Ctx();
  if (hdmiMonitorCtx.state === 'suspended') await hdmiMonitorCtx.resume();

  const clones = live.map(t => t.clone());
  const source = hdmiMonitorCtx.createMediaStreamSource(new MediaStream(clones));
  const gain = hdmiMonitorCtx.createGain();
  gain.gain.value = 1;
  source.connect(gain);
  gain.connect(hdmiMonitorCtx.destination);
  hdmiMonitorNodes.push({ source, gain, clones });
  return true;
}

export function stopHdmiAudioMonitor() {
  hdmiMonitorNodes.forEach(({ source, gain, clones }) => {
    try { source.disconnect(); gain.disconnect(); } catch (_) {}
    clones.forEach(t => { try { t.stop(); } catch (_) {} });
  });
  hdmiMonitorNodes = [];
}

export async function resumeAudioContexts() {
  if (hdmiMonitorCtx?.state === 'suspended') await hdmiMonitorCtx.resume();
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

export async function mixAudioTracks(tracks) {
  const live = (tracks || []).filter(t => t && t.readyState === 'live');
  if (!live.length) return [];
  if (live.length === 1) return [live[0].clone()];

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return live.map(t => t.clone());

  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const dest = audioCtx.createMediaStreamDestination();
  live.forEach(track => {
    try {
      const clone = track.clone();
      audioCtx.createMediaStreamSource(new MediaStream([clone])).connect(dest);
    } catch (err) {
      console.warn('Skipped audio track in mix:', err);
    }
  });
  return dest.stream.getAudioTracks();
}

/** Mic for voice — never grabs the HDMI capture audio device. */
export async function openMicStream(micDeviceId, excludeDeviceIds = []) {
  const processing = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const exclude = new Set((excludeDeviceIds || []).filter(Boolean));

  const attempts = [];
  if (micDeviceId && !exclude.has(micDeviceId)) {
    attempts.push({ audio: { deviceId: { exact: micDeviceId }, ...processing }, video: false });
    attempts.push({ audio: { deviceId: { ideal: micDeviceId }, ...processing }, video: false });
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const d of devices.filter(x => x.kind === 'audioinput' && x.deviceId)) {
    if (exclude.has(d.deviceId)) continue;
    if (isHdmiCaptureAudioLabel(d.label)) continue;
    attempts.push({ audio: { deviceId: { ideal: d.deviceId }, ...processing }, video: false });
  }

  attempts.push({ audio: processing, video: false });

  let lastErr;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0];
      const devId = track?.getSettings?.().deviceId;
      if ((devId && exclude.has(devId)) || isHdmiCaptureAudioLabel(track?.label)) {
        track?.stop();
        continue;
      }
      track.enabled = true;
      return stream;
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }
  throw lastErr || new Error('Microphone unavailable');
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

export function getDisplayMediaOptions(_sourceValue, includeSystemAudio) {
  if (isSafari || isIOS) {
    return {
      video: true,
      audio: !!includeSystemAudio,
    };
  }
  // Screen, window, and tab all use the same browser share picker.
  return {
    video: { cursor: 'always' },
    audio: !!includeSystemAudio,
  };
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

  const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
  if (!audioInputs.length) return null;

  if (video.groupId) {
    const mate = audioInputs.find(d => d.groupId === video.groupId);
    if (mate) return mate;
  }

  const vLabel = video.label.toLowerCase();
  const usbMatch = video.label.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i);
  if (usbMatch) {
    const mate = audioInputs.find(a => a.label.toLowerCase().includes(usbMatch[1].toLowerCase()));
    if (mate) return mate;
  }

  const stem = video.label.split('(')[0].trim().toLowerCase();
  if (stem.length > 2) {
    const mate = audioInputs.find(a => a.label.toLowerCase().includes(stem));
    if (mate) return mate;
  }

  for (const word of stem.split(/[\s_-]+/).filter(w => w.length > 3)) {
    const mate = audioInputs.find(a => a.label.toLowerCase().includes(word));
    if (mate) return mate;
  }

  if (/nearstream|ccd10|gc3101|hdmi|capture|elgato|avermedia|cam link/i.test(vLabel)) {
    const hdmiAudio = audioInputs.filter(a => {
      const al = a.label.toLowerCase();
      return /digital audio|hdmi|capture|line in|interface|mux|ccd10|nearstream|gc3101/.test(al)
        && !/webcam|microphone array|mic \(|headset|realtek audio/.test(al);
    });
    if (hdmiAudio.length === 1) return hdmiAudio[0];
    if (hdmiAudio.length > 1) {
      for (const word of ['nearstream', 'ccd10', 'gc3101', 'digital audio']) {
        const mate = hdmiAudio.find(a => a.label.toLowerCase().includes(word));
        if (mate) return mate;
      }
      return hdmiAudio[0];
    }
  }

  return null;
}

function captureAudioProcessing() {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
  };
}

async function openVideoOnlyStream(videoDeviceId) {
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
      return await navigator.mediaDevices.getUserMedia({ video: videoExact, audio: false });
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
    const videoIdeal = video === true
      ? { deviceId: { ideal: videoDeviceId } }
      : { deviceId: { ideal: videoDeviceId }, ...video };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoIdeal, audio: false });
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }
  throw lastErr || new Error('Could not open capture card video');
}

async function attachHdmiAudio(videoStream, videoDeviceId, audioDeviceId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const paired = audioDeviceId
    ? devices.find(d => d.deviceId === audioDeviceId && d.kind === 'audioinput')
    : findPairedAudioDevice(videoDeviceId, devices);

  const pairedId = paired?.deviceId || audioDeviceId || null;
  const processing = captureAudioProcessing();
  const attempts = pairedId
    ? [
        { ...processing, deviceId: { exact: pairedId } },
        { ...processing, deviceId: { ideal: pairedId } },
      ]
    : [processing];

  let lastErr;
  for (const audio of attempts) {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      audioStream.getAudioTracks().forEach(track => {
        track.enabled = true;
        videoStream.addTrack(track);
      });
      return { pairedLabel: paired?.label || audioStream.getAudioTracks()[0]?.label || '' };
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
    }
  }

  console.warn('HDMI audio could not be opened:', lastErr, paired?.label);
  return { pairedLabel: paired?.label || '', error: lastErr };
}

/**
 * Open capture-card video, then bind HDMI audio on a separate track (Windows-friendly).
 */
export async function getCaptureCardStream(videoDeviceId, { audio = false, audioDeviceId = null } = {}) {
  if (!videoDeviceId) throw new Error('Select a capture card device first.');

  const videoStream = await openVideoOnlyStream(videoDeviceId);
  if (!audio) return videoStream;

  const { pairedLabel, error } = await attachHdmiAudio(videoStream, videoDeviceId, audioDeviceId);
  if (!videoStream.getAudioTracks().length) {
    console.warn('Capture card video OK but HDMI audio unavailable:', error, pairedLabel);
  }
  return videoStream;
}
