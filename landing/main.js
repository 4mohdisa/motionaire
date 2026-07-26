// Motionaire landing — vanilla JS only. Three jobs:
// 1. typed prompt in the hero composer, 2. scroll reveals via
// IntersectionObserver, 3. the scrub playhead + timecode in the nav.
// Content is never gated on JS: the `js` class opts into pre-reveal
// states, and a safety timer force-reveals everything after 1.6s.

(function () {
  'use strict';

  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduced = motionQuery.matches;
  if (motionQuery.addEventListener)
    motionQuery.addEventListener('change', function (e) {
      reduced = e.matches;
    });

  // Opt into animation states only when JS actually runs (and only for
  // browsers with IntersectionObserver — everyone else gets a static page).
  if ('IntersectionObserver' in window && !reduced) {
    document.documentElement.classList.add('js');
  }

  // Safety net: if the observer never delivers a single entry (pathological
  // environments only), reveal everything. A TRUE fallback — when IO works,
  // this must not fire, or every below-fold reveal would be pre-spent long
  // before the user scrolls to it.
  var ioWorked = false;
  setTimeout(function () {
    if (ioWorked) return;
    document.querySelectorAll('.reveal, .feature').forEach(function (el) {
      el.classList.add('in');
    });
    var diff = document.getElementById('diff');
    if (diff) diff.classList.add('in');
  }, 1600);

  /* ------------------------------------------------ typed prompt */

  var PROMPT =
    'From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom ' +
    'right, screen share fills the rest, then back to fullscreen.';
  var typed = document.getElementById('typed');
  var caret = document.getElementById('caret');
  var diffCard = document.getElementById('diff');

  // The full sentence ships as static HTML (no-JS users see it complete);
  // typing only replaces it when motion is actually wanted.
  if (reduced || !('IntersectionObserver' in window)) {
    if (diffCard) diffCard.classList.add('in');
  } else if (typed) {
    typed.textContent = '';
    var i = 0;
    var startDelay = 700;
    function tick() {
      if (i <= PROMPT.length) {
        typed.textContent = PROMPT.slice(0, i);
        i += 1;
        // Human-ish cadence: fast base, brief pause after punctuation.
        var ch = PROMPT.charAt(i - 2);
        var d = 26 + Math.random() * 34;
        if (ch === ',' || ch === '.') d += 220;
        setTimeout(tick, d);
      } else {
        if (caret) caret.style.display = 'none';
        if (diffCard) diffCard.classList.add('in');
      }
    }
    setTimeout(tick, startDelay);
  }

  /* ------------------------------------------------ scroll reveals */

  if ('IntersectionObserver' in window && !reduced) {
    var io = new IntersectionObserver(
      function (entries) {
        ioWorked = true;
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );
    document.querySelectorAll('.reveal, .feature').forEach(function (el) {
      io.observe(el);
    });
  }

  /* ------------------------------------------------ scrub + parallax */

  var playhead = document.getElementById('playhead');
  var tc = document.getElementById('tc');
  var shots = Array.prototype.slice.call(document.querySelectorAll('[data-parallax]'));
  var raf = null;

  function frame() {
    raf = null;
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;

    // The page is a 60-second timeline; scrolling scrubs it. Under
    // reduced motion the scrub stays parked — nothing on screen moves.
    if (playhead && !reduced) playhead.style.left = (p * 100).toFixed(3) + '%';
    if (tc && !reduced) {
      var totalFrames = Math.round(p * 60 * 30); // 60s @ 30fps
      var s = Math.floor(totalFrames / 30);
      var f = totalFrames % 30;
      var mm = String(Math.floor(s / 60)).padStart(2, '0');
      var ss = String(s % 60).padStart(2, '0');
      var ff = String(f).padStart(2, '0');
      tc.textContent = '00:' + mm + ':' + ss + ':' + ff;
    }

    // Gentle parallax on screenshots: ±10px around viewport center.
    if (!reduced) {
      for (var k = 0; k < shots.length; k++) {
        var r = shots[k].getBoundingClientRect();
        var mid = r.top + r.height / 2 - window.innerHeight / 2;
        var t = Math.max(-1, Math.min(1, mid / (window.innerHeight / 2)));
        shots[k].style.transform = 'translateY(' + (t * 10).toFixed(2) + 'px)';
      }
    }
  }

  function onScroll() {
    if (raf === null) raf = requestAnimationFrame(frame);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  frame();
})();
