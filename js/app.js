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
  mergeExportCues,
} from './plan-export.js';
import { loadSessionBackground } from './webcam-bg.js';
import {
  startSegmentationLoop,
  stopSegmentationLoop,
  disposeSegmenter,
  setSegmentationOptions,
  getSegmentationStatus,
  isSegmentationMaskReady,
  getSegmentationError,
} from './segmentation.js';
import { resetSession } from './session.js';
import {
  isIOS,
  isSafari,
  supportsDisplayCapture,
  supportsMediaRecorderPause,
  prepareVideoElement,
  playVideo,
  waitForVideoFrame,
  mixAudioTracks,
  getUserMediaVideo,
  getDisplayMediaOptions,
  createRecorder,
  canvasCaptureFps,
  mimeToExtension,
  requestVideoPermission,
  getCaptureCardStream,
  findPairedAudioDevice,
  startHdmiAudioMonitor,
  stopHdmiAudioMonitor,
  resumeAudioContexts,
  openMicStream,
} from './platform.js';

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
let captureCardPos = 'bottom-left';
let compositor     = null;
let pendingExport  = null;
let captureCardStream = null;
let activeCaptureDeviceId = null;
let activeWebcamDeviceId = null;
let livePreviewActive = false;
let docPipWindow   = null;
let skipWebcamPip  = false;
let recordMimeType = '';
let recordIntent   = { video: true, notesPlan: true, vtt: true };

// Session-only (wiped after export — never persisted)
let sessionBgImage = null;
let sessionBgUrl   = null;

// Hidden capture elements (compositor sources)
const screenCapture = document.createElement('video');
const webcamCapture = document.createElement('video');
const captureCardCapture = document.createElement('video');
[screenCapture, webcamCapture, captureCardCapture].forEach(prepareVideoElement);
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
const recordIntentModal = $('recordIntentModal');
const exportManualNotes = $('exportManualNotes');
const exportNotesWarn = $('exportNotesWarn');
const captureCardToggle = $('captureCardToggle');
const captureCardOptions = $('captureCardOptions');
const captureCardPip = $('captureCardPip');
const captureCardSizeSlider = $('captureCardSize');
const captureCardSizeVal = $('captureCardSizeVal');
const tabMigrateNote = $('tabMigrateNote');
const bgImageRow     = $('bgImageRow');
const blurAmountRow  = $('blurAmountRow');
const bgImageInput   = $('bgImageInput');

[screenPreview, webcamPip, captureCardPip].forEach(prepareVideoElement);

compositor = createCompositor({
  screenVideo: screenCapture,
  captureCardVideo: captureCardCapture,
  webcamVideo: webcamCapture,
  canvas: composeCanvas,
});

function isRecordingActive() {
  return mediaRecorder && mediaRecorder.state !== 'inactive';
}

function hasScreenVideoForPreview() {
  return !!(screenStream && screenCapture.srcObject && screenCapture.videoWidth > 0);
}

function isCaptureMainPreview() {
  return !!(captureCardToggle?.checked && captureCardCapture.srcObject && !hasScreenVideoForPreview());
}

function shouldRunLivePreview() {
  if (isRecordingActive()) return false;
  const capOn = captureCardToggle?.checked && captureCardCapture.srcObject;
  const camOn = webcamToggle.checked && webcamCapture.srcObject;
  return !!(capOn || camOn);
}

function syncLivePreviewLayout() {
  const captureMain = isCaptureMainPreview();
  compositor.setCaptureAsMain(captureMain);
  compositor.setCaptureEnabled(!!(captureCardToggle?.checked && captureCardCapture.srcObject && !captureMain));
}

function updatePreviewDomVisibility() {
  const live = livePreviewActive && shouldRunLivePreview();
  const captureMain = isCaptureMainPreview();
  const bgMode = getBgMode();

  if (live) {
    captureCardPip.classList.toggle('hidden', captureMain);
    captureCardPip.classList.toggle('pip-ghost', !captureMain);
    webcamPip.classList.toggle('pip-ghost', bgMode !== 'none');
    if (webcamToggle.checked) webcamPip.classList.remove('hidden');
  } else {
    captureCardPip.classList.remove('pip-ghost');
    webcamPip.classList.remove('pip-ghost');
  }
}

function startLivePreview() {
  if (!shouldRunLivePreview()) return;
  syncLivePreviewLayout();
  syncCompositorBackground();
  syncCompositorCapturePip();
  syncCompositorPip();
  composeCanvas.classList.remove('hidden');
  previewIdle?.classList.add('hidden');
  livePreviewActive = true;
  updatePreviewDomVisibility();
  compositor.start();
}

function stopLivePreview() {
  if (isRecordingActive()) return;
  compositor.stop();
  composeCanvas.classList.add('hidden');
  livePreviewActive = false;
  captureCardPip.classList.remove('pip-ghost');
  webcamPip.classList.remove('pip-ghost');
  if (!captureCardToggle?.checked) captureCardPip.classList.add('hidden');
  if (!webcamToggle.checked) webcamPip.classList.add('hidden');
  if (!captureCardToggle?.checked && !webcamToggle.checked) previewIdle?.classList.remove('hidden');
}

function refreshLivePreview() {
  if (isRecordingActive()) {
    syncLivePreviewLayout();
    updatePreviewDomVisibility();
    return;
  }
  if (shouldRunLivePreview()) startLivePreview();
  else stopLivePreview();
}

function updateCaptureSizeSliderMax() {
  if (!captureCardSizeSlider || !previewContainer) return;
  const w = previewContainer.clientWidth || 800;
  captureCardSizeSlider.max = String(Math.max(560, Math.round(w * 0.92)));
}

updateCaptureSizeSliderMax();
window.addEventListener('resize', updateCaptureSizeSliderMax);

$('previewFullscreenBtn')?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await previewContainer.requestFullscreen();
  } catch (e) {
    console.warn('Fullscreen failed:', e);
  }
});

function isTabSource() {
  return document.querySelector('input[name="source"]:checked')?.value === 'tab';
}

function canMigrateWebcam() {
  return isTabSource() && webcamToggle.checked && 'documentPictureInPicture' in window;
}

function fillDeviceSelect(sel, devices, labelFn) {
  if (!sel) return;
  const prev = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = labelFn(d, i);
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function getSelectedCaptureDeviceId() {
  return $('captureCardSelect')?.value || '';
}

function getSelectedWebcamDeviceId() {
  return $('camSelect')?.value || '';
}

function sameVideoDeviceSelected() {
  const cap = getSelectedCaptureDeviceId();
  const cam = getSelectedWebcamDeviceId();
  return !!(cap && cam && cap === cam);
}

function updateDualFeedWarning() {
  const el = $('dualFeedWarn');
  if (!el) return;
  if (captureCardToggle?.checked && webcamToggle?.checked && sameVideoDeviceSelected()) {
    el.textContent = 'Both feeds need two different cameras — pick one device per feed.';
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function assertDistinctVideoFeeds() {
  if (captureCardToggle?.checked && webcamToggle?.checked && sameVideoDeviceSelected()) {
    throw new Error('Capture card and webcam must be two different devices. Pick one camera per feed.');
  }
}

function isStreamLive(stream) {
  return !!stream?.getVideoTracks().some(t => t.readyState === 'live');
}

// ── Init: enumerate devices ────────────────────────
async function enumerateDevices() {
  try {
    if (isIOS || isSafari) {
      await requestVideoPermission();
    } else {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null));
      if (tmp) tmp.getTracks().forEach(t => t.stop());
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const cams = devices.filter(d => d.kind === 'videoinput');
    const micSel = $('micSelect');
    const camSel = $('camSelect');
    const capSel = $('captureCardSelect');

    fillDeviceSelect(micSel, mics, (mic, i) => mic.label || `Microphone ${i + 1}`);
    fillDeviceSelect(camSel, cams, (cam, i) => cam.label || `Camera ${i + 1}`);
    fillDeviceSelect(capSel, cams, (cam, i) => cam.label || `HDMI / capture ${i + 1}`);

    updateDualFeedWarning();
  } catch (e) {
    console.warn('Device enumeration failed:', e);
  }
}

enumerateDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', enumerateDevices);

// ── Capture source + tab migrate hint ───────────────
document.querySelectorAll('input[name="source"]').forEach(r => {
  r.addEventListener('change', async () => {
    tabMigrateNote?.classList.toggle('hidden', !isTabSource());
    if (webcamToggle.checked) {
      await syncWebcamPresentation();
    }
  });
});

// ── Capture card (additive overlay) ────────────────
function wantCaptureCardAudio() {
  return !!$('captureCardAudio')?.checked;
}

function setCaptureCardAudioStatus(msg) {
  const el = $('captureCardAudioStatus');
  if (el) el.textContent = msg || '';
}

async function getExcludedMicDeviceIds() {
  if (!captureCardToggle?.checked || !wantCaptureCardAudio()) return [];
  const devId = getSelectedCaptureDeviceId();
  if (!devId) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const paired = findPairedAudioDevice(devId, devices);
  return paired?.deviceId ? [paired.deviceId] : [];
}

async function wireCaptureCardAudioMonitor(stream) {
  const tracks = (stream?.getAudioTracks() || []).filter(t => t.readyState === 'live');
  tracks.forEach(t => { t.enabled = true; });

  if (tracks.length && wantCaptureCardAudio()) {
    await resumeAudioContexts();
    const monitoring = await startHdmiAudioMonitor(tracks);
    setCaptureCardAudioStatus(
      monitoring
        ? `HDMI audio live: ${tracks[0].label || 'capture input'} (mic can stay on)`
        : `HDMI audio captured: ${tracks[0].label || 'capture input'} — click page to hear it`,
    );
  } else {
    stopHdmiAudioMonitor();
    if (wantCaptureCardAudio()) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const paired = findPairedAudioDevice(getSelectedCaptureDeviceId(), devices);
      setCaptureCardAudioStatus(
        paired
          ? `No signal on “${paired.label}” — check Chromecast/TV volume and HDMI cable.`
          : 'No HDMI audio device found for this capture card.',
      );
    } else {
      setCaptureCardAudioStatus('');
    }
  }
}

async function playCaptureAudioMonitor() {
  await resumeAudioContexts();
  if (captureCardStream?.getAudioTracks().length) {
    await wireCaptureCardAudioMonitor(captureCardStream);
  }
}

document.addEventListener('click', () => { playCaptureAudioMonitor(); }, { once: true });

captureCardToggle?.addEventListener('change', async () => {
  const on = captureCardToggle.checked;
  captureCardOptions?.classList.toggle('hidden', !on);
  updateDualFeedWarning();
  if (on) {
    const devId = getSelectedCaptureDeviceId();
    if (devId) await startCaptureCardPreview();
    else setCaptureCardAudioStatus('Select your HDMI capture device above.');
  } else {
    stopCaptureCardPreview();
  }
});

$('captureCardSelect')?.addEventListener('change', async () => {
  updateDualFeedWarning();
  if (captureCardToggle?.checked) {
    await restartCaptureCardPreview();
  }
});

$('captureCardAudio')?.addEventListener('change', async () => {
  if (captureCardToggle?.checked && getSelectedCaptureDeviceId()) {
    await restartCaptureCardPreview();
  }
});

captureCardSizeSlider?.addEventListener('input', () => {
  const v = parseInt(captureCardSizeSlider.value, 10);
  if (captureCardSizeVal) captureCardSizeVal.textContent = v + 'px';
  applyCaptureCardSize(v);
  syncCompositorCapturePip();
});

document.querySelectorAll('#capturePosButtons .pos-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#capturePosButtons .pos-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    captureCardPos = btn.dataset.pos;
    applyCaptureCardPos(captureCardPos);
    syncCompositorCapturePip();
  });
});

async function openCaptureCardStream() {
  const devId = $('captureCardSelect')?.value;
  if (!devId) throw new Error('Select a capture card device first.');
  return getCaptureCardStream(devId, { audio: wantCaptureCardAudio() });
}

async function ensureCaptureCardStream() {
  const devId = getSelectedCaptureDeviceId();
  if (!devId) throw new Error('Select a capture card device first.');
  assertDistinctVideoFeeds();
  const needsAudio = wantCaptureCardAudio();
  const hasAudio = !!(captureCardStream?.getAudioTracks().some(t => t.readyState === 'live'));
  if (captureCardStream && activeCaptureDeviceId === devId && isStreamLive(captureCardStream)) {
    if (!needsAudio || hasAudio) return captureCardStream;
  }
  stopCaptureCardTracks();
  captureCardStream = await openCaptureCardStream();
  activeCaptureDeviceId = devId;
  return captureCardStream;
}

function stopCaptureCardTracks() {
  if (captureCardStream) {
    captureCardStream.getTracks().forEach(t => t.stop());
    captureCardStream = null;
  }
  activeCaptureDeviceId = null;
}

async function restartCaptureCardPreview() {
  stopCaptureCardTracks();
  if (getSelectedCaptureDeviceId()) await startCaptureCardPreview();
  else stopCaptureCardPreview();
}

async function attachCaptureCardPreview(stream) {
  const videoOnly = new MediaStream(stream.getVideoTracks());
  captureCardPip.srcObject = videoOnly;
  captureCardCapture.srcObject = videoOnly;
  await playVideo(captureCardCapture);
  await wireCaptureCardAudioMonitor(stream);
  captureCardPip.classList.remove('hidden');
  applyCaptureCardPos(captureCardPos);
  applyCaptureCardSize(parseInt(captureCardSizeSlider?.value || '560', 10));
  compositor.setCaptureEnabled(true);
  syncCompositorCapturePip();
  previewIdle?.classList.add('hidden');
  refreshLivePreview();
}

async function startCaptureCardPreview() {
  try {
    const stream = await ensureCaptureCardStream();
    await attachCaptureCardPreview(stream);
    setStatus('ready', 'Ready');
  } catch (e) {
    const hint = (isIOS || isSafari)
      ? ' On iPhone, pick the external/HDMI camera after allowing camera access.'
      : '';
    alert('Could not access capture card: ' + e.message + hint);
    captureCardToggle.checked = false;
    captureCardOptions?.classList.add('hidden');
    setCaptureCardAudioStatus('');
  }
}

function stopCaptureCardPreview() {
  stopHdmiAudioMonitor();
  setCaptureCardAudioStatus('');
  stopCaptureCardTracks();
  captureCardPip.srcObject = null;
  captureCardCapture.srcObject = null;
  captureCardPip.classList.add('hidden');
  compositor.setCaptureEnabled(false);
  compositor.setCaptureAsMain(false);
  refreshLivePreview();
}

function applyCaptureCardPos(pos) {
  captureCardPip.style.left = captureCardPip.style.top = captureCardPip.style.right = captureCardPip.style.bottom = 'auto';
  captureCardPip.className = captureCardPip.className.replace(/pos-\S+/g, '').trim();
  captureCardPip.classList.add(`pos-${pos}`, 'capture-pip');
  captureCardPip.classList.remove('hidden');
  syncCompositorCapturePip();
}

function applyCaptureCardSize(widthPx) {
  const h = Math.round(widthPx * 9 / 16);
  captureCardPip.style.width = widthPx + 'px';
  captureCardPip.style.height = h + 'px';
  syncCompositorCapturePip();
}

function syncCompositorCapturePip() {
  compositor.setPipFromElement(captureCardPip, previewContainer, 'capture');
}

function syncCompositorPip() {
  compositor.setPipFromElement(webcamPip, previewContainer, 'webcam');
  if (livePreviewActive) updatePreviewDomVisibility();
}

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
  syncWebcamSegmentation();
}

function syncWebcamSegmentation() {
  const mode = getBgMode();
  const useSeg = webcamToggle.checked && (mode === 'blur' || mode === 'image');
  setSegmentationOptions({
    mode: useSeg ? mode : 'none',
    bgImage: mode === 'image' ? sessionBgImage : null,
    blurPx: parseInt($('blurAmount')?.value || '14', 10),
  });
  const statusEl = $('segStatus');
  if (useSeg && webcamCapture.srcObject && webcamCapture.videoWidth > 0) {
    startSegmentationLoop(webcamCapture);
  } else {
    stopSegmentationLoop();
    if (statusEl) statusEl.textContent = '';
    return;
  }
  if (statusEl) {
    const tick = () => {
      if (!webcamToggle.checked || (mode !== 'blur' && mode !== 'image')) return;
      statusEl.textContent = getSegmentationStatus()
        + (getSegmentationError() ? ` (${getSegmentationError()})` : '');
      if (!isSegmentationMaskReady()) requestAnimationFrame(tick);
    };
    tick();
  }
}

document.querySelectorAll('input[name="bgMode"]').forEach(r => {
  r.addEventListener('change', () => {
    const mode = getBgMode();
    bgImageRow?.classList.toggle('hidden', mode !== 'image');
    blurAmountRow?.classList.toggle('hidden', mode !== 'blur');
    syncCompositorBackground();
    refreshLivePreview();
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
    refreshLivePreview();
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
  disposeSegmenter();
}

// ── Webcam toggle ──────────────────────────────────
webcamToggle.addEventListener('change', async () => {
  if (webcamToggle.checked) {
    webcamOptions.style.display = 'flex';
    updateDualFeedWarning();
    await startWebcamPreview();
  } else {
    webcamOptions.style.display = 'none';
    updateDualFeedWarning();
    stopWebcamPreview();
  }
});

webcamOptions.style.display = 'none';

$('camSelect').addEventListener('change', async () => {
  updateDualFeedWarning();
  if (webcamToggle.checked) {
    restartWebcamPreview();
  }
});

async function ensureWebcamStream() {
  const camId = getSelectedWebcamDeviceId();
  assertDistinctVideoFeeds();
  if (webcamStream && activeWebcamDeviceId === camId && isStreamLive(webcamStream)) {
    return webcamStream;
  }
  stopWebcamTracks();
  webcamStream = await getUserMediaVideo(camId || null, { audio: false });
  activeWebcamDeviceId = camId;
  return webcamStream;
}

function stopWebcamTracks() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  activeWebcamDeviceId = null;
}

async function restartWebcamPreview() {
  stopWebcamTracks();
  if (webcamToggle.checked) await startWebcamPreview();
  else stopWebcamPreview();
}

async function startWebcamPreview() {
  try {
    await ensureWebcamStream();
    webcamCapture.srcObject = webcamStream;
    await playVideo(webcamCapture);
    await syncWebcamPresentation();
    applyWebcamSize(parseInt(camSizeSlider.value));
    syncCompositorPip();
    syncCompositorBackground();
    setStatus('ready', 'Ready');
    refreshLivePreview();
  } catch (e) {
    alert('Could not access webcam: ' + e.message);
    webcamToggle.checked = false;
    webcamOptions.style.display = 'none';
  }
}

async function syncWebcamPresentation() {
  if (canMigrateWebcam()) {
    const opened = await openWebcamDocumentPiP();
    if (opened) {
      webcamPip.classList.add('hidden');
      return;
    }
  }
  closeWebcamDocumentPiP();
  webcamPip.srcObject = webcamStream;
  webcamPip.classList.remove('hidden');
  applyWebcamPos(webcamPos);
}

async function openWebcamDocumentPiP() {
  if (!window.documentPictureInPicture?.requestWindow || !webcamStream) return false;
  try {
    closeWebcamDocumentPiP();
    const size = parseInt(camSizeSlider.value, 10) || 320;
    docPipWindow = await documentPictureInPicture.requestWindow({
      width: size,
      height: size,
    });
    const doc = docPipWindow.document;
    doc.body.style.cssText = 'margin:0;background:#0d0e11;overflow:hidden;';
    const style = doc.createElement('style');
    style.textContent = `
      video { width:100%; height:100%; object-fit:cover; border-radius:50%; }
      .hint { position:absolute; bottom:4px; left:0; right:0; text-align:center;
        font:10px/1.2 Inter,system-ui,sans-serif; color:#8b8fa8; pointer-events:none; }
    `;
    doc.head.append(style);
    const video = doc.createElement('video');
    video.srcObject = webcamStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    doc.body.append(video);
    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Follows your active tab';
    doc.body.append(hint);
    docPipWindow.addEventListener('pagehide', () => { docPipWindow = null; });
    return true;
  } catch (e) {
    console.warn('Document PiP unavailable:', e);
    docPipWindow = null;
    return false;
  }
}

function closeWebcamDocumentPiP() {
  if (docPipWindow && !docPipWindow.closed) {
    try { docPipWindow.close(); } catch (_) {}
  }
  docPipWindow = null;
}

function stopWebcamPreview() {
  closeWebcamDocumentPiP();
  stopSegmentationLoop();
  stopWebcamTracks();
  webcamPip.srcObject = null;
  webcamCapture.srcObject = null;
  webcamPip.classList.add('hidden');
  refreshLivePreview();
}

document.querySelectorAll('#webcamOptions .position-buttons .pos-btn').forEach(btn => {
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

let dragging = false, dragOffX = 0, dragOffY = 0, dragTarget = null;

function startDrag(e, el) {
  dragging = true;
  dragTarget = el;
  const rect = el.getBoundingClientRect();
  dragOffX = e.clientX - rect.left;
  dragOffY = e.clientY - rect.top;
  el.style.transition = 'none';
  e.preventDefault();
}

webcamPip.addEventListener('mousedown', e => startDrag(e, webcamPip));
captureCardPip?.addEventListener('mousedown', e => startDrag(e, captureCardPip));
webcamPip.addEventListener('touchstart', e => startTouchDrag(e, webcamPip), { passive: false });
captureCardPip?.addEventListener('touchstart', e => startTouchDrag(e, captureCardPip), { passive: false });

function startTouchDrag(e, el) {
  if (!e.touches?.[0]) return;
  const t = e.touches[0];
  startDrag({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() }, el);
}

document.addEventListener('touchmove', e => {
  if (!dragging || !dragTarget || !e.touches?.[0]) return;
  const t = e.touches[0];
  e.preventDefault();
  const container = previewContainer.getBoundingClientRect();
  let x = t.clientX - container.left - dragOffX;
  let y = t.clientY - container.top  - dragOffY;
  const w = parseInt(dragTarget.style.width, 10) || dragTarget.offsetWidth || 320;
  const h = parseInt(dragTarget.style.height, 10) || dragTarget.offsetHeight || 320;
  x = Math.max(0, Math.min(x, container.width  - w));
  y = Math.max(0, Math.min(y, container.height - h));
  dragTarget.style.left   = x + 'px';
  dragTarget.style.top    = y + 'px';
  dragTarget.style.right  = 'auto';
  dragTarget.style.bottom = 'auto';
  if (dragTarget === webcamPip) syncCompositorPip();
  else syncCompositorCapturePip();
}, { passive: false });

document.addEventListener('touchend', () => {
  if (dragging) {
    dragging = false;
    if (dragTarget) dragTarget.style.transition = '';
    dragTarget = null;
    syncCompositorPip();
    syncCompositorCapturePip();
  }
});

document.addEventListener('mousemove', e => {
  if (!dragging || !dragTarget) return;
  const container = previewContainer.getBoundingClientRect();
  let x = e.clientX - container.left - dragOffX;
  let y = e.clientY - container.top  - dragOffY;
  const w = parseInt(dragTarget.style.width, 10) || dragTarget.offsetWidth || 320;
  const h = parseInt(dragTarget.style.height, 10) || dragTarget.offsetHeight || 320;
  x = Math.max(0, Math.min(x, container.width  - w));
  y = Math.max(0, Math.min(y, container.height - h));
  dragTarget.style.left   = x + 'px';
  dragTarget.style.top    = y + 'px';
  dragTarget.style.right  = 'auto';
  dragTarget.style.bottom = 'auto';
  if (dragTarget === webcamPip) syncCompositorPip();
  else syncCompositorCapturePip();
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    if (dragTarget) dragTarget.style.transition = '';
    dragTarget = null;
    syncCompositorPip();
    syncCompositorCapturePip();
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
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    showRecordIntentModal();
  } else {
    stopRecording();
  }
});

function showRecordIntentModal() {
  const iv = $('intentVideo');
  const inotes = $('intentNotesPlan');
  const ivtt = $('intentVtt');
  if (iv) iv.checked = recordIntent.video;
  if (inotes) inotes.checked = recordIntent.notesPlan;
  if (ivtt) ivtt.checked = recordIntent.vtt;
  recordIntentModal?.classList.remove('hidden');
}

function hideRecordIntentModal() {
  recordIntentModal?.classList.add('hidden');
}

function applyRecordIntent() {
  recordIntent = {
    video: $('intentVideo')?.checked ?? true,
    notesPlan: $('intentNotesPlan')?.checked ?? true,
    vtt: $('intentVtt')?.checked ?? true,
  };

  if (recordIntent.notesPlan || recordIntent.vtt) {
    micAudioChk.checked = true;
    micSelectRow.style.display = 'block';
    if (SpeechRec && (recordIntent.vtt || recordIntent.notesPlan)) {
      captionsToggle.checked = true;
      if (captionStatus) {
        captionStatus.textContent = 'Captions on — speak clearly for meeting notes & action plan.';
      }
    } else if (captionStatus) {
      captionStatus.textContent = 'Type meeting notes in the export dialog after you stop (Safari/iOS).';
    }
  }
}

$('intentConfirm')?.addEventListener('click', () => {
  const any = $('intentVideo')?.checked || $('intentNotesPlan')?.checked || $('intentVtt')?.checked;
  if (!any) {
    alert('Select at least one: video, meeting notes/action plan, or captions.');
    return;
  }
  applyRecordIntent();
  hideRecordIntentModal();
  startRecording();
});

$('intentCancel')?.addEventListener('click', hideRecordIntentModal);
recordIntentModal?.addEventListener('click', e => {
  if (e.target === recordIntentModal) hideRecordIntentModal();
});

pauseBtn.addEventListener('click', () => {
  if (!mediaRecorder || !supportsMediaRecorderPause()) return;
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

async function acquireMainVideoStream(sourceValue) {
  const wantSystemAudio = $('systemAudio').checked;

  if (supportsDisplayCapture()) {
    try {
      return {
        stream: await navigator.mediaDevices.getDisplayMedia(
          getDisplayMediaOptions(sourceValue, wantSystemAudio),
        ),
        role: 'display',
      };
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e;
      console.warn('Display capture unavailable, trying camera fallback:', e);
    }
  }

  if (captureCardToggle?.checked && $('captureCardSelect')?.value) {
    const stream = await openCaptureCardStream();
    return { stream, role: 'capturecard' };
  }

  if (webcamToggle.checked) {
    if (!webcamStream) await ensureWebcamStream();
    return { stream: new MediaStream(webcamStream.getVideoTracks()), role: 'webcam' };
  }

  if (isIOS || isSafari) {
    throw new Error(
      'Screen capture is limited in Safari. Enable Webcam or Capture Card, or use Chrome/Edge on desktop for screen recording.',
    );
  }
  throw new Error('Screen capture is not available in this browser.');
}

async function startRecording() {
  try {
    recordedChunks = [];
    recordMimeType = '';
    skipWebcamPip = false;
    syncCompositorBackground();

    const sourceValue = document.querySelector('input[name="source"]:checked').value;
    const audioTracks = [];
    const wantCaptureCard = captureCardToggle?.checked;

    const main = await acquireMainVideoStream(sourceValue);
    screenStream = main.stream;
    skipWebcamPip = main.role === 'webcam';

    screenStream.getAudioTracks().forEach(t => audioTracks.push(t));

    if (wantCaptureCard && main.role !== 'capturecard') {
      const devId = getSelectedCaptureDeviceId();
      if (!devId) {
        alert('Select a capture card / HDMI device first.');
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
        return;
      }
      assertDistinctVideoFeeds();
      const wantCapAudio = wantCaptureCardAudio();
      captureCardStream = await ensureCaptureCardStream();
      if (wantCapAudio) {
        captureCardStream.getAudioTracks().forEach(t => {
          t.enabled = true;
          audioTracks.push(t);
        });
      }
      await attachCaptureCardPreview(captureCardStream);
    } else if (main.role === 'capturecard') {
      captureCardStream = screenStream;
      captureCardCapture.srcObject = new MediaStream(screenStream.getVideoTracks());
      await playVideo(captureCardCapture);
      if (wantCaptureCardAudio()) {
        screenStream.getAudioTracks().forEach(t => {
          t.enabled = true;
          audioTracks.push(t);
        });
      }
      await wireCaptureCardAudioMonitor(screenStream);
      compositor.setCaptureEnabled(false);
      compositor.setCaptureAsMain(true);
      skipWebcamPip = false;
    } else if (!wantCaptureCard) {
      compositor.setCaptureEnabled(false);
      compositor.setCaptureAsMain(false);
    } else {
      compositor.setCaptureAsMain(false);
    }

    if (micAudioChk.checked) {
      try {
        const exclude = await getExcludedMicDeviceIds();
        micStream = await openMicStream($('micSelect').value || null, exclude);
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

    const screenVideoOnly = new MediaStream(screenStream.getVideoTracks());
    screenCapture.srcObject = screenVideoOnly;
    await playVideo(screenCapture);
    await waitForVideoFrame(screenCapture);

    if (webcamToggle.checked && !skipWebcamPip) {
      assertDistinctVideoFeeds();
      if (!webcamStream || !isStreamLive(webcamStream)) await startWebcamPreview();
      webcamCapture.srcObject = webcamStream;
      await playVideo(webcamCapture);
      await waitForVideoFrame(webcamCapture);
      await syncWebcamPresentation();
      syncCompositorPip();
    }

    syncLivePreviewLayout();
    livePreviewActive = true;
    updatePreviewDomVisibility();
    compositor.start();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let usedCompositor = true;
    try {
      const canvasStream = composeCanvas.captureStream(canvasCaptureFps());
      const tracks = [...canvasStream.getVideoTracks()];
      const mixedAudio = await mixAudioTracks(audioTracks);
      mixedAudio.forEach(t => tracks.push(t));
      mixedStream = new MediaStream(tracks);
      await resumeAudioContexts();
    } catch (composeErr) {
      console.warn('Compositor recording failed, using direct stream:', composeErr);
      usedCompositor = false;
      const tracks = [...screenStream.getVideoTracks()];
      const mixedAudio = await mixAudioTracks(audioTracks);
      mixedAudio.forEach(t => tracks.push(t));
      mixedStream = new MediaStream(tracks);
      await resumeAudioContexts();
    }

    const { recorder, mimeType } = createRecorder(mixedStream, getVideoBitrate());
    mediaRecorder = recorder;
    recordMimeType = mimeType;

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
    pauseBtn.disabled = !supportsMediaRecorderPause();

    screenPreview.classList.remove('active');
    if (usedCompositor) {
      composeCanvas.classList.remove('hidden');
    } else {
      composeCanvas.classList.add('hidden');
      screenPreview.srcObject = mixedStream;
      screenPreview.classList.add('active');
      await playVideo(screenPreview);
    }
    previewIdle.classList.add('hidden');

    const mainTrack = screenStream.getVideoTracks()[0];
    if (mainTrack) mainTrack.onended = stopRecording;
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

function getExportCues() {
  if (!pendingExport) return [];
  const manual = exportManualNotes?.value || '';
  return mergeExportCues(pendingExport.cues, manual, pendingExport.durationMs);
}

function updateExportPreview() {
  if (!pendingExport) return;
  const cues = getExportCues();
  const transcript = buildTranscript(cues);
  const preview = $('exportPreview');
  const warn = exportNotesWarn;
  const wantNotes = $('exportNotes')?.checked || $('exportPdf')?.checked;

  if (preview) {
    preview.textContent = transcript
      ? transcript.slice(0, 280) + (transcript.length > 280 ? '…' : '')
      : 'No speech yet — type meeting notes below for your .md and action plan PDF.';
  }

  if (warn) {
    if (wantNotes && !transcript) {
      warn.textContent = 'Meeting notes & action plan need a transcript or typed notes below.';
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
      warn.textContent = '';
    }
  }
}

function saveRecording() {
  const mimeType = recordMimeType || mediaRecorder?.mimeType || 'video/mp4';
  const ext      = mimeToExtension(mimeType);
  const blob     = recordedChunks.length
    ? new Blob(recordedChunks, { type: mimeType })
    : null;
  const basename = `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const durationMs = startTime ? recordingClock() : 0;
  const cues = [...captionCues];

  pendingExport = { blob, mimeType, ext, basename, cues, durationMs };
  recordedChunks = [];
  showExportModal();
}

function showExportModal() {
  if (!pendingExport) return;
  const { durationMs, blob } = pendingExport;

  if ($('exportVideo')) $('exportVideo').checked = recordIntent.video && !!blob;
  if ($('exportNotes')) $('exportNotes').checked = recordIntent.notesPlan;
  if ($('exportPdf')) $('exportPdf').checked = recordIntent.notesPlan;
  if ($('exportVtt')) $('exportVtt').checked = recordIntent.vtt;

  if (!blob && $('exportVideo')) {
    $('exportVideo').disabled = true;
    $('exportVideo').checked = false;
  } else if ($('exportVideo')) {
    $('exportVideo').disabled = false;
  }

  if (exportManualNotes) exportManualNotes.value = '';
  const durEl = $('exportDuration');
  if (durEl) durEl.textContent = durationMs ? formatTime(Math.floor(durationMs / 1000)) : '—';

  updateExportPreview();
  exportModal.classList.remove('hidden');
  if (!buildTranscript(pendingExport.cues)) {
    exportManualNotes?.focus();
  }
}

function hideExportModal() {
  exportModal.classList.add('hidden');
  cleanup();
  wipeSession();
}

async function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  await new Promise(r => setTimeout(r, isIOS ? 600 : 80));
  URL.revokeObjectURL(url);
}

async function runExportDownloads() {
  if (!pendingExport) return;
  const { blob, basename, durationMs, ext } = pendingExport;
  const wantVideo  = $('exportVideo')?.checked && blob;
  const wantNotes  = $('exportNotes')?.checked;
  const wantPdf    = $('exportPdf')?.checked;
  const wantVtt    = $('exportVtt')?.checked;
  const cues = getExportCues();
  const transcript = buildTranscript(cues);

  if (!wantVideo && !wantNotes && !wantPdf && !wantVtt) {
    alert('Select at least one item to download.');
    return false;
  }

  if ((wantNotes || wantPdf) && !transcript) {
    alert('Add a transcript (enable captions + mic while recording) or type meeting notes in the box below.');
    exportManualNotes?.focus();
    return false;
  }

  const meta = {
    title: 'Meeting Notes — opensourceS2DEMO',
    recordedAt: new Date().toLocaleString(),
    durationMs,
    basename,
  };

  if (wantVideo) {
    await downloadBlobFile(`${basename}.${ext}`, blob);
  }

  if (wantNotes) {
    downloadText(`${basename}-meeting-notes.md`, buildMeetingNotes(cues, meta));
    await new Promise(r => setTimeout(r, isIOS ? 400 : 50));
  }

  if (wantPdf) {
    if (window.jspdf?.jsPDF) {
      downloadActionPlanPdf({ cues, meta, jsPDF: window.jspdf.jsPDF });
      await new Promise(r => setTimeout(r, isIOS ? 400 : 50));
    } else {
      alert('PDF library not loaded — meeting notes (.md) was still generated.');
    }
  }

  if (wantVtt) {
    if (!cues.length) {
      alert('No transcript for .vtt — enable captions or type notes first.');
      return false;
    }
    downloadText(`${basename}.vtt`, buildVttFromCues(cues), 'text/vtt');
  }

  return true;
}

$('exportConfirm')?.addEventListener('click', async () => {
  const ok = await runExportDownloads();
  if (!ok) return;
  exportModal.classList.add('hidden');
  cleanup();
  wipeSession();
});

['exportNotes', 'exportPdf', 'exportVtt', 'exportVideo'].forEach(id => {
  $(id)?.addEventListener('change', updateExportPreview);
});
exportManualNotes?.addEventListener('input', updateExportPreview);

$('exportCancel')?.addEventListener('click', hideExportModal);

function cleanup() {
  stopHdmiAudioMonitor();
  compositor?.stop();
  closeWebcamDocumentPiP();
  skipWebcamPip = false;
  recordMimeType = '';
  const sharedCapture = !!(captureCardStream && screenStream && captureCardStream === screenStream);
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (captureCardStream && !sharedCapture) {
    captureCardStream.getTracks().forEach(t => t.stop());
  }
  captureCardStream = null;
  activeCaptureDeviceId = null;
  if (micStream)    { micStream.getTracks().forEach(t => t.stop());    micStream    = null; }
  screenCapture.srcObject = null;
  captureCardCapture.srcObject = null;
  compositor.setCaptureEnabled(false);
  compositor.setCaptureAsMain(false);
  composeCanvas.classList.add('hidden');
  screenPreview.srcObject = null;
  screenPreview.classList.remove('active');
  pendingExport = null;
  livePreviewActive = false;
  const anyPreview = webcamToggle.checked || captureCardToggle?.checked;
  if (!anyPreview) {
    webcamPip.classList.add('hidden');
    captureCardPip?.classList.add('hidden');
    previewIdle.classList.remove('hidden');
  } else {
    previewIdle.classList.add('hidden');
    if (!webcamToggle.checked) webcamPip.classList.add('hidden');
    if (!captureCardToggle?.checked) captureCardPip?.classList.add('hidden');
    if (captureCardToggle?.checked && getSelectedCaptureDeviceId()) {
      startCaptureCardPreview().catch(() => {});
    } else if (webcamToggle.checked && webcamStream) {
      webcamCapture.srcObject = webcamStream;
      playVideo(webcamCapture).then(() => {
        syncCompositorBackground();
        refreshLivePreview();
      }).catch(() => {});
    }
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

function getVideoBitrate() {
  const q = document.querySelector('input[name="quality"]:checked').value;
  if (isIOS) return q === '4k' ? 6_000_000 : q === '1080' ? 4_000_000 : 2_500_000;
  return q === '4k' ? 20_000_000 : q === '1080' ? 8_000_000 : 4_000_000;
}

if (!supportsMediaRecorderPause()) pauseBtn.disabled = true;
if ((isIOS || isSafari) && tabMigrateNote) {
  tabMigrateNote.textContent = 'Safari/iOS: screen capture is limited — enable Webcam or Capture Card. Webcam PiP stays in-page on mobile.';
}
if ((isIOS || isSafari) && !supportsDisplayCapture()) {
  const note = $('safariNote');
  if (note) note.classList.remove('hidden');
}

setStatus('', 'Ready');
