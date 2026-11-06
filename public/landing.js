/* Testbench landing page — small, self-contained enhancements for public/landing.html.
   The page is complete without this file: it only adds reveal-on-scroll, the ticking run
   timer, the typing prompt, and swaps a demo slot's placeholder for a real <video> when that
   slot has a data-video URL. Nothing here talks to the app or any /api route. */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- demo video slots ----------------------------------------------------------------
  // An empty data-video keeps the placeholder and requests nothing (so no 404 in the console).
  var slots = document.querySelectorAll(".lp-video");
  for (var s = 0; s < slots.length; s++) {
    var slot = slots[s];
    var src = (slot.getAttribute("data-video") || "").trim();
    if (!src) continue;
    var v = document.createElement("video");
    v.src = src;
    v.controls = true;
    v.preload = "metadata";
    v.playsInline = true;
    var poster = (slot.getAttribute("data-poster") || "").trim();
    if (poster) v.poster = poster;
    v.setAttribute("aria-label", slot.getAttribute("data-label") || "Demo video");
    slot.innerHTML = "";
    slot.appendChild(v);
  }

  if (reduce) return; // finished state is already what the CSS shows

  // ---- reveal on scroll ----------------------------------------------------------------
  var items = document.querySelectorAll(".lp-reveal");
  if ("IntersectionObserver" in window && items.length) {
    document.body.classList.add("lp-js");
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          entries[i].target.classList.add("lp-in");
          io.unobserve(entries[i].target);
        }
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    for (var r = 0; r < items.length; r++) io.observe(items[r]);
  }

  // ---- ticking run timer ---------------------------------------------------------------
  var clock = document.querySelector("[data-lp-clock]");
  if (clock) {
    var secs = 41;
    setInterval(function () {
      secs = secs >= 59 * 60 ? 0 : secs + 1;
      var m = Math.floor(secs / 60), sec = secs % 60;
      clock.textContent = "00:" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    }, 1000);
  }

  // ---- typing prompt -------------------------------------------------------------------
  var typed = document.querySelector("[data-lp-type]");
  if (typed) {
    var full = typed.getAttribute("data-lp-type") || "";
    var n = 0, hold = 0;
    typed.textContent = "";
    setInterval(function () {
      if (n < full.length) { n++; typed.textContent = full.slice(0, n); return; }
      if (++hold > 60) { n = 0; hold = 0; typed.textContent = ""; } // ~2.7s pause, then retype
    }, 45);
  }
})();
