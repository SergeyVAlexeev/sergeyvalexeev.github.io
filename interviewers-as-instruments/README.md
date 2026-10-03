# Interviewers as instruments

Static companion page for Sergey Alexeev and Mark Wooden's accepted / forthcoming Journal of Population Economics paper. Intended public URL: https://www.alexeev.pw/interviewers-as-instruments/.

No build step, external scripts, analytics, or runtime dependencies. HTML, CSS and JavaScript are separate. The core player, transcript and methodological details work without JavaScript. Fonts are self-hosted; their SIL Open Font License files are included.

## Media

- `assets/film.mp4`: unchanged final narrated V2 1080p master, 1920 × 1080, H.264 / AAC, 95.083 seconds, 36,897,558 bytes (36.9 MB / 35.2 MiB). SHA-256: `3f9a29c2b1ff9a88156951c405a8364df4c413d5b076d16f3083adc5d054a742`.
- `assets/poster.jpg`: existing V2 webpage poster, drawn from the approved second-light still.
- `assets/narration.vtt` and `.srt`: final narration-aligned English captions, unchanged.
- `assets/og.jpg`: 1200 × 630 social artwork composed with the original poster and the film's fonts. This is the share card, separate from the video poster.

The player uses `preload="none"` and never autoplays. Captions are on by default. A play button enhances the native player when JavaScript is available. Downloading the original MP4 remains possible.

## Publication status

The paper is accepted / forthcoming. No DOI, publication date, volume or pages have been invented. Journal and post-print resources are clearly unavailable. When supplied, replace these disabled spans with real links; update citation and article metadata together. No manuscript PDF is included in this folder.

## Scientific conventions

Monthly-or-more reported use compared with no reported use of the same substance in the last 12 months; hourly wages among wage and salary employees, HILDA 2017 and 2021. Percentages use `100 * (exp(beta) - 1)`. Needle tips use the same scale across the three comparisons, with no intervals drawn. The methamphetamine IV needle is dashed and hollow, with the Romano–Wolf qualification immediately visible. Adjusted p = 0.058 is the substance-level joint test of both frequency coefficients across six substance hypotheses, not the single frequent-use coefficient's p-value.

Assignment and exclusion are stated as assumptions. Drug questions are described as privately self-completed, never directly asked by interviewers. Household lights and interviewer routes are schematic. Details explain local interpretation, employment selection and the exclusion diagnostic.

## Hosting

The complete new page is about 37.4 MB, mostly its unchanged master. Direct hosting matches the existing `why-twelve-notes` page and fits current GitHub file-size and Pages site-size limits. Upload through Git, not the browser file uploader (which limits each file to 25 MiB).

GitHub Pages has a soft monthly bandwidth limit of 100 GB shared across the site. At 36.9 MB per complete film download, roughly 2,700 full downloads alone would consume that allowance. This is an indicative calculation, not a traffic forecast. For sustained higher traffic, host the unchanged MP4 on an object-storage/CDN endpoint supporting HTTPS, byte ranges and `video/mp4`, then update the player's source and download link together. Keep VTT captions same-origin on this page. A hosted video platform with captions is another option if an embedded platform player is preferred. No account creation or external upload has been performed.

References: [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [GitHub file-size limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

This folder is prepared for review. Publication requires the owner's approval before commit / push.
