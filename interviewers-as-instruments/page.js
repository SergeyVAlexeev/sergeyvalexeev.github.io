/* Native controls and details remain usable without this enhancement. */
(() => {
  const video = document.getElementById('film');
  const play = document.getElementById('play-film');
  video.controls = false;
  play.hidden = false;
  play.addEventListener('click', async () => {
    video.controls = true;
    play.hidden = true;
    video.focus({ preventScroll: true });
    try { await video.play(); }
    catch { document.getElementById('playback-status').textContent = 'Use the video controls to play, or download the film below.'; }
  });
  video.addEventListener('play', () => { play.hidden = true; video.controls = true; });
  document.querySelectorAll('a[data-open-details]').forEach(link => {
    link.addEventListener('click', () => {
      document.getElementById(link.dataset.openDetails).open = true;
    });
  });
  const copy = document.getElementById('copy-citation');
  if (navigator.clipboard && window.isSecureContext) {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      const status = document.getElementById('copy-status');
      try {
        await navigator.clipboard.writeText(document.getElementById('citation-text').textContent.trim());
        status.textContent = 'Citation copied.';
      } catch { status.textContent = 'Select and copy the citation above.'; }
    });
  }
})();
