/* Stateless session — wipe all in-memory recording data after each export. */

/**
 * @param {object} state — mutable session refs from app
 */
export function resetSession(state) {
  const {
    revokeBg,
    clearPendingExport,
    captionCues,
    recordedChunks,
    fileInputs,
  } = state;

  if (typeof revokeBg === 'function') revokeBg();
  if (typeof clearPendingExport === 'function') clearPendingExport();

  if (captionCues) captionCues.length = 0;
  if (recordedChunks) recordedChunks.length = 0;

  (fileInputs || []).forEach(input => {
    if (input) input.value = '';
  });

  // Reset UI toggles that are per-session only
  const bgMode = document.querySelector('input[name="bgMode"]:checked');
  if (bgMode?.value !== 'none') {
    const none = document.querySelector('input[name="bgMode"][value="none"]');
    if (none) none.checked = true;
  }
  const bgPreview = document.getElementById('bgPreview');
  if (bgPreview) {
    bgPreview.classList.add('hidden');
    bgPreview.removeAttribute('src');
  }
  const bgFileName = document.getElementById('bgFileName');
  if (bgFileName) bgFileName.textContent = '';
}
