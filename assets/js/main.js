/* Sypher Solutions — site interactions (no dependencies) */
(function () {
  "use strict";
  document.documentElement.classList.remove("no-js");

  // Sticky header state
  var header = document.querySelector(".site-header");
  var onScroll = function () {
    if (header) header.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // Mobile navigation
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      nav.classList.toggle("is-open", open);
      document.body.classList.toggle("nav-open", open);
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

  // Scroll reveal
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  }

  // Services sub-navigation: highlight the section in view
  var svcLinks = document.querySelectorAll(".svc-nav a");
  if (svcLinks.length && "IntersectionObserver" in window) {
    var map = {};
    svcLinks.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var svcIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          svcLinks.forEach(function (a) { a.classList.remove("is-active"); });
          var link = map[entry.target.id];
          if (link) {
            link.classList.add("is-active");
            link.scrollIntoView({ block: "nearest", inline: "center" });
          }
        }
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    document.querySelectorAll(".svc[id]").forEach(function (s) { svcIo.observe(s); });
  }

  // Footer year
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });

  // Contact form
  // If the form has a data-endpoint (e.g. a Formspree URL), submit via fetch.
  // Otherwise, compose a pre-filled email so no enquiry is ever lost.
  var form = document.getElementById("contact-form");
  if (form) {
    var status = form.querySelector(".form__status");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.querySelector(".hp input").value) return; // honeypot
      if (!form.checkValidity()) { form.reportValidity(); return; }

      var data = new FormData(form);
      var interests = data.getAll("interests").join(", ") || "Not specified";
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
