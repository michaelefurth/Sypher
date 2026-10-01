/* Sypher Solutions — interactions & motion
   Libraries (vendored in /assets/vendor): GSAP + ScrollTrigger, SplitText, DrawSVGPlugin, Lenis.
   Everything degrades gracefully: without JS, without the libraries, or with
   prefers-reduced-motion, every element renders in its final, readable state. */
(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.remove("no-js");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  var motion = !!(gsap && ScrollTrigger) && !reduceMotion;
  var lenis = null;

  if (!motion) root.classList.remove("motion-pending");

  if (motion) {
    gsap.registerPlugin(ScrollTrigger);
    if (window.SplitText) gsap.registerPlugin(window.SplitText);
    if (window.DrawSVGPlugin) gsap.registerPlugin(window.DrawSVGPlugin);
    root.classList.add("has-motion");
  }

  /* Puzzle board: names sit outside the board on wide screens; on small
     screens they live in the copy panel, so crop the side margins away. */
  var puzzleSvg = document.querySelector(".puzzle__svg");
  if (puzzleSvg) {
    var smallQuery = window.matchMedia("(max-width: 860px)");
    var fitPuzzle = function () {
      puzzleSvg.setAttribute("viewBox", smallQuery.matches ? "-24 -24 348 348" : "-92 -40 490 380");
    };
    fitPuzzle();
    smallQuery.addEventListener("change", fitPuzzle);
  }

  /* ---------------------------------------------------------------------
     Smooth scroll (Lenis), synced with ScrollTrigger
     --------------------------------------------------------------------- */
  if (motion && window.Lenis) {
    lenis = new window.Lenis({ lerp: 0.085, wheelMultiplier: 0.95, anchors: { offset: -96 } });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  /* ---------------------------------------------------------------------
     Header: scrolled state, hide on scroll down / reveal on scroll up
     --------------------------------------------------------------------- */
  var header = document.querySelector(".site-header");
  var lastY = window.scrollY;
  var onScroll = function () {
    var y = window.scrollY;
    if (header) {
      header.classList.toggle("is-scrolled", y > 8);
      var goingDown = y > lastY + 4;
      var goingUp = y < lastY - 4;
      if (goingDown && y > 400) header.classList.add("is-hidden");
      else if (goingUp || y < 120) header.classList.remove("is-hidden");
    }
    lastY = y;
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  if (header) header.addEventListener("focusin", function () { header.classList.remove("is-hidden"); });

  /* Scroll progress hairline */
  var progress = document.querySelector(".scroll-progress");
  if (progress) {
    var setProgress = function () {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = "scaleX(" + (max > 0 ? Math.min(1, window.scrollY / max) : 0) + ")";
    };
    setProgress();
    window.addEventListener("scroll", setProgress, { passive: true });
    window.addEventListener("resize", setProgress);
  }

  /* ---------------------------------------------------------------------
     Mobile navigation
     --------------------------------------------------------------------- */
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      nav.classList.toggle("is-open", open);
      document.body.classList.toggle("nav-open", open);
      if (lenis) open ? lenis.stop() : lenis.start();
    };
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /* ---------------------------------------------------------------------
     Reveals
     --------------------------------------------------------------------- */
  var reveals = document.querySelectorAll(".reveal");
  if (motion) {
    gsap.set(reveals, { opacity: 0, y: 32 });
    ScrollTrigger.batch(reveals, {
      start: "top 90%",
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: "power3.out", stagger: 0.09, overwrite: true });
      }
    });
  } else if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("is-visible"); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  }

  if (motion) {
    /* Hero entrance ---------------------------------------------------- */
    var heroTitle = document.querySelector("[data-split-lines]");
    var heroTl = gsap.timeline({ defaults: { ease: "power4.out" }, delay: 0.15 });
    if (heroTitle && window.SplitText) {
      var split = new window.SplitText(heroTitle, { type: "lines", mask: "lines", linesClass: "line", tag: "span", aria: "none" });
      heroTl.from(split.lines, { yPercent: 115, duration: 1.4, stagger: 0.14 }, 0);
    }
    root.classList.remove("motion-pending");
    var heroFades = document.querySelectorAll("[data-hero-fade]");
    if (heroFades.length) heroTl.from(heroFades, { opacity: 0, y: 22, duration: 1.2, stagger: 0.12, ease: "power3.out" }, 0.35);
    var heroArt = document.querySelector("[data-hero-art]");
    if (heroArt) {
      heroTl.from(heroArt, { scale: 0.94, rotate: -6, yPercent: 3, duration: 2, ease: "expo.out" }, 0); // stays visible: it is the LCP element
      gsap.to(heroArt, {
        yPercent: 14, rotate: 5, ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true }
      });
    }
    var heroThread = document.querySelector(".hero__thread path");
    if (heroThread && window.DrawSVGPlugin) heroTl.from(heroThread, { drawSVG: "0%", duration: 2.6, ease: "power2.inOut" }, 0.2);

    /* Statement: words light up as you read ----------------------------- */
    document.querySelectorAll("[data-split-words]").forEach(function (el) {
      if (!window.SplitText) return;
      var words = new window.SplitText(el, { type: "words", tag: "span", aria: "none" }).words;
      // A colour shift (rather than opacity) keeps resting text above WCAG large-text contrast.
      var finals = words.map(function (w) { return getComputedStyle(w).color; });
      gsap.fromTo(words, { color: "#7F8A92" }, {
        color: function (i) { return finals[i]; }, stagger: 0.06, ease: "none",
        scrollTrigger: { trigger: el, start: "top 85%", end: "center 55%", scrub: 0.6 }
      });
    });

    /* Gold rules draw in ---------------------------------------------- */
    document.querySelectorAll("[data-rule], .rule-gold").forEach(function (el) {
      gsap.fromTo(el, { scaleX: 0, transformOrigin: "0 50%" }, {
        scaleX: 1, duration: 1.4, ease: "power3.inOut",
        scrollTrigger: { trigger: el, start: "top 90%", once: true }
      });
    });

    /* Count-up figures -------------------------------------------------- */
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var target = parseInt(el.getAttribute("data-count"), 10);
      var obj = { v: 0 };
      el.textContent = "0";
      gsap.to(obj, {
        v: target, duration: target > 9 ? 1.8 : 1.2, ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
        onUpdate: function () { el.textContent = Math.round(obj.v); }
      });
    });

    /* Image curtain reveals --------------------------------------------- */
    document.querySelectorAll("[data-clip]").forEach(function (el) {
      var img = el.querySelector("img");
      var tl = gsap.timeline({ scrollTrigger: { trigger: el, start: "top 85%", once: true } });
      tl.to(el, { clipPath: "inset(0% 0 0 0)", duration: 1.4, ease: "expo.inOut" });
      if (img) tl.from(img, { scale: 1.25, duration: 1.8, ease: "expo.out" }, 0.2);
    });

    /* Method: golden thread draws across the steps ---------------------- */
    var methodWrap = document.querySelector(".method-wrap");
    var methodThread = methodWrap && methodWrap.querySelector(".method__thread");
    if (methodThread) {
      var placeThread = function () {
        var img = methodWrap.querySelector(".method__img");
        if (img) methodWrap.style.setProperty("--thread-top", (img.offsetHeight / 2 - 30) + "px");
      };
      placeThread();
      window.addEventListener("resize", placeThread);
      if (window.DrawSVGPlugin) {
        gsap.from(methodThread.querySelector("path"), {
          drawSVG: "0%", ease: "none",
          scrollTrigger: { trigger: methodWrap, start: "top 75%", end: "bottom 60%", scrub: 0.8 }
        });
      }
    }

    /* The Missing Piece ------------------------------------------------- */
    var puzzle = document.querySelector("[data-puzzle]");
    if (puzzle) buildPuzzle(puzzle);

    /* Magnetic buttons -------------------------------------------------- */
    if (finePointer) {
      document.querySelectorAll("[data-magnetic]").forEach(function (btn) {
        var xTo = gsap.quickTo(btn, "x", { duration: 0.5, ease: "power3.out" });
        var yTo = gsap.quickTo(btn, "y", { duration: 0.5, ease: "power3.out" });
        btn.addEventListener("pointermove", function (e) {
          var r = btn.getBoundingClientRect();
          xTo((e.clientX - r.left - r.width / 2) * 0.22);
          yTo((e.clientY - r.top - r.height / 2) * 0.35);
        });
        btn.addEventListener("pointerleave", function () { xTo(0); yTo(0); });
      });
    }

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
  }

  function buildPuzzle(section) {
    var pieces = gsap.utils.toArray(section.querySelectorAll(".pz-p"));
    var paths = section.querySelectorAll(".pz-piece");
    var labelLayer = section.querySelector(".pz-labels");
    var labelFor = function (key) { return section.querySelector('.pz-label[data-practice="' + key + '"]'); };
    var allLabels = section.querySelectorAll(".pz-label");
    var gold = section.querySelector(".pz-gold");
    var glow = section.querySelector(".pz-gold__glow");
    var slot = section.querySelector(".pz-slot");
    var hint = section.querySelector(".puzzle__hint");
    var intro = section.querySelector('[data-panel="intro"]');
    var practicePanels = gsap.utils.toArray(section.querySelectorAll(".puzzle__panel--practice"));
    var finalPanel = section.querySelector('[data-panel="final"]');
    var lines = finalPanel.querySelectorAll("[data-puzzle-line]");
    var sub = finalPanel.querySelector("[data-puzzle-sub]");
    var cta = finalPanel.querySelector("[data-puzzle-cta]");
    var ticks = gsap.utils.toArray(section.querySelectorAll(".puzzle__progress li"));

    // Deterministic scatter so the composition is the same on every visit
    var seed = 11;
    var rand = function (min, max) { seed = (seed * 9301 + 49297) % 233280; return min + (seed / 233280) * (max - min); };
    var scatter = pieces.map(function () { return { x: rand(-190, 190), y: rand(-150, 150), r: rand(-38, 38) }; });

    var STEP = 1;            // timeline units per practice
    var FIRST = 1.6;         // when the first practice appears
    var STORY_END = FIRST + practicePanels.length * STEP;
    var SNAP = STORY_END + 1.5;

    var build = function () {
      var tl = gsap.timeline({ defaults: { ease: "power2.out" } });
      gsap.set(practicePanels.concat(finalPanel), { autoAlpha: 0 });
      gsap.set(intro, { autoAlpha: 1 });

      // 1. The board assembles from scattered pieces
      tl.from(pieces, {
        x: function (i) { return scatter[i].x; },
        y: function (i) { return scatter[i].y; },
        rotation: function (i) { return scatter[i].r; },
        opacity: 0.18, scale: 0.82, transformOrigin: "50% 50%",
        duration: 1.2, stagger: { each: 0.05, from: "random" }
      }, 0)
        .from(intro, { y: 30, opacity: 0, duration: 0.6 }, 0)
        .to(hint, { opacity: 0, duration: 0.3 }, 0.2)
        .from(labelLayer, { opacity: 0, duration: 0.4 }, 1.0)
        .to(pieces, { opacity: 0.32, duration: 0.3 }, FIRST - 0.3)
        .to(allLabels, { opacity: 0.4, duration: 0.3 }, FIRST - 0.3);

      // 2. Each practice lights its piece while the copy tells its story
      practicePanels.forEach(function (panel, i) {
        var t = FIRST + i * STEP;
        var key = panel.getAttribute("data-panel");
        var piece = section.querySelector('.pz-p[data-practice="' + key + '"]');
        var prevPanel = i === 0 ? intro : practicePanels[i - 1];
        var prevPiece = i === 0 ? null : section.querySelector('.pz-p[data-practice="' + practicePanels[i - 1].getAttribute("data-panel") + '"]');
        tl.to(prevPanel, { autoAlpha: 0, y: -24, duration: 0.3, ease: "power2.in" }, t)
          .fromTo(panel, { autoAlpha: 0, y: 28 }, { autoAlpha: 1, y: 0, duration: 0.4 }, t + 0.32)
          .fromTo(panel.querySelectorAll(".puzzle__chips li"), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.05 }, t + 0.4);
        if (piece) tl.to(piece, { opacity: 1, scale: 1.07, duration: 0.4, transformOrigin: "50% 50%" }, t + 0.15)
          .to(labelFor(key), { opacity: 1, scale: 1.12, duration: 0.4, transformOrigin: "50% 50%" }, t + 0.15);
        if (prevPiece) {
          var prevKey = practicePanels[i - 1].getAttribute("data-panel");
          tl.to(prevPiece, { opacity: 0.72, scale: 1, duration: 0.4 }, t + 0.15)
            .to(labelFor(prevKey), { opacity: 0.75, scale: 1, duration: 0.4 }, t + 0.15);
        }
      });

      // 3. Every piece in place; the Sypher piece completes the picture
      var last = practicePanels[practicePanels.length - 1];
      tl.to(last, { autoAlpha: 0, y: -24, duration: 0.3, ease: "power2.in" }, STORY_END)
        .to(pieces, { opacity: 1, scale: 1, duration: 0.5, stagger: { each: 0.03, from: "center" } }, STORY_END)
        .to(allLabels, { opacity: 1, scale: 1, duration: 0.5 }, STORY_END)
        .set(finalPanel, { autoAlpha: 1 }, STORY_END + 0.3)
        .from(finalPanel.querySelector(".eyebrow"), { opacity: 0, y: 16, duration: 0.4 }, STORY_END + 0.3)
        .from(lines[0], { yPercent: 60, opacity: 0, duration: 0.5 }, STORY_END + 0.45)
        .from(slot, { opacity: 0, scale: 0.6, transformOrigin: "50% 50%", duration: 0.4 }, STORY_END + 0.1)
        .from(gold, {
          x: 340, y: -230, rotation: 120, scale: 1.3, opacity: 0, transformOrigin: "50% 50%",
          duration: 1.3, ease: "power3.inOut"
        }, STORY_END + 0.2)
        .to(gold, { scale: 1.08, duration: 0.18, ease: "power2.out", transformOrigin: "50% 50%" }, SNAP)
        .to(gold, { scale: 1, duration: 0.35, ease: "back.out(3)" }, SNAP + 0.18)
        .fromTo(glow, { opacity: 0.4 }, { opacity: 1, duration: 0.25, yoyo: true, repeat: 1 }, SNAP)
        .to(slot, { opacity: 0, duration: 0.2 }, SNAP + 0.05)
        .to(paths, { stroke: "rgba(243, 227, 195, 0.75)", duration: 0.2, yoyo: true, repeat: 1, stagger: { each: 0.015, from: "center" } }, SNAP + 0.05)
        .from(lines[1], { yPercent: 60, opacity: 0, duration: 0.5 }, SNAP + 0.1)
        .from(sub, { opacity: 0, y: 24, duration: 0.5 }, SNAP + 0.5)
        .from(cta, { opacity: 0, y: 24, duration: 0.5 }, SNAP + 0.7)
        .to({}, { duration: 0.6 });

      // Progress ticks follow the playhead (works scrolling up or down)
      var marks = practicePanels.map(function (_, i) { return FIRST + i * STEP + 0.2; }).concat(SNAP);
      tl.eventCallback("onUpdate", function () {
        var t = tl.time(), active = -1;
        marks.forEach(function (m, i) { if (t >= m) active = i; });
        ticks.forEach(function (li, i) {
          li.classList.toggle("is-active", i === active);
          li.classList.toggle("is-done", i < active);
        });
      });

      ScrollTrigger.create({
        animation: tl, trigger: section, start: "top top",
        end: function () { return "+=" + Math.round(window.innerHeight * 0.62 * tl.duration()); },
        scrub: 0.9, pin: section.querySelector(".puzzle__pin"), anticipatePin: 1, invalidateOnRefresh: true
      });
      return tl;
    };

    var mm = gsap.matchMedia();
    mm.add("all", build);
  }

  /* ---------------------------------------------------------------------
     Animated accordions (FAQ + Problem Index)
     --------------------------------------------------------------------- */
  document.querySelectorAll(".faq details, .prow details").forEach(function (details) {
    var summary = details.querySelector("summary");
    var body = summary && summary.nextElementSibling;
    if (!summary || !body || !motion) return;
    summary.addEventListener("click", function (e) {
      e.preventDefault();
      if (details.open) {
        gsap.to(body, {
          height: 0, opacity: 0, duration: 0.45, ease: "power2.inOut",
          onComplete: function () { details.open = false; gsap.set(body, { clearProps: "height,opacity,overflow" }); ScrollTrigger.refresh(); }
        });
      } else {
        details.open = true;
        gsap.fromTo(body, { height: 0, opacity: 0, overflow: "hidden" }, {
          height: "auto", opacity: 1, duration: 0.6, ease: "power3.out",
          onComplete: function () { gsap.set(body, { clearProps: "height,overflow" }); ScrollTrigger.refresh(); }
        });
      }
    });
  });

  /* ---------------------------------------------------------------------
     Problem Index: search + practice filters (+ ?p=practice deep links)
     --------------------------------------------------------------------- */
  document.querySelectorAll("[data-pindex]").forEach(function (index) {
    var input = index.querySelector("[data-pindex-search]");
    var buttons = index.querySelectorAll(".pfilter");
    var rows = Array.prototype.slice.call(index.querySelectorAll(".prow"));
    var count = index.querySelector("[data-pindex-count]");
    var empty = index.querySelector(".pindex__empty");
    var active = "all";
    var normalize = function (s) { return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9& ]+/g, " "); };
    rows.forEach(function (row) { row._text = normalize(row.textContent); });

    var apply = function () {
      var terms = normalize(input ? input.value : "").split(/\s+/).filter(Boolean);
      var shown = [];
      rows.forEach(function (row) {
        var okPractice = active === "all" || row.getAttribute("data-practice") === active;
        var okTerms = terms.every(function (t) { return row._text.indexOf(t) !== -1; });
        var visible = okPractice && okTerms;
        if (visible && row.hidden) shown.push(row);
        row.hidden = !visible;
      });
      index.querySelectorAll(".pgroup").forEach(function (g) {
        var key = g.getAttribute("data-group");
        g.hidden = !rows.some(function (r) { return !r.hidden && r.getAttribute("data-practice") === key; });
      });
      var n = rows.filter(function (r) { return !r.hidden; }).length;
      if (count) count.textContent = n;
      if (empty) empty.hidden = n !== 0;
      if (motion && shown.length) {
        gsap.fromTo(shown, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.03, ease: "power2.out", overwrite: true });
      }
      if (motion) ScrollTrigger.refresh();
    };

    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        active = btn.getAttribute("data-filter");
        buttons.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", String(on));
        });
        apply();
      });
    });
    if (input) input.addEventListener("input", apply);

    var p = new URLSearchParams(window.location.search).get("p");
    if (p) {
      var match = index.querySelector('.pfilter[data-filter="' + p.replace(/[^a-z]/g, "") + '"]');
      if (match) match.click();
    }
  });

  /* ---------------------------------------------------------------------
     Services sub-navigation: highlight the section in view
     --------------------------------------------------------------------- */
  var svcLinks = document.querySelectorAll(".svc-nav a");
  if (svcLinks.length && "IntersectionObserver" in window) {
    var map = {};
    svcLinks.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var svcIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        svcLinks.forEach(function (a) { a.classList.remove("is-active"); });
        var link = map[entry.target.id];
        if (link) {
          link.classList.add("is-active");
          var bar = link.closest("ul");
          if (bar) bar.scrollTo({ left: link.offsetLeft - bar.clientWidth / 2 + link.clientWidth / 2, behavior: "smooth" });
        }
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    document.querySelectorAll(".svc[id]").forEach(function (s) { svcIo.observe(s); });
  }

  /* Footer year */
  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });

  /* ---------------------------------------------------------------------
     Contact form
     With data-endpoint (e.g. a Formspree URL) the form posts via fetch;
     otherwise it composes a pre-filled email so no enquiry is ever lost.
     --------------------------------------------------------------------- */
  var form = document.getElementById("contact-form");
  if (form) {
    var status = form.querySelector(".form__status");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.querySelector(".hp input").value) return; // honeypot
      if (!form.checkValidity()) { form.reportValidity(); return; }

      var data = new FormData(form);
      var interests = data.getAll("interests[]").join(", ") || "Not specified";
      var endpoint = form.getAttribute("data-endpoint");

      if (endpoint) {
        status.textContent = "Sending…";
        fetch(endpoint, { method: "POST", body: data, headers: { Accept: "application/json" } })
          .then(function (r) {
            if (!r.ok) throw new Error("Request failed");
            form.reset();
            status.textContent = "Thank you. Your note is with Michael, who will be in touch personally.";
          })
          .catch(function () {
            status.textContent = "Something went wrong. Please email michael@sypher.solutions directly.";
          });
        return;
      }

      var body = [
        "Name: " + data.get("name"),
        "Email: " + data.get("email"),
        "Organization: " + (data.get("company") || "—"),
        "Stage: " + (data.get("stage") || "—"),
        "Interested in: " + interests,
        "Timeline: " + (data.get("timeline") || "—"),
        "",
        data.get("message")
      ].join("\n");
      var subject = "Consultation request — " + (data.get("company") || data.get("name"));
      window.location.href = "mailto:michael@sypher.solutions?subject=" +
        encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      status.textContent = "Your email app should open with your note ready to send.";
    });
  }
})();
