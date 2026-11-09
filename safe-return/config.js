// Public configuration for /safe-return/. Safe to commit and deploy.
// chapterUrl        Chapter 1 HTML fragment (public, frozen v0.5.1 text).
// pdfUrl            Chapter 1 PDF (public sample, with closing author note). Empty: no download link.
// feedbackEndpoint  safe-return-feedback Worker /feedback URL (deployed).
// turnstileSiteKey  Cloudflare Turnstile site key (public), required with the Worker.
window.SAFE_RETURN = {
  chapterUrl: '/safe-return/chapter-1.html',
  pdfUrl: '/safe-return/Safe_Return_Chapter_1.pdf',
  feedbackEndpoint: 'https://safe-return-feedback.sergei-v-alexeev.workers.dev/feedback',
  turnstileSiteKey: '0x4AAAAAAF5ibuJyjD55wph4',
  previewBanner: false,
  video: { src: '', poster: '', captions: '', captionsLang: 'en', title: '', transcriptUrl: '' }
};
