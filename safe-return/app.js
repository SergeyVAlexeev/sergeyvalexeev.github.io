(function () {
  'use strict';
  var C = window.SAFE_RETURN || {};
  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k) { try { return localStorage.getItem('sr:' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('sr:' + k, v); } catch (e) {} }
  };
  var pageStart = Date.now();

  if (C.previewBanner) { $('previewBanner').textContent = String(C.previewBanner); $('previewBanner').hidden = false; }

  /* ---------- Film (disabled until config.video.src is set) ---------- */
  var v = C.video || {};
  if (v.src) {
    var vid = $('filmVideo');
    vid.src = v.src;
    if (v.poster) vid.poster = v.poster;
    if (v.captions) {
      var t = document.createElement('track');
      t.kind = 'captions'; t.src = v.captions; t.srclang = v.captionsLang || 'en'; t.label = 'English'; t.default = true;
      vid.appendChild(t);
    }
    vid.setAttribute('aria-label', v.title || 'Safe Return film');
    $('filmCaption').textContent = v.title || '';
    if (v.transcriptUrl) { var tr = $('filmTranscript'); tr.hidden = false; tr.firstChild.href = v.transcriptUrl; }
    $('film').hidden = false; $('navFilm').hidden = false;
  }

  /* ---------- Chapter reader ---------- */
  var chapterOn = Boolean(C.chapterUrl);
  $('gate').hidden = chapterOn;
  if (!chapterOn) { $('ctaRead').textContent = 'Chapter 1: not yet public'; $('ctaRead').setAttribute('href', '#read'); }
  $('reader').hidden = !chapterOn;
  if (chapterOn) initReader();

  function initReader() {
    var body = document.body, art = $('chapter');
    var theme = store.get('theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper');
    var size = Number(store.get('size')) || 0; // steps from default
    function applyTheme(t) {
      theme = t; body.setAttribute('data-theme', t); store.set('theme', t);
      document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === t)); });
    }
    function applySize(n) {
      size = Math.max(-2, Math.min(4, n)); store.set('size', String(size));
      if (size === 0) document.documentElement.style.removeProperty('--read-size');
      else document.documentElement.style.setProperty('--read-size', ((window.innerWidth <= 760 ? 1.125 : 1.25) + size * 0.125) + 'rem');
      $('smaller').disabled = size <= -2; $('larger').disabled = size >= 4;
    }
    document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme-set')); }); });
    $('smaller').addEventListener('click', function () { applySize(size - 1); });
    $('larger').addEventListener('click', function () { applySize(size + 1); });
    applyTheme(theme); applySize(size);

    if (C.pdfUrl) { var p = $('pdfLink'); p.hidden = false; p.href = C.pdfUrl; }

    fetch(C.chapterUrl, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    }).then(function (html) {
      art.innerHTML = html;
      var h = art.querySelector('h3'); if (h) art.setAttribute('aria-labelledby', 'ch1-title');
      art.setAttribute('role', 'article');
      startProgress(art);
    }).catch(function () {
      $('reader').hidden = true; $('gate').hidden = false;
    });
  }

  function startProgress(art) {
    var bar = $('progress'), fill = bar.firstElementChild, ticking = false, ended = false;
    bar.hidden = false;
    function pct() {
      var r = art.getBoundingClientRect(), total = art.offsetHeight - window.innerHeight * 0.6;
      var done = Math.min(1, Math.max(0, (-r.top + window.innerHeight * 0.1) / Math.max(1, total)));
      return done;
    }
    function update() {
      ticking = false;
      var r = art.getBoundingClientRect();
      var inView = r.bottom > 0 && r.top < window.innerHeight;
      var p = pct();
      var n = Math.round(p * 100);
      fill.style.width = n + '%';
      bar.setAttribute('aria-valuenow', String(n));
      if (inView && n > 2) store.set('pos', String(p));
      if (n >= 98 && !ended) { ended = true; $('chapterEnd').hidden = false; store.set('pos', '1'); }
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update);
    var saved = Number(store.get('pos'));
    if (saved > 0.03 && saved < 0.98) {
      $('resume').hidden = false; $('resumePct').textContent = Math.round(saved * 100);
      $('resumeBtn').addEventListener('click', function () {
        var top = art.getBoundingClientRect().top + window.scrollY;
        var total = art.offsetHeight - window.innerHeight * 0.6;
        window.scrollTo({ top: top + saved * total - window.innerHeight * 0.1, behavior: 'auto' });
        art.focus({ preventScroll: true });
        $('resume').hidden = true;
      });
    }
    update();
  }

  /* ---------- Feedback ---------- */
  var form = $('fbForm');
  if (!C.feedbackEndpoint) { $('fbOff').hidden = false; return; }
  form.hidden = false;
  var comments = $('comments'), count = $('count'), status = $('fbStatus'), btn = $('fbSubmit');
  comments.addEventListener('input', function () { count.textContent = comments.value.length + ' / 2000'; });
  $('emailOptin').addEventListener('change', function () {
    $('emailWrap').hidden = !this.checked;
    if (this.checked) $('email').focus();
  });

  var tsToken = '';
  if (C.turnstileSiteKey) {
    window.__srTurnstile = function () {
      window.turnstile.render('#turnstile', { sitekey: C.turnstileSiteKey, callback: function (t) { tsToken = t; } });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__srTurnstile';
    s.async = true; document.head.appendChild(s);
  }

  function msg(text, kind) { status.textContent = text; status.className = 'status-msg ' + (kind || ''); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var choice = (form.querySelector('input[name=continue]:checked') || {}).value;
    if (!choice) { msg('Please choose Yes, Maybe or No.', 'error'); form.querySelector('input[name=continue]').focus(); return; }
    var optin = $('emailOptin').checked, email = $('email').value.trim();
    if (optin && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { msg('Please enter a valid email address, or untick the email option.', 'error'); $('email').focus(); return; }
    if (!$('privacyAck').checked) { msg('Please confirm you have read the privacy notice.', 'error'); $('privacyAck').focus(); return; }
    btn.disabled = true; msg('Sending…');
    var payload = {
      continue: choice, stopped_at: $('stopped').value, comments: comments.value,
      email_optin: optin, email: optin ? email : '', privacy_ack: true,
      website: form.elements.website.value, elapsed_ms: Date.now() - pageStart, turnstile_token: tsToken
    };
    fetch(C.feedbackEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (o) {
        if (o.r.ok) {
          tsToken = ''; if (window.turnstile && C.turnstileSiteKey) { try { window.turnstile.reset(); } catch (x) {} }
          form.reset(); $('emailWrap').hidden = true; count.textContent = '0 / 2000';
          msg('Thank you. Your response has been received for private review. Nothing is published.' + (o.j.ref ? ' Your reference code: ' + o.j.ref : ''), 'ok');
        } else {
          msg(o.j.error || 'Something went wrong. Please try again.', 'error');
          if (window.turnstile && C.turnstileSiteKey) { tsToken = ''; try { window.turnstile.reset(); } catch (x) {} }
        }
      })
      .catch(function () { msg('Could not reach the feedback service. Check your connection and try again; your text is still here.', 'error'); })
      .then(function () { btn.disabled = false; });
  });
})();
