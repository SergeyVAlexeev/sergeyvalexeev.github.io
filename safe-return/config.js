// Public configuration for /safe-return/. Safe to commit and deploy.
// chapterUrl        Chapter 1 HTML fragment (public, frozen v0.5.1 text).
// pdfUrl            Chapter 1 PDF. Empty: not linked yet (front matter still reads as a private reader draft).
// feedbackEndpoint  safe-return-feedback Worker /feedback URL. Empty: form stays off until the Worker is deployed.
// turnstileSiteKey  Cloudflare Turnstile site key (public), required with the Worker.
window.SAFE_RETURN = {
  chapterUrl: '/safe-return/chapter-1.html',
  pdfUrl: '',
  feedbackEndpoint: '',
  turnstileSiteKey: '',
  previewBanner: false,
  video: { src: '', poster: '', captions: '', captionsLang: 'en', title: '', transcriptUrl: '' }
};
