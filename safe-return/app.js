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
    var listen = initListen();

    fetch(C.chapterUrl, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    }).then(function (html) {
      art.innerHTML = html;
      var h = art.querySelector('h3'); if (h) art.setAttribute('aria-labelledby', 'ch1-title');
      art.setAttribute('role', 'article');
      startProgress(art);
      if (listen) listen.attach(art);
    }).catch(function () {
      $('reader').hidden = true; $('gate').hidden = false;
    });
  }

  /* ---------- Narration (enabled when config.audio.mp3 is set) ---------- */
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function spokenTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), x = s % 60;
    return (m ? m + (m === 1 ? ' minute ' : ' minutes ') : '') + x + (x === 1 ? ' second' : ' seconds');
  }

  function initListen() {
    var A = C.audio || {};
    if (!A.mp3) return null;
    var au = $('narration'), box = $('listen'), play = $('plPlay'), seek = $('plSeek');
    var cur = $('plCur'), durEl = $('plDur'), meta = $('plMeta'), rateBtn = $('plRate'), follow = $('plFollow');
    var mini = $('miniPlayer'), miniPlay = $('miniPlay'), miniTime = $('miniTime'), miniFill = $('miniFill');
    var dur = Number(A.duration) || 0, mins = Math.round(dur / 60), started = false, dragging = false;
    var rates = [1, 1.15, 1.3, 1.5, 0.9], rateNames = { 1: 'normal', 1.15: '1.15 times', 1.3: '1.3 times', 1.5: '1.5 times', 0.9: '0.9 times' };
    var paras = [], times = null, current = -1, userScrollUntil = 0;
    var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    box.hidden = false;
    if (mins) {
      $('listenNote').hidden = false; $('listenNoteMin').textContent = String(mins);
      $('ctaListenDur').textContent = ' · ' + mins + ' min';
    }
    $('ctaListen').hidden = false;
    durEl.textContent = fmt(dur);
    seek.max = String(Math.round(dur) || 100);
    meta.textContent = (A.credit || 'Narrated') + (mins ? ' · ' + mins + ' min' : '');
    $('plNote').textContent = A.note || '';
    if (A.download) { var dl = $('plMp3'); dl.href = A.download; dl.hidden = false; }
    var useWebm = A.webm && au.canPlayType('audio/webm; codecs="opus"') === 'probably';
    au.src = useWebm ? A.webm : A.mp3;

    var saved = Number(store.get('audioPos')) || 0;
    if (saved > 15 && (!dur || saved < dur - 15)) {
      meta.textContent += ' · resume at ' + fmt(saved);
      play.setAttribute('aria-label', 'Resume the narration at ' + spokenTime(saved));
    }
    var savedRate = Number(store.get('audioRate'));
    if (rates.indexOf(savedRate) > 0) setRate(savedRate);
    if (store.get('audioFollow') === '0') follow.checked = false;

    function setRate(r) {
      au.playbackRate = r; au.defaultPlaybackRate = r;
      rateBtn.textContent = String(r).replace(/^0/, '0') + '×';
      rateBtn.setAttribute('aria-label', 'Playback speed: ' + rateNames[r]);
      store.set('audioRate', String(r));
    }
    function setPlaying(on) {
      box.classList.toggle('is-playing', on); mini.classList.toggle('is-playing', on);
      play.setAttribute('aria-label', on ? 'Pause the narration' : 'Play the narration of Chapter 1');
      miniPlay.setAttribute('aria-label', on ? 'Pause the narration' : 'Play the narration');
    }
    function toggle() {
      if (au.paused) {
        if (!started && saved > 15 && (!dur || saved < dur - 15)) { try { au.currentTime = saved; } catch (e) {} }
        started = true;
        var pr = au.play(); if (pr && pr.catch) pr.catch(function () { setPlaying(false); });
      } else au.pause();
    }
    function render() {
      var t = au.currentTime || 0, d = au.duration && isFinite(au.duration) ? au.duration : dur;
      if (!dragging) seek.value = String(Math.round(t));
      seek.style.setProperty('--pct', (d ? t / d * 100 : 0) + '%');
      seek.setAttribute('aria-valuetext', spokenTime(t) + ' of ' + spokenTime(d));
      cur.textContent = fmt(t);
      miniTime.textContent = fmt(t) + ' / ' + fmt(d);
      miniFill.style.width = (d ? t / d * 100 : 0) + '%';
    }
    function boxInView() { var r = box.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }
    function updateMini() { mini.hidden = !(started && !boxInView() && (!au.paused || au.currentTime > 0)); }

    play.addEventListener('click', toggle);
    miniPlay.addEventListener('click', toggle);
    $('plBack').addEventListener('click', function () { au.currentTime = Math.max(0, au.currentTime - 15); render(); });
    $('plFwd').addEventListener('click', function () { au.currentTime = Math.min((au.duration || dur) - 1, au.currentTime + 30); render(); });
    rateBtn.addEventListener('click', function () { setRate(rates[(rates.indexOf(au.playbackRate) + 1) % rates.length] || 1); });
    follow.addEventListener('change', function () { store.set('audioFollow', follow.checked ? '1' : '0'); if (follow.checked) userScrollUntil = 0; });
    seek.addEventListener('input', function () { dragging = true; cur.textContent = fmt(Number(seek.value)); seek.style.setProperty('--pct', (Number(seek.value) / Number(seek.max) * 100) + '%'); });
    seek.addEventListener('change', function () { dragging = false; started = true; au.currentTime = Number(seek.value); userScrollUntil = 0; render(); });

    au.addEventListener('loadedmetadata', function () {
      if (isFinite(au.duration)) { durEl.textContent = fmt(au.duration); seek.max = String(Math.round(au.duration)); }
    });
    au.addEventListener('play', function () { setPlaying(true); updateMini(); });
    au.addEventListener('pause', function () { setPlaying(false); store.set('audioPos', String(au.currentTime)); updateMini(); });
    au.addEventListener('ended', function () { setPlaying(false); store.set('audioPos', '0'); highlight(-1); updateMini(); });
    var lastSave = 0;
    au.addEventListener('timeupdate', function () {
      render(); sync(); updateMini();
      if (Math.abs(au.currentTime - lastSave) > 5) { lastSave = au.currentTime; store.set('audioPos', String(au.currentTime)); }
    });

    window.addEventListener('scroll', function () { if (started) updateMini(); }, { passive: true });
    ['wheel', 'touchmove', 'keydown'].forEach(function (ev) {
      window.addEventListener(ev, function (e) {
        if (ev === 'keydown' && !/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(e.key)) return;
        if (ev === 'keydown' && e.target && /INPUT|TEXTAREA|BUTTON|SELECT/.test(e.target.tagName)) return;
        userScrollUntil = Date.now() + 8000;
      }, { passive: true });
    });

    function highlight(i) {
      if (i === current) return;
      if (paras[current]) paras[current].classList.remove('is-reading');
      current = i;
      if (!paras[i]) return;
      paras[i].classList.add('is-reading');
      if (follow.checked && !au.paused && Date.now() > userScrollUntil) {
        var r = paras[i].getBoundingClientRect(), vh = window.innerHeight;
        if (r.top < vh * 0.18 || r.bottom > vh * 0.82) {
          window.scrollTo({ top: window.scrollY + r.top - vh * 0.3, behavior: reduceMotion ? 'auto' : 'smooth' });
        }
      }
    }
    function sync() {
      if (!times || !paras.length || !started) return;
      var t = au.currentTime, lo = 0, hi = times.length - 1, i = -1;
      if (t < times[0] - 0.05) { highlight(-1); return; }
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (times[mid] <= t + 0.05) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      highlight(i);
    }

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Chapter 1: Porch Light', artist: 'Sergey Alexeev', album: 'Safe Return',
          artwork: [{ src: '/safe-return/img/cover-640.jpg', sizes: '640x1024', type: 'image/jpeg' }]
        });
        navigator.mediaSession.setActionHandler('play', toggle);
        navigator.mediaSession.setActionHandler('pause', toggle);
        navigator.mediaSession.setActionHandler('seekbackward', function () { au.currentTime = Math.max(0, au.currentTime - 15); });
        navigator.mediaSession.setActionHandler('seekforward', function () { au.currentTime = au.currentTime + 30; });
        navigator.mediaSession.setActionHandler('seekto', function (d) { au.currentTime = d.seekTime; });
      } catch (e) {}
    }
    render();

    return {
      attach: function (art) {
        if (!A.timings) return;
        fetch(A.timings, { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
          var ps = art.querySelectorAll('p');
          if (!j || !j.paragraphs || j.paragraphs.length !== ps.length) return;
          paras = Array.prototype.slice.call(ps); times = j.paragraphs;
          box.classList.add('has-follow');
          sync();
        }).catch(function () {});
      }
    };
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
