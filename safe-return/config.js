// Public configuration for /safe-return/. Safe to commit and deploy.
// chapterUrl        Chapter 1 HTML fragment (public, frozen v0.5.1 text).
// pdfUrl            Chapter 1 PDF (public sample, with closing author note). Empty: no download link.
// feedbackEndpoint  safe-return-feedback Worker /feedback URL (deployed).
// turnstileSiteKey  Cloudflare Turnstile site key (public), required with the Worker.
// audio             Chapter 1 narration. mp3 shows the player; webm (Opus) is used where the browser
//                   supports it; timings (paragraph start times) drives "Follow in the text".
window.SAFE_RETURN = {
  chapterUrl: '/safe-return/chapter-1.html',
  pdfUrl: '/safe-return/Safe_Return_Chapter_1.pdf',
  feedbackEndpoint: 'https://safe-return-feedback.sergei-v-alexeev.workers.dev/feedback',
  turnstileSiteKey: '0x4AAAAAAF5ibuJyjD55wph4',
  previewBanner: false,
  audio: {
    mp3: '/safe-return/audio/safe-return-ch1-porch-light.mp3',
    webm: '/safe-return/audio/safe-return-ch1-porch-light.webm',
    timings: '/safe-return/audio/ch1-timings.json',
    download: '/safe-return/audio/safe-return-ch1-porch-light.mp3',
    duration: 1383,
    credit: 'AI narration',
    note: 'AI-generated narration of the unchanged Chapter 1 text, made with Kokoro, an open-source text-to-speech model (British English voice).'
  },
  video: { src: '', poster: '', captions: '', captionsLang: 'en', title: '', transcriptUrl: '' }
};
