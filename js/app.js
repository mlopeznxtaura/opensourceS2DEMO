/* ===================================================
   opensourceS2DEMO — screen + audio + composited PiP + voice plan export
   =================================================== */

import { createCompositor } from './compositor.js';
import {
  buildMeetingNotes,
  buildVttFromCues,
  downloadText,
  downloadActionPlanPdf,
  buildTranscript,
} from './plan-export.js';
import { loadSessionBackground } from './webcam-bg.js';
import { resetSession } from './session.js';

const $ = id => document.getElementById(id);

// ── State ──────────────────────────────────────────
let mediaRecorder  = null;
let recordedChunks = [];
let screenStream   = null;
let micStream      = null;
let webcamStream   = null;
let mixedStream    = null;
let timerInterval  = null;
let pauseStart     = null;
let totalPaused    = 0;
let startTime      = null;
let webcamPos      = 'bottom-right';
let compositor     = null;
let pendingExport  = null;
let captureCardStream = null;

// Session-only (wiped after export — never persisted)
let sessionBgImage = null;
let sessionBgUrl   = null;

// Hidden capture elements (compositor sources)
const screenCapture = document.createElement('video');
screenCapture.muted = true;
screenCapture.playsInline = true;
const webcamCapture = document.createElement('video');
webcamCapture.muted = true;
webcamCapture.playsInline = true;
const composeCanvas = $('composeCanvas');

// ── DOM refs ───────────────────────────────────────
const recordBtn      = $('recordBtn');
const pauseBtn       = $('pauseBtn');
const timerDisplay   = $('timerDisplay');
const statusText     = $('statusText');
const statusInd      = $('statusIndicator');
const screenPreview  = $('screenPreview');
const webcamPip      = $('webcamPip');
const previewIdle    = $('previewIdle');
const previewContainer = $('previewContainer');
const webcamToggle   = $('webcamToggle');
const webcamOptions  = $('webcamOptions');
const micAudioChk    = $('micAudio');
const micSelectRow   = $('micSelectRow');
const camSizeSlider  = $('camSize');
const camSizeVal     = $('camSizeVal');
const exportModal    = $('exportModal');
const captureCardRow = $('captureCardRow');
const bgImageRow     = $('bgImageRow');
const blurAmountRow  = $('blurAmountRow');
const bgImageInput   = $('bgImageInput');

compositor = createCompositor({
  screenVideo: screenCapture,
  webcamVideo: webcamCapture,
  canvas: composeCanvas,
});

// ── Init: enumerate devices ────────────────────────
async function enumerateDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .catch(() => null);
    if (tmp) tmp.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const cams = devices.filter(d => d.kind === 'videoinput');
    const micSel = $('micSelect');
    const camSel = $('camSelect');

    mics.forEach((mic, i) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.text  = mic.label || `Microphone ${i + 1}`;
      micSel.appendChild(opt);
    });

    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.text  = cam.label || `Camera ${i + 1}`;
      camSel.appendChild(opt);
    });

    const capSel = $('captureCardSelect');
    if (capSel) {
      cams.forEach((cam, i) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.text  = cam.label || `Video input ${i + 1}`;
        capSel.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn('Device enumeration failed:', e);
  }
}

enumerateDevices();

// ── Capture source mode ────────────────────────────
document.querySelectorAll('input[name="source"]').forEach(r => {
  r.addEventListener('change', () => {
    const isCapture = r.value === 'capturecard' && r.checked;
    captureCardRow?.classList.toggle('hidden', !isCapture);
    const sysRow = $('systemAudio')?.closest('.toggle-row');
    if (isCapture) {
      $('systemAudio').checked = false;
      if (sysRow) sysRow.style.opacity = '0.45';
    } else if (sysRow) {
      sysRow.style.opacity = '1';
    }
  });
});

// ── Webcam background (session-only) ───────────────
function getBgMode() {
  return document.querySelector('input[name="bgMode"]:checked')?.value || 'none';
}

function syncCompositorBackground() {
  compositor.setWebcamBackground({
    mode: getBgMode(),
    bgImage: getBgMode() === 'image' ? sessionBgImage : null,
    blurPx: parseInt($('blurAmount')?.value || '18', 10),
  });
}

document.querySelectorAll('input[name="bgMode"]').forEach(r => {
  r.addEventListener('change', () => {
    const mode = getBgMode();
    bgImageRow?.classList.toggle('hidden', mode !== 'image');
    blurAmountRow?.classList.toggle('hidden', mode !== 'blur');
    syncCompositorBackground();
  });
});

$('blurAmount')?.addEventListener('input', () => {
  $('blurAmountVal').textContent = $('blurAmount').value + 'px';
  syncCompositorBackground();
});

bgImageInput?.addEventListener('change', async () => {
  revokeSessionBackground();
  const file = bgImageInput.files?.[0];
  if (!file) return;
  try {
    const { img, url } = await loadSessionBackground(file);
    sessionBgImage = img;
    sessionBgUrl = url;
    $('bgFileName').textContent = file.name;
    const prev = $('bgPreview');
    if (prev) {
      prev.src = url;
      prev.classList.remove('hidden');
    }
    const imgRadio = document.querySelector('input[name="bgMode"][value="image"]');
    if (imgRadio) imgRadio.checked = true;
    bgImageRow?.classList.remove('hidden');
    blurAmountRow?.classList.add('hidden');
    syncCompositorBackground();
  } catch (e) {
    alert('Could not load background image: ' + e.message);
  }
});

function revokeSessionBackground() {
  if (sessionBgUrl) {
    URL.revokeObjectURL(sessionBgUrl);
    sessionBgUrl = null;
  }
  sessionBgImage = null;
}

function wipeSession() {
  resetSession({
    revokeBg: revokeSessionBackground,
    clearPendingExport: () => {
      pendingExport = null;
    },
    captionCues,
    recordedChunks,
    fileInputs: [bgImageInput],
  });
  syncCompositorBackground();
}

// ── Webcam toggle ──────────────────────────────────
webcamToggle.addEventListener('change', async () => {
  if (webcamToggle.checked) {
    webcamOptions.style.display = 'flex';
    await startWebcamPreview();
  } else {
    webcamOptions.style.display = 'none';
    stopWebcamPreview();
  }
});

webcamOptions.style.display = 'none';

$('camSelect').addEventListener('change', async () => {
  if (webcamToggle.checked) {
    stopWebcamPreview();
    await startWebcamPreview();
  }
});

$('micSelect').addEventListener('change', () => {});

async function ensureWebcamStream() {
  if (webcamStream) return webcamStream;
  const camId = $('camSelect').value;
  webcamStream = await navigator.mediaDevices.getUserMedia({
    video: camId ? { deviceId: { exact: camId } } : true,
    audio: false,
  });
  return webcamStream;
}

async function startWebcamPreview() {
  try {
    await ensureWebcamStream();
    webcamPip.srcObject = webcamStream;
    webcamCapture.srcObject = webcamStream;
    await webcamCapture.play().catch(() => {});
    webcamPip.classList.remove('hidden');
    applyWebcamPos(webcamPos);
    applyWebcamSize(parseInt(camSizeSlider.value));
    syncCompositorPip();
    syncCompositorBackground();
    setStatus('ready', 'Ready');
  } catch (e) {
    alert('Could not access webcam: ' + e.message);
    webcamToggle.checked = false;
    webcamOptions.style.display = 'none';
  }
}

function stopWebcamPreview() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  webcamPip.srcObject = null;
  webcamCapture.srcObject = null;
  webcamPip.classList.add('hidden');
}

function syncCompositorPip() {
  compositor.setPipFromElement(webcamPip, previewContainer);
}

document.querySelectorAll('.pos-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    webcamPos = btn.dataset.pos;
    applyWebcamPos(webcamPos);
    syncCompositorPip();
  });
});

function applyWebcamPos(pos) {
  webcamPip.style.left = webcamPip.style.top = webcamPip.style.right = webcamPip.style.bottom = 'auto';
  webcamPip.className = webcamPip.className.replace(/pos-\S+/g, '').trim();
  webcamPip.classList.add(`pos-${pos}`);
  webcamPip.classList.remove('hidden');
  syncCompositorPip();
}

camSizeSlider.addEventListener('input', () => {
  const v = parseInt(camSizeSlider.value);
  camSizeVal.textContent = v + 'px';
  applyWebcamSize(v);
  syncCompositorPip();
});

function applyWebcamSize(size) {
  webcamPip.style.width  = size + 'px';
  webcamPip.style.height = size + 'px';
  syncCompositorPip();
}

let dragging = false, dragOffX = 0, dragOffY = 0;

webcamPip.addEventListener('mousedown', e => {
  dragging = true;
  const rect = webcamPip.getBoundingClientRect();
  dragOffX = e.clientX - rect.left;
  dragOffY = e.clientY - rect.top;
  webcamPip.style.transition = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const container = previewContainer.getBoundingClientRect();
  let x = e.clientX - container.left - dragOffX;
  let y = e.clientY - container.top  - dragOffY;
  const size = parseInt(webcamPip.style.width) || 160;
  x = Math.max(0, Math.min(x, container.width  - size));
  y = Math.max(0, Math.min(y, container.height - size));
  webcamPip.style.left   = x + 'px';
  webcamPip.style.top    = y + 'px';
  webcamPip.style.right  = 'auto';
  webcamPip.style.bottom = 'auto';
  syncCompositorPip();
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    webcamPip.style.transition = '';
    syncCompositorPip();
  }
});

// ── Auto captions ──────────────────────────────────
const captionsToggle = $('captionsToggle');
const liveCaption    = $('liveCaption');
const captionStatus  = $('captionStatus');
const SpeechRec      = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition    = null;
let captionCues    = [];
let captionsActive = false;
let interimStart   = null;
let currentCaption = '';

if (!SpeechRec && captionsToggle) {
  captionsToggle.disabled = true;
  if (captionStatus) captionStatus.textContent = 'Not supported in this browser — use Chrome or Edge.';
}

captionsToggle?.addEventListener('change', () => {
  if (captionsToggle.checked) {
    if (!SpeechRec) {
      captionsToggle.checked = false;
      return;
    }
    if (!micAudioChk.checked) {
      micAudioChk.checked = true;
      micSelectRow.style.display = 'block';
    }
    if (captionStatus) captionStatus.textContent = 'Captions use your microphone during recording.';
  } else if (captionStatus) {
    captionStatus.textContent = '';
  }
});

function recordingClock() {
  let paused = totalPaused;
  if (pauseStart && mediaRecorder && mediaRecorder.state === 'paused') {
    paused += Date.now() - pauseStart;
  }
  return Date.now() - startTime - paused;
}

function updateLiveCaption(text) {
  currentCaption = text || '';
  compositor.setCaption(currentCaption);
  if (!text) {
    liveCaption.classList.add('hidden');
    liveCaption.textContent = '';
    return;
  }
  liveCaption.textContent = text;
  liveCaption.classList.remove('hidden');
}

function startCaptions() {
  if (!SpeechRec || !captionsToggle?.checked) return;

  if (!micAudioChk.checked) {
    micAudioChk.checked = true;
    micSelectRow.style.display = 'block';
  }

  captionCues  = [];
  interimStart = null;
  captionsActive = true;
  currentCaption = '';

  recognition = new SpeechRec();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = navigator.language || 'en-US';

  recognition.onresult = e => {
    if (mediaRecorder && mediaRecorder.state === 'paused') return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res  = e.results[i];
      const text = res[0].transcript.trim();
      if (!text) continue;
      if (interimStart === null) interimStart = recordingClock();
      if (res.isFinal) {
        captionCues.push({
          start: Math.max(0, interimStart),
          end:   Math.max(0, recordingClock()),
          text,
        });
        interimStart = null;
      } else {
        interim += text + ' ';
      }
    }
    const lastFinal = captionCues.length ? captionCues[captionCues.length - 1].text : '';
    const display = interim.trim() || lastFinal;
    updateLiveCaption(display);
  };

  recognition.onend = () => {
    if (captionsActive) {
      setTimeout(() => {
        if (!captionsActive) return;
        try { recognition.start(); } catch (_) {}
      }, 250);
    }
  };

  recognition.onerror = e => {
    console.warn('Caption error:', e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      captionsActive = false;
      if (captionStatus) captionStatus.textContent = 'Mic permission required for captions.';
      captionsToggle.checked = false;
    } else if (e.error === 'no-speech' && captionStatus) {
      captionStatus.textContent = 'Listening… speak into your microphone.';
    } else if (captionStatus && e.error !== 'aborted') {
      captionStatus.textContent = `Caption issue: ${e.error}`;
    }
  };

  try {
    recognition.start();
    if (captionStatus) captionStatus.textContent = 'Captions active — listening…';
  } catch (err) {
    console.warn('Could not start captions:', err);
    captionsActive = false;
  }
}

function stopCaptions() {
  captionsActive = false;
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
    recognition = null;
  }
  updateLiveCaption('');
}

// ── Mic toggle ──────────────────────────────────────
micAudioChk.addEventListener('change', () => {
  micSelectRow.style.display = micAudioChk.checked ? 'block' : 'none';
  if (!micAudioChk.checked && captionsToggle?.checked) {
    captionsToggle.checked = false;
    if (captionStatus) captionStatus.textContent = 'Captions require microphone.';
  }
});

// ── Record button ──────────────────────────────────
recordBtn.addEventListener('click', () => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') startRecording();
  else stopRecording();
});

pauseBtn.addEventListener('click', () => {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    pauseStart = Date.now();
    setStatus('paused', 'Paused');
    pauseBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Resume`;
  } else if (mediaRecorder.state === 'paused') {
    totalPaused += Date.now() - pauseStart;
    mediaRecorder.resume();
    setStatus('recording', 'Recording');
    pauseBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
  }
});

async function startRecording() {
  try {
    recordedChunks = [];
    syncCompositorBackground();

    const sourceValue = document.querySelector('input[name="source"]:checked').value;
    const audioTracks = [];

    if (sourceValue === 'capturecard') {
      const devId = $('captureCardSelect').value;
      if (!devId) {
        alert('Select a capture card / HDMI input first.');
        return;
      }
      const wantCapAudio = $('captureCardAudio')?.checked;
      captureCardStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: devId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: wantCapAudio,
      });
      screenStream = captureCardStream;
      if (wantCapAudio) {
        captureCardStream.getAudioTracks().forEach(t => audioTracks.push(t));
      }
    } else {
      const captureOpts = {
        video: { cursor: 'always' },
        audio: $('systemAudio').checked,
      };
      if (sourceValue === 'tab') captureOpts.preferCurrentTab = true;
      screenStream = await navigator.mediaDevices.getDisplayMedia(captureOpts);
      screenStream.getAudioTracks().forEach(t => audioTracks.push(t));
    }

    if (micAudioChk.checked) {
      try {
        const micId = $('micSelect').value;
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { deviceId: { exact: micId } } : true,
          video: false,
        });
        micStream.getAudioTracks().forEach(t => audioTracks.push(t));
      } catch (e) {
        console.warn('Mic not available:', e);
        if (captionsToggle?.checked) {
          alert('Microphone is required for captions. Enable mic or turn off captions.');
          captionsToggle.checked = false;
        }
      }
    } else if (captionsToggle?.checked) {
      alert('Captions require microphone — enabling mic.');
      micAudioChk.checked = true;
      micSelectRow.style.display = 'block';
      return startRecording();
    }

    // Screen video for compositor (not raw mixed stream)
    const screenVideoOnly = new MediaStream(screenStream.getVideoTracks());
    screenCapture.srcObject = screenVideoOnly;
    await screenCapture.play();

    if (webcamToggle.checked) {
      if (!webcamStream) await startWebcamPreview();
      webcamCapture.srcObject = webcamStream;
      await webcamCapture.play().catch(() => {});
      webcamPip.srcObject = webcamStream;
      webcamPip.classList.remove('hidden');
      syncCompositorPip();
    }

    compositor.start();

    const canvasStream = composeCanvas.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];

    if (audioTracks.length > 0) {
      if (audioTracks.length === 1) {
        tracks.push(audioTracks[0]);
      } else {
        const ctx  = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        audioTracks.forEach(t => {
          ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
        });
        dest.stream.getAudioTracks().forEach(t => tracks.push(t));
      }
    }

    mixedStream = new MediaStream(tracks);

    // Preview shows composited canvas (webcam + captions appear on shared content)
    screenPreview.classList.remove('active');
    composeCanvas.classList.remove('hidden');
    previewIdle.classList.add('hidden');

    const mimeType = getSupportedMime();
    mediaRecorder = new MediaRecorder(mixedStream, {
      mimeType,
      videoBitsPerSecond: getVideoBitrate(),
    });

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = saveRecording;
    mediaRecorder.start(1000);

    startTime   = Date.now();
    totalPaused = 0;
    if (captionsToggle?.checked) startCaptions();
    startTimer();
    setStatus('recording', 'Recording');
    recordBtn.innerHTML = `<span class="btn-record-dot"></span> Stop Recording`;
    recordBtn.classList.add('recording');
    pauseBtn.disabled = false;

    screenStream.getVideoTracks()[0].onended = stopRecording;
  } catch (e) {
    console.error('Recording failed:', e);
    if (e.name !== 'NotAllowedError') alert('Could not start recording: ' + e.message);
    cleanup();
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  stopCaptions();
  compositor.stop();
  stopTimer();
  setStatus('ready', 'Ready');
  recordBtn.innerHTML = `<span class="btn-record-dot"></span> Start Recording`;
  recordBtn.classList.remove('recording');
  pauseBtn.disabled = true;
  pauseBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
}

function saveRecording() {
  if (recordedChunks.length === 0) { cleanup(); return; }

  const mimeType = getSupportedMime();
  const ext      = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const blob     = new Blob(recordedChunks, { type: mimeType });
  const basename = `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const durationMs = startTime ? recordingClock() : 0;
  const cues = [...captionCues];

  pendingExport = { blob, mimeType, ext, basename, cues, durationMs };
  showExportModal();
  recordedChunks = [];
}

function showExportModal() {
  if (!pendingExport) return;
  const { cues, durationMs } = pendingExport;
  const transcript = buildTranscript(cues);
  const preview = $('exportPreview');
  if (preview) {
    preview.textContent = transcript
      ? transcript.slice(0, 280) + (transcript.length > 280 ? '…' : '')
      : 'No speech captured. Enable Auto Captions + microphone to generate meeting notes and action plans.';
  }
  const durEl = $('exportDuration');
  if (durEl) durEl.textContent = durationMs ? formatTime(Math.floor(durationMs / 1000)) : '—';
  exportModal.classList.remove('hidden');
}

function hideExportModal() {
  exportModal.classList.add('hidden');
  cleanup();
  wipeSession();
}

function downloadVideo() {
  if (!pendingExport) return;
  const { blob, ext, basename } = pendingExport;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${basename}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$('exportConfirm')?.addEventListener('click', () => {
  if (!pendingExport) return;
  const { cues, basename, durationMs, ext } = pendingExport;
  const wantVideo  = $('exportVideo')?.checked;
  const wantNotes  = $('exportNotes')?.checked;
  const wantPdf    = $('exportPdf')?.checked;
  const wantVtt    = $('exportVtt')?.checked;

  if (wantVideo) downloadVideo();

  const meta = {
    title: 'Meeting Notes — opensourceS2DEMO',
    recordedAt: new Date().toLocaleString(),
    durationMs,
    basename,
  };

  if (wantNotes) {
    downloadText(`${basename}-meeting-notes.md`, buildMeetingNotes(cues, meta));
  }

  if (wantPdf) {
    if (window.jspdf?.jsPDF) {
      downloadActionPlanPdf({ cues, meta, jsPDF: window.jspdf.jsPDF });
    } else {
      alert('PDF library not loaded. Meeting notes (.md) still available.');
    }
  }

  if (wantVtt && cues.length) {
    downloadText(`${basename}.vtt`, buildVttFromCues(cues), 'text/vtt');
  }

  exportModal.classList.add('hidden');
  cleanup();
  wipeSession();
});

$('exportCancel')?.addEventListener('click', hideExportModal);
exportModal?.addEventListener('click', e => {
  if (e.target === exportModal) hideExportModal();
});

function cleanup() {
  compositor?.stop();
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (captureCardStream) { captureCardStream.getTracks().forEach(t => t.stop()); captureCardStream = null; }
  if (micStream)    { micStream.getTracks().forEach(t => t.stop());    micStream    = null; }
  screenCapture.srcObject = null;
  composeCanvas.classList.add('hidden');
  screenPreview.srcObject = null;
  screenPreview.classList.remove('active');
  pendingExport = null;
  if (!webcamToggle.checked) {
    webcamPip.classList.add('hidden');
    previewIdle.classList.remove('hidden');
  } else {
    previewIdle.classList.add('hidden');
  }
}

function startTimer() {
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime - totalPaused) / 1000);
    timerDisplay.textContent = formatTime(elapsed);
  }, 500);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerDisplay.textContent = '00:00:00';
}

function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

function setStatus(state, text) {
  statusInd.className  = 'status-indicator ' + state;
  statusText.textContent = text;
}

function getSupportedMime() {
  const types = [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

function getVideoBitrate() {
  const q = document.querySelector('input[name="quality"]:checked').value;
  return q === '4k' ? 20_000_000 : q === '1080' ? 8_000_000 : 4_000_000;
}

setStatus('', 'Ready');
