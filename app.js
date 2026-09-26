(function () {
  "use strict";

  /* ---------------- supabase client ---------------- */

  var SUPABASE_URL = "https://xfnpsctsoihlyxzqovum.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_rbut6CU_fLAt9k-qt5eaFg_PwN5K-w_";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  var SECTIONS = [];
  var SERMONS = [];
  var VERSES = {};

  var SECTIONS_BY_ID = {};
  var SERMONS_BY_ID = {};
  var SERMONS_BY_SECTION = {};

  var NOTES = {};
  var BOOKMARKS = {};

  var session = null;
  var appReady = false;
  var dataLoading = false;
  var loadErrorMsg = null;

  var ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

  var AUDIENCES = [
    { value: "children", en: "Sunday School Sermons", te: "ఆదివార పాఠశాల ప్రసంగములు", blurb: "For the children — told as a story, with pictures, and the references underneath." },
    { value: "youth", en: "Youth Meeting Sermons", te: "యువజన కూటపు ప్రసంగములు", blurb: "For the young people — direct, honest, anchored on Christ and the apostles, with living examples." },
    { value: "general", en: "General Sermons", te: "సాధారణ ప్రసంగములు", blurb: "The full doctrinal course, for the pulpit and the quiet room." },
    { value: "worship", en: "Worship Sermons", te: "ఆరాధన ప్రసంగములు", blurb: "On the worship of God — what He asked for, how the apostles kept it, and what it costs to bring it." }
  ];

  /* ---------------- local, device-only UI prefs (language/theme/tab) ---------------- */

  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  var LANG_KEY = "bibleSermons.language";
  var THEME_KEY = "bibleSermons.theme";

  /* ---------------- notes/bookmarks (Supabase-backed, in-memory cache) ---------------- */

  function getNote(id) { return NOTES[id] || ""; }

  function saveNote(id, text) {
    var trimmed = text && text.trim();
    if (trimmed) NOTES[id] = text; else delete NOTES[id];
    if (!session) return Promise.resolve(false);
    if (trimmed) {
      return sb.from("notes")
        .upsert({ user_id: session.user.id, sermon_id: id, body: text, updated_at: new Date().toISOString() }, { onConflict: "user_id,sermon_id" })
        .then(function (r) { if (r.error) { console.error(r.error); return false; } return true; });
    }
    return sb.from("notes").delete().eq("user_id", session.user.id).eq("sermon_id", id)
      .then(function (r) { if (r.error) { console.error(r.error); return false; } return true; });
  }

  function getBookmarks() { return BOOKMARKS; }
  function isBookmarked(id) { return !!BOOKMARKS[id]; }
  function toggleBookmark(id) {
    if (!session) return;
    if (BOOKMARKS[id]) {
      delete BOOKMARKS[id];
      sb.from("bookmarks").delete().eq("user_id", session.user.id).eq("sermon_id", id)
        .then(function (r) { if (r.error) console.error(r.error); });
    } else {
      BOOKMARKS[id] = Date.now();
      sb.from("bookmarks")
        .upsert({ user_id: session.user.id, sermon_id: id, created_at: new Date().toISOString() }, { onConflict: "user_id,sermon_id" })
        .then(function (r) { if (r.error) console.error(r.error); });
    }
  }

  /* ---------------- reading language ---------------- */

  var language = (function () {
    var v = safeGet(LANG_KEY);
    return v === "en" || v === "te" || v === "both" ? v : "both";
  })();

  function showEn() { return language !== "te"; }
  function showTe() { return language !== "en"; }
  function setLanguage(v) {
    language = v;
    safeSet(LANG_KEY, v);
    render();
  }

  /* ---------------- theme ---------------- */

  var theme = safeGet(THEME_KEY) || "auto";
  function applyTheme() {
    var root = document.documentElement;
    if (theme === "light") root.setAttribute("data-theme", "light");
    else if (theme === "dark") root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
  }
  function cycleTheme() {
    theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    safeSet(THEME_KEY, theme);
    applyTheme();
    renderThemeBtn();
  }
  applyTheme();

  /* ---------------- original language of scripture ---------------- */

  var NEW_TESTAMENT = {};
  ["matthew","mark","luke","john","acts","romans","1 corinthians","2 corinthians","galatians","ephesians","philippians","colossians","1 thessalonians","2 thessalonians","1 timothy","2 timothy","titus","philemon","hebrews","james","1 peter","2 peter","1 john","2 john","3 john","jude","revelation"].forEach(function (b) { NEW_TESTAMENT[b] = true; });
  var OLD_TESTAMENT = {};
  ["genesis","exodus","leviticus","numbers","deuteronomy","joshua","judges","ruth","1 samuel","2 samuel","1 kings","2 kings","1 chronicles","2 chronicles","ezra","nehemiah","esther","job","psalm","psalms","proverbs","ecclesiastes","song of solomon","isaiah","jeremiah","lamentations","ezekiel","daniel","hosea","joel","amos","obadiah","jonah","micah","nahum","habakkuk","zephaniah","haggai","zechariah","malachi"].forEach(function (b) { OLD_TESTAMENT[b] = true; });

  var ARAMAIC_RANGES = {
    daniel: [{ from: [2, 5], to: [7, 28] }],
    ezra: [{ from: [4, 8], to: [6, 18] }, { from: [7, 12], to: [7, 26] }]
  };
  var MIXED_BOOKS = { daniel: true, ezra: true };

  function normaliseBook(book) {
    return book.trim().toLowerCase().replace(/\.$/, "")
      .replace(/^(i{1,3})\s+/, function (m, n) { return n.length + " "; })
      .replace(/^first\s+/, "1 ").replace(/^second\s+/, "2 ").replace(/^third\s+/, "3 ")
      .replace(/\s+/g, " ");
  }

  function parseRef(ref) {
    var m = ref.trim().match(/^(.+?)\s+(\d+):(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) return { book: ref.trim(), chapter: 0, vf: 0, vt: null };
    return { book: m[1].trim(), chapter: +m[2], vf: +m[3], vt: m[4] ? +m[4] : null };
  }

  function cmp(a, b) { return a[0] - b[0] || a[1] - b[1]; }
  function within(p, from, to) { return cmp(p, from) >= 0 && cmp(p, to) <= 0; }

  function tagAt(book, pos) {
    if (book === "genesis" && pos[0] === 31 && pos[1] === 47) {
      return { key: "hebrew", short: "Heb.", en: "Hebrew", te: "హీబ్రూ", noteEn: "Hebrew, except Laban's two Aramaic words — Jegar-sahadutha, the heap of witness." };
    }
    if (book === "daniel" && pos[0] === 2 && pos[1] === 4) {
      return { key: "mixed", short: "Heb./Aram.", en: "Hebrew and Aramaic", te: "హీబ్రూ మరియు అరామిక్", noteEn: "The verse opens in Hebrew and turns to Aramaic at “O king, live for ever” — the language the book keeps until the end of chapter 7." };
    }
    var ranges = ARAMAIC_RANGES[book];
    if (ranges) {
      for (var i = 0; i < ranges.length; i++) {
        if (within(pos, ranges[i].from, ranges[i].to)) {
          return { key: "aramaic", short: "Aram.", en: "Aramaic", te: "అరామిక్" };
        }
      }
    }
    return { key: "hebrew", short: "Heb.", en: "Hebrew", te: "హీబ్రూ" };
  }

  function originalLanguage(ref) {
    var p = parseRef(ref);
    var key = normaliseBook(p.book);
    if (NEW_TESTAMENT[key]) return { key: "greek", short: "Gk.", en: "Greek", te: "గ్రీకు" };
    if (!OLD_TESTAMENT[key]) return null;
    if (p.chapter === 0) return MIXED_BOOKS[key] ? null : { key: "hebrew", short: "Heb.", en: "Hebrew", te: "హీబ్రూ" };
    var start = tagAt(key, [p.chapter, p.vf]);
    if (p.vt === null || p.vt === p.vf) return start;
    var end = tagAt(key, [p.chapter, p.vt]);
    if (start.key === end.key) return start;
    return { key: "mixed", short: "Heb./Aram.", en: "Hebrew and Aramaic", te: "హీబ్రూ మరియు అరామిక్" };
  }

  /* ---------------- small html helpers ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var INLINE_ALLOWED = { em: 1, strong: 1, b: 1, i: 1, mark: 1, u: 1 };

  /** Renders the sermon's small inline markup subset (em/strong/mark/u) safely. */
  function richText(input) {
    if (!input) return "";
    var out = "";
    var re = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s+class="([A-Za-z0-9_-]+)")?\s*>/g;
    var last = 0, m, stack = [];
    var CANON = { i: "em", em: "em", b: "strong", strong: "strong", mark: "mark", u: "u" };
    while ((m = re.exec(input)) !== null) {
      var tag = m[1].toLowerCase();
      if (!INLINE_ALLOWED[tag]) continue;
      if (m.index > last) out += esc(input.slice(last, m.index));
      if (m[0].indexOf("</") === 0) {
        if (stack.length && stack[stack.length - 1] === CANON[tag]) {
          out += "</" + stack.pop() + ">";
        }
      } else {
        var canon = CANON[tag];
        if (canon === "mark") {
          var cls = ["hl-yellow", "hl-green", "hl-blue", "hl-pink"].indexOf(m[2]) !== -1 ? m[2] : null;
          out += cls ? '<mark class="' + cls + '">' : "<mark>";
        } else {
          out += "<" + canon + ">";
        }
        stack.push(canon);
      }
      last = m.index + m[0].length;
    }
    if (last < input.length) out += esc(input.slice(last));
    while (stack.length) out += "</" + stack.pop() + ">";
    return out;
  }

  function refBtn(ref) {
    var text = VERSES[ref];
    var lang = originalLanguage(ref);
    var badge = lang ? '<span class="lang">' + esc(lang.short) + '</span>' : "";
    if (!text) {
      return '<span class="refPlain">' + esc(ref) + badge + '</span>';
    }
    return '<button type="button" class="refBtn" data-ref="' + esc(ref) + '">' + esc(ref) + badge + '</button>';
  }

  function refRow(refs) {
    if (!refs || !refs.length) return "";
    return '<div class="refRow">' + refs.map(refBtn).join("") + '</div>';
  }

  function diglot(enArr, teArr, opts) {
    opts = opts || {};
    var variant = opts.variant || "body";
    var rows = Math.max((enArr || []).length, (teArr || []).length);
    var both = showEn() && showTe();
    var pClassEn = variant === "scripture" ? "scripture" : variant === "lead" ? "lead" : "pEn";
    var pClassTe = variant === "scripture" ? "scripture" : variant === "lead" ? "lead" : "pTe";
    var out = "";
    for (var i = 0; i < rows; i++) {
      var en = (enArr && enArr[i]) || "";
      var te = (teArr && teArr[i]) || "";
      if (!showEn() && !te) continue;
      if (!showTe() && !en) continue;
      out += '<div class="drow ' + (both ? "paired" : "single") + '">';
      if (showEn()) out += '<p class="' + pClassEn + '">' + richText(en) + '</p>';
      if (showTe()) out += '<p class="' + pClassTe + '">' + richText(te || en) + '</p>';
      out += '</div>';
    }
    return '<div class="diglot' + (variant !== 'body' ? ' ' + variant + 'Block' : '') + '">' + out + '</div>';
  }

  /* ---------------- verse popover ---------------- */

  var popEl = null;
  function closePopover() {
    if (popEl) { popEl.remove(); popEl = null; }
  }
  function openPopover(btn) {
    closePopover();
    var ref = btn.getAttribute("data-ref");
    var text = VERSES[ref];
    if (!text) return;
    var lang = originalLanguage(ref);
    var div = document.createElement("div");
    div.className = "versePop";
    var langLine = "";
    if (lang) {
      var names = [];
      if (showEn()) names.push(lang.en);
      if (showTe()) names.push(lang.te);
      langLine = '<span>Written in <strong>' + esc(names.join(" · ")) + '</strong></span>';
    }
    div.innerHTML =
      '<div class="versePopRef">' + esc(ref) + '</div>' +
      '<p class="versePopText">' + esc(text) + '</p>' +
      '<div class="versePopFoot"><span>King James Version</span>' + langLine + '</div>' +
      (lang && lang.noteEn && showEn() ? '<p class="versePopText" style="font-family:var(--font-ui);font-style:normal;font-size:0.76rem;color:var(--muted);margin-top:0.4rem">' + esc(lang.noteEn) + '</p>' : '');
    document.body.appendChild(div);
    var r = btn.getBoundingClientRect();
    var top = r.bottom + 8;
    var left = Math.min(r.left, window.innerWidth - div.offsetWidth - 16);
    left = Math.max(16, left);
    if (top + div.offsetHeight > window.innerHeight - 12) top = r.top - div.offsetHeight - 8;
    div.style.top = top + "px";
    div.style.left = left + "px";
    popEl = div;
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".refBtn");
    if (btn) { e.stopPropagation(); openPopover(btn); return; }
    if (popEl && !popEl.contains(e.target)) closePopover();
  });
  window.addEventListener("scroll", closePopover, true);
  window.addEventListener("resize", closePopover);

  /* ---------------- shell (masthead) ---------------- */

  var NAV = [
    { to: "#/", en: "Home", te: "ముఖపేజీ" },
    { to: "#/order", en: "Sermons", te: "ప్రసంగములు" },
    { to: "#/saved", en: "Saved", te: "దాచినవి" }
  ];

  function renderMasthead() {
    var mastheadEl = document.getElementById("masthead");

    if (!session || !appReady) {
      mastheadEl.innerHTML =
        '<div class="mastheadInner">' +
        '<a class="brand" href="#/"><span class="top">Bible</span><span class="bottom">Sermons</span></a>' +
        '<nav class="nav"></nav>' +
        '<div class="tools"><button type="button" id="themeBtn" class="iconBtn" title="Theme"></button></div>' +
        '</div>';
      document.getElementById("themeBtn").addEventListener("click", cycleTheme);
      renderThemeBtn();
      return;
    }

    var hash = location.hash || "#/";
    var navHtml = NAV.map(function (n) {
      var active = (n.to === "#/" && hash === "#/") || (n.to !== "#/" && hash.indexOf(n.to) === 0);
      return '<a class="navLink ' + (active ? "active" : "") + '" href="' + n.to + '"><span>' + n.en + '</span>' + (showTe() ? ' <span style="font-family:var(--font-telugu)">' + n.te + '</span>' : '') + '</a>';
    }).join("");

    mastheadEl.innerHTML =
      '<div class="mastheadInner">' +
      '<a class="brand" href="#/"><span class="top">Bible</span><span class="bottom">Sermons</span></a>' +
      '<nav class="nav">' + navHtml + '</nav>' +
      '<div class="tools">' +
      '<div class="langGroup" role="group" aria-label="Reading language">' +
      langBtn("en", "English") + langBtn("both", "Both") + langBtn("te", "తెలుగు", true) +
      '</div>' +
      '<button type="button" id="themeBtn" class="iconBtn" title="Theme"></button>' +
      '<button type="button" id="signOutBtn" class="iconBtn" title="Sign out — ' + esc(session.user.email || "") + '">⎋</button>' +
      '</div>' +
      '</div>';

    document.querySelectorAll(".langGroup .langItem").forEach(function (b) {
      b.addEventListener("click", function () { setLanguage(b.getAttribute("data-lang")); });
    });
    document.getElementById("themeBtn").addEventListener("click", cycleTheme);
    document.getElementById("signOutBtn").addEventListener("click", function () { sb.auth.signOut(); });
    renderThemeBtn();
  }

  function langBtn(val, label, telugu) {
    return '<button type="button" class="langItem ' + (telugu ? "telugu" : "") + ' ' + (language === val ? "active" : "") + '" data-lang="' + val + '">' + label + '</button>';
  }

  var THEME_ICONS = {
    light: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
    dark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 14.5a8.5 8.5 0 1 1-9-13 7 7 0 0 0 9 13z"/></svg>',
    auto: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>'
  };
  function renderThemeBtn() {
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    btn.innerHTML = THEME_ICONS[theme] || THEME_ICONS.auto;
    btn.title = "Theme: " + theme + " (click to change)";
  }

  /* ---------------- auth ---------------- */

  var authMode = "signin"; // signin | signup | reset
  var authError = null;
  var authNotice = null;
  var authBusy = false;

  function pageAuth() {
    return (
      '<div class="authWrap"><div class="authCard">' +
      '<div class="orn">✦</div>' +
      '<h1 class="authTitle">Bible <em>Sermons</em></h1>' +
      '<p class="authSub">Sign in to read, take notes, and save sermons — synced across your devices.</p>' +
      (authError ? '<p class="authError">' + esc(authError) + '</p>' : '') +
      (authNotice ? '<p class="authNotice">' + esc(authNotice) + '</p>' : '') +
      '<form id="authForm" class="authForm">' +
      '<label class="authLabel">Email<input type="email" id="authEmail" required autocomplete="email"></label>' +
      (authMode !== "reset" ? '<label class="authLabel">Password<input type="password" id="authPassword" required minlength="6" autocomplete="' + (authMode === "signup" ? "new-password" : "current-password") + '"></label>' : '') +
      '<button type="submit" class="btn primary authSubmit"' + (authBusy ? " disabled" : "") + '>' +
      (authBusy ? "Please wait…" : (authMode === "signup" ? "Create account" : authMode === "reset" ? "Send reset link" : "Sign in")) +
      '</button>' +
      '</form>' +
      '<div class="authLinks">' +
      (authMode === "signin" ? '<button type="button" class="linklike" data-mode="signup">Need an account? Create one</button><button type="button" class="linklike" data-mode="reset">Forgot password?</button>' : '') +
      (authMode === "signup" ? '<button type="button" class="linklike" data-mode="signin">Already have an account? Sign in</button>' : '') +
      (authMode === "reset" ? '<button type="button" class="linklike" data-mode="signin">Back to sign in</button>' : '') +
      '</div>' +
      '</div></div>'
    );
  }

  function wireAuthForm() {
    document.querySelectorAll(".authLinks .linklike").forEach(function (b) {
      b.addEventListener("click", function () {
        authMode = b.getAttribute("data-mode");
        authError = null; authNotice = null;
        render();
      });
    });
    var form = document.getElementById("authForm");
    if (form) form.addEventListener("submit", handleAuthSubmit);
  }

  function handleAuthSubmit(e) {
    e.preventDefault();
    var email = document.getElementById("authEmail").value.trim();
    var password = authMode !== "reset" ? document.getElementById("authPassword").value : null;
    authError = null; authNotice = null; authBusy = true; render();

    if (authMode === "signup") {
      sb.auth.signUp({ email: email, password: password }).then(function (r) {
        authBusy = false;
        if (r.error) {
          authError = r.error.message;
        } else if (r.data && r.data.session) {
          // signed in immediately (email confirmation not required) — onAuthStateChange takes over
          return;
        } else {
          authNotice = "Check your email to confirm your account, then sign in below.";
          authMode = "signin";
        }
        render();
      });
    } else if (authMode === "reset") {
      sb.auth.resetPasswordForEmail(email).then(function (r) {
        authBusy = false;
        if (r.error) { authError = r.error.message; } else { authNotice = "If that email is registered, a reset link has been sent."; }
        authMode = "signin";
        render();
      });
    } else {
      sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
        authBusy = false;
        if (r.error) { authError = r.error.message; render(); }
        // on success, onAuthStateChange fires and render() follows from there
      });
    }
  }

  /* ---------------- data loading ---------------- */

  function rowToSection(r) {
    return {
      id: r.id, slug: r.slug, position: r.position, audience: r.audience,
      titleEn: r.title_en, titleTe: r.title_te,
      subtitleEn: r.subtitle_en, subtitleTe: r.subtitle_te,
      summaryEn: r.summary_en, summaryTe: r.summary_te
    };
  }

  function rowToSermon(r) {
    return {
      id: r.id, sectionId: r.section_id, sequence: r.sequence,
      titleEn: r.title_en, titleTe: r.title_te,
      subtitleEn: r.subtitle_en, subtitleTe: r.subtitle_te,
      keyRef: r.key_ref, thesisEn: r.thesis_en, thesisTe: r.thesis_te,
      minutes: r.minutes, audience: r.audience, status: r.status,
      imageUrl: r.image_url, bodyEn: r.body_en, bodyTe: r.body_te,
      createdAt: r.created_at
    };
  }

  function buildIndexes() {
    SECTIONS_BY_ID = {};
    SECTIONS.forEach(function (s) { SECTIONS_BY_ID[s.id] = s; });

    SERMONS_BY_ID = {};
    SERMONS.forEach(function (s) { SERMONS_BY_ID[s.id] = s; });

    SERMONS_BY_SECTION = {};
    SERMONS.forEach(function (s) {
      (SERMONS_BY_SECTION[s.sectionId] = SERMONS_BY_SECTION[s.sectionId] || []).push(s);
    });
    Object.keys(SERMONS_BY_SECTION).forEach(function (k) {
      SERMONS_BY_SECTION[k].sort(function (a, b) { return a.sequence - b.sequence; });
    });
  }

  function loadData() {
    return Promise.all([
      sb.from("sections").select("*").order("position"),
      sb.from("sermons").select("*").order("sequence"),
      sb.from("verses").select("ref,text_kjv"),
      sb.from("notes").select("sermon_id,body"),
      sb.from("bookmarks").select("sermon_id,created_at")
    ]).then(function (results) {
      for (var i = 0; i < results.length; i++) {
        if (results[i].error) throw results[i].error;
      }
      SECTIONS = results[0].data.map(rowToSection);
      SERMONS = results[1].data.map(rowToSermon);

      VERSES = {};
      results[2].data.forEach(function (v) { VERSES[v.ref] = v.text_kjv; });

      NOTES = {};
      results[3].data.forEach(function (n) { NOTES[n.sermon_id] = n.body; });

      BOOKMARKS = {};
      results[4].data.forEach(function (b) { BOOKMARKS[b.sermon_id] = new Date(b.created_at).getTime(); });

      buildIndexes();
    });
  }

  function handleAuthChange(newSession) {
    session = newSession;
    if (session) {
      if (!appReady && !dataLoading) {
        dataLoading = true;
        loadErrorMsg = null;
        loadData().then(function () {
          appReady = true; dataLoading = false;
          render();
        }).catch(function (e) {
          dataLoading = false;
          loadErrorMsg = (e && e.message) || String(e);
          render();
        });
        render();
      } else {
        render();
      }
    } else {
      appReady = false;
      dataLoading = false;
      loadErrorMsg = null;
      SECTIONS = []; SERMONS = []; VERSES = {}; NOTES = {}; BOOKMARKS = {};
      authMode = "signin"; authError = null; authNotice = null;
      render();
    }
  }

  sb.auth.onAuthStateChange(function (_event, s) { handleAuthChange(s); });

  /* ---------------- loading / error pages ---------------- */

  function pageLoading() {
    return '<div class="loadingWrap"><div class="loadingCard"><div class="orn">✦</div><p>Loading your library…</p></div></div>';
  }

  function pageLoadError() {
    return (
      '<div class="loadingWrap"><div class="loadingCard"><div class="orn">✦</div>' +
      '<p class="authError">' + esc(loadErrorMsg || "Something went wrong loading your data.") + '</p>' +
      '<button type="button" class="btn primary" id="retryLoadBtn">Try again</button>' +
      '</div></div>'
    );
  }

  /* ---------------- pages ---------------- */

  function pageHome() {
    var releasedSermons = SERMONS.filter(function (s) { return s.status === "released"; });
    var recent = releasedSermons.slice(-6).reverse();

    var cards = recent.map(function (s) { return sermonCardHtml(s); }).join("");

    var sectionList = SECTIONS.filter(function (s) { return s.audience === "general"; })
      .concat(SECTIONS.filter(function (s) { return s.audience !== "general"; }))
      .map(function (s, i) {
        var count = (SERMONS_BY_SECTION[s.id] || []).length;
        return '<li class="sectionRow"><a href="#/order/' + s.audience + '#section-' + s.slug + '">' +
          '<span class="roman">' + (ROMAN[s.position - 1] || s.position) + '</span>' +
          '<span class="sectionTitles">' +
          (showEn() ? '<span class="sectionEn">' + esc(s.titleEn) + '</span>' : '') +
          (showTe() ? '<span class="sectionTe">' + esc(s.titleTe) + '</span>' : '') +
          '</span>' +
          '<span class="sectionCount">' + count + '</span>' +
          '</a></li>';
      }).join("");

    return (
      '<section class="frontis">' +
      '<div class="orn">✦</div>' +
      '<h1 class="title1">Bible <em>Sermons</em></h1>' +
      (showTe() ? '<p class="titleTe1">బైబిలు ప్రసంగములు</p>' : '') +
      '<p class="standfirst">A private reading desk. Every sermon is set in English and Telugu together, anchored to the exact King James text, held to the doctrine the apostles taught, and carried by a documented account of someone who staked a life on it.</p>' +
      '<blockquote class="epigraph">“They continued stedfastly in the apostles’ doctrine and fellowship, and in breaking of bread, and in prayers.”<cite>Acts 2:42 · King James Version</cite></blockquote>' +
      '</section>' +
      '<section class="homeBlock">' +
      '<div class="sectionHead2"><div><div class="eyebrow">Recently added</div><h2 class="h2">Recent Readings</h2></div></div>' +
      '<div class="grid">' + (cards || '<p class="emptyState">Nothing yet.</p>') + '</div>' +
      '</section>' +
      '<section class="homeBlock" style="border-bottom:none">' +
      '<div class="sectionHead2"><div><div class="eyebrow">The index</div><h2 class="h2">The Order of Reading</h2></div>' +
      '<a class="moreLink" href="#/order">Open the full index →</a></div>' +
      '<p class="orderNote">The library is not a heap. It is laid out as a way to walk — from who God is, through what He made, to what went wrong and what He has done about it.</p>' +
      '<ol class="sectionList">' + sectionList + '</ol>' +
      '</section>'
    );
  }

  function sermonCardHtml(s) {
    var lang = originalLanguage(s.keyRef);
    return (
      '<a class="card" href="#/sermon/' + s.id + '">' +
      '<div class="cardTop"><span class="cardRef">' + esc(s.keyRef) + (lang ? '<span class="lang">' + esc(lang.short) + '</span>' : '') + '</span>' +
      (isBookmarked(s.id) ? '<span class="cardMark" title="Saved">❖</span>' : '') +
      '</div>' +
      (showEn() ? '<h3 class="cardTitleEn">' + esc(s.titleEn) + '</h3>' : '') +
      (showTe() ? '<h3 class="cardTitleTe">' + esc(s.titleTe) + '</h3>' : '') +
      (showEn() && s.subtitleEn ? '<p class="cardSubEn">' + esc(s.subtitleEn) + '</p>' : '') +
      (showTe() && s.subtitleTe ? '<p class="cardSubTe">' + esc(s.subtitleTe) + '</p>' : '') +
      '<div class="cardMeta"><span>' + s.minutes + ' min</span>' + (getNote(s.id) ? '<span class="noted">Noted</span>' : '') + '</div>' +
      '</a>'
    );
  }

  function pageOrder(defaultAudience) {
    var audience = defaultAudience || safeGet("bibleSermons.audience") || "general";
    var counts = { general: 0, children: 0, youth: 0, worship: 0 };
    SECTIONS.forEach(function (s) { counts[s.audience] = (counts[s.audience] || 0) + (SERMONS_BY_SECTION[s.id] || []).length; });

    var tabs = AUDIENCES.map(function (a) {
      return '<button type="button" class="tab ' + (audience === a.value ? "active" : "") + '" data-aud="' + a.value + '">' +
        '<span>' + a.en + '</span><span class="te">' + a.te + '</span><span class="tabCount">' + (counts[a.value] || 0) + '</span></button>';
    }).join("");

    var active = AUDIENCES.filter(function (a) { return a.value === audience; })[0];
    var sections = SECTIONS.filter(function (s) { return s.audience === audience; });

    var sectionsHtml = sections.map(function (s) {
      var sermons = SERMONS_BY_SECTION[s.id] || [];
      var rows = sermons.map(function (sm, i) {
        var lang = originalLanguage(sm.keyRef);
        return '<li class="orow"><a href="#/sermon/' + sm.id + '">' +
          '<span class="onum">' + s.position + '.' + (i + 1) + '</span>' +
          '<span class="orowTitles">' +
          (showEn() ? '<span class="orowEn">' + esc(sm.titleEn) + (sm.status !== 'released' ? ' <span class="draftBadge">draft</span>' : '') + '</span>' : '') +
          (showTe() ? '<span class="orowTe">' + esc(sm.titleTe) + '</span>' : '') +
          '</span>' +
          '<span class="orowRef">' + esc(sm.keyRef) + (lang ? '<span class="lang">' + esc(lang.short) + '</span>' : '') + '</span>' +
          '</a></li>';
      }).join("");

      return '<section class="osection" id="section-' + s.slug + '">' +
        '<div class="osectionHead"><span class="roman">' + (ROMAN[s.position - 1] || s.position) + '</span>' +
        '<div>' +
        (showEn() ? '<h2 class="h2">' + esc(s.titleEn) + '</h2>' : '') +
        (showTe() ? '<div class="h2Te" style="font-family:var(--font-telugu);font-size:1.15rem;font-weight:600">' + esc(s.titleTe) + '</div>' : '') +
        (showEn() && s.subtitleEn ? '<p class="osubEn">' + esc(s.subtitleEn) + '</p>' : '') +
        (showTe() && s.subtitleTe ? '<p class="osubTe">' + esc(s.subtitleTe) + '</p>' : '') +
        '</div></div>' +
        (showEn() && s.summaryEn ? '<p class="osummaryEn">' + esc(s.summaryEn) + '</p>' : '') +
        (showTe() && s.summaryTe ? '<p class="osummaryTe">' + esc(s.summaryTe) + '</p>' : '') +
        (rows ? '<ol class="olist">' + rows + '</ol>' : '<p class="pending">Nothing here yet.</p>') +
        '</section>';
    }).join("");

    setTimeout(function () {
      document.querySelectorAll(".tabs .tab").forEach(function (b) {
        b.addEventListener("click", function () {
          var aud = b.getAttribute("data-aud");
          safeSet("bibleSermons.audience", aud);
          location.hash = "#/order/" + aud;
        });
      });
      var target = location.hash.split("#")[2];
      if (target) {
        var el = document.getElementById(target);
        if (el) setTimeout(function () { el.scrollIntoView({ block: "start" }); }, 30);
      }
    }, 0);

    return (
      '<header class="pageHead">' +
      '<div class="eyebrow">The index</div><h1 class="h1">Choose a Sermon</h1>' +
      (showTe() ? '<p class="headTe">ఒక ప్రసంగమును ఎన్నుకొనుము</p>' : '') +
      '<p class="intro">Four categories, each laid out by topic. Pick the category, then the topic, then the sermon.</p>' +
      '<p class="langKey">Every reference carries the language that portion of Scripture was written in — <strong>Heb.</strong> Hebrew · <strong>Aram.</strong> Aramaic · <strong>Gk.</strong> Greek.</p>' +
      '</header>' +
      '<div class="tabs" role="tablist">' + tabs + '</div>' +
      (active ? '<p class="blurb">' + esc(active.blurb) + '</p>' : '') +
      '<div class="actionsRow"><button type="button" class="btn" id="printIndexBtn">⎙ Print this index</button></div>' +
      sectionsHtml
    );
  }

  function pageSaved() {
    var bm = getBookmarks();
    var ids = Object.keys(bm).sort(function (a, b) { return bm[b] - bm[a]; });
    var sermons = ids.map(function (id) { return SERMONS_BY_ID[id]; }).filter(Boolean);
    return (
      '<header class="pageHead"><div class="eyebrow">Your desk</div><h1 class="h1">Saved Sermons</h1>' +
      (showTe() ? '<p class="headTe">దాచిన ప్రసంగములు</p>' : '') +
      '<p class="intro">Sermons you have marked to come back to. Synced to your account.</p></header>' +
      (sermons.length ? '<div class="savedList grid">' + sermons.map(sermonCardHtml).join("") + '</div>' : '<p class="emptyState">Nothing saved yet. Open a sermon and press “Save”.</p>')
    );
  }

  function pageSermon(id) {
    var s = SERMONS_BY_ID[id];
    if (!s) return '<p class="emptyState">That sermon could not be found. <a href="#/order">Back to the index.</a></p>';
    var section = SECTIONS_BY_ID[s.sectionId];
    var en = s.bodyEn, te = s.bodyTe;
    var list = SERMONS_BY_SECTION[s.sectionId] || [];
    var idx = list.findIndex(function (x) { return x.id === s.id; });
    var prev = idx > 0 ? list[idx - 1] : null;
    var next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
    var bookmarked = isBookmarked(s.id);
    var lang = originalLanguage(s.keyRef);

    var movementsHtml = en.movements.map(function (m, i) {
      var tm = te.movements[i] || {};
      var points = m.points || [];
      var body;
      if (points.length) {
        body = '<ol class="pointList">' + points.map(function (p, j) {
          var tp = (tm.points && tm.points[j]) || {};
          var both = showEn() && showTe();
          var rows = Math.max((p.explain || []).length, (tp.explain || []).length);
          var explainHtml = "";
          for (var k = 0; k < rows; k++) {
            explainHtml += '<div class="explainRow ' + (both ? "paired" : "") + '">' +
              (showEn() ? '<p class="explainEn">' + richText((p.explain || [])[k] || "") + '</p>' : '') +
              (showTe() ? '<p class="explainTe">' + richText((tp.explain || [])[k] || "") + '</p>' : '') +
              '</div>';
          }
          return '<li class="pointItem"><span class="pointNum">' + (j + 1) + '</span><div class="pointBody">' +
            '<div class="pointRow ' + (both ? "paired" : "") + '">' +
            (showEn() ? '<p class="pointTextEn">' + richText(p.text) + '</p>' : '') +
            (showTe() && tp.text ? '<p class="pointTextTe">' + richText(tp.text) + '</p>' : '') +
            '</div>' + explainHtml + refRow(p.refs) + '</div></li>';
        }).join("") + '</ol>';
      } else {
        body = diglot(m.paras, tm.paras);
      }
      return '<section class="movement"><div class="movementHead"><span class="movementNum">' + esc(m.n) + '</span><div>' +
        (showEn() ? '<h2 class="h2m">' + esc(m.head) + '</h2>' : '') +
        (showTe() && tm.head ? '<div class="h2mTe">' + esc(tm.head) + '</div>' : '') +
        '</div></div>' + body + refRow(m.refs) + '</section>';
    }).join("");

    var apostolicHtml = en.apostolic.body ? (
      '<section class="panel"><div class="panelLabel">The Apostolic Witness' + (showTe() ? ' <span class="te">· అపొస్తలుల సాక్ష్యము</span>' : '') + '</div>' +
      diglot([en.apostolic.body], [te.apostolic.body]) + refRow(en.apostolic.refs) + '</section>'
    ) : "";

    var guardHtml = en.guard ? (
      '<section class="panel guard"><div class="panelLabel">Guard the Doctrine' + (showTe() ? ' <span class="te">· సిద్ధాంతమును కాపాడుము</span>' : '') + '</div>' +
      diglot([en.guard], [te.guard]) + '</section>'
    ) : "";

    var storyHtml = en.story.paras.length ? (
      '<section class="storySection"><div class="panelLabel">A Life That Believed It' + (showTe() ? ' <span class="te">· దీనిని నమ్మిన జీవితము</span>' : '') + '</div>' +
      (showEn() ? '<h2 class="h2m">' + esc(en.story.title) + '</h2>' : '') +
      (showTe() && te.story.title ? '<div class="h2mTe">' + esc(te.story.title) + '</div>' : '') +
      diglot(en.story.paras, te.story.paras) +
      (en.story.src ? '<p class="source">Source: ' + esc(en.story.src) + '</p>' : '') +
      '</section>'
    ) : "";

    var applicationHtml = en.application.length ? (
      '<section class="movement"><div class="movementHead"><span class="movementNum">✦</span><div>' +
      (showEn() ? '<h2 class="h2m">Taking it home</h2>' : '') +
      (showTe() ? '<div class="h2mTe">దీనిని ఇంటికి తీసుకొనిపోవుట</div>' : '') +
      '</div></div><ol class="appList">' + en.application.map(function (a, i) {
        var both = showEn() && showTe();
        return '<li class="appItem"><span class="appMark">—</span><div class="appRow ' + (both ? "paired" : "") + '">' +
          (showEn() ? '<p class="appEn">' + richText(a) + '</p>' : '') +
          (showTe() ? '<p class="appTe">' + richText(te.application[i] || "") + '</p>' : '') +
          '</div></li>';
      }).join("") + '</ol></section>'
    ) : "";

    var conclusionEn = en.conclusion || [], conclusionTe = te.conclusion || [];
    var both = showEn() && showTe();
    var conclusionHtml = '<section class="conclusionSection"><div class="panelLabel">Conclusion' + (showTe() ? ' <span class="te">· ముగింపు</span>' : '') + '</div>' +
      conclusionEn.map(function (c, i) {
        return '<div class="conclRow ' + (both ? "paired" : "") + '">' +
          (showEn() ? '<p class="conclEn">' + richText(c) + '</p>' : '') +
          (showTe() ? '<p class="conclTe">' + richText(conclusionTe[i] || "") + '</p>' : '') +
          '</div>';
      }).join("") +
      (en.charge ? '<div class="chargeRow"><div class="chargeLabel">The closing charge</div>' +
        (showEn() ? '<p class="chargeEn">' + richText(en.charge) + '</p>' : '') +
        (showTe() ? '<p class="chargeTe">' + richText(te.charge) + '</p>' : '') +
        '</div>' : '') +
      '</section>';

    var xrefsHtml = en.xrefs.length ? '<section class="xrefsSection"><div class="panelLabel">Read alongside</div>' + refRow(en.xrefs) + '</section>' : "";

    var summaryEn = en.summary || [], summaryTe = te.summary || [];
    var summaryHtml = summaryEn.length ? (
      '<section class="summarySection" id="sermon-notes-' + s.id + '"><div class="summaryHead"><div><div class="panelLabel" style="margin-bottom:0.15rem">Notes — the sermon in points</div>' +
      (showTe() ? '<div class="te" style="font-family:var(--font-telugu);color:var(--muted);font-size:0.85rem">గమనికలు — ప్రసంగము ముఖ్యాంశములలో</div>' : '') +
      '</div></div><ol class="summaryList">' + summaryEn.map(function (p, i) {
        var tp = summaryTe[i] || {};
        return '<li class="summaryItem">' +
          (showEn() ? '<p class="sumPointEn">' + richText(p.point) + '</p>' : '') +
          (showTe() && tp.point ? '<p class="sumPointTe">' + richText(tp.point) + '</p>' : '') +
          refRow(p.refs) + '</li>';
      }).join("") + '</ol></section>'
    ) : "";

    var noteVal = getNote(s.id);
    var notesHtml =
      '<section class="notesSection"><div class="notesHead"><div><span style="font-family:var(--font-display);font-weight:500;font-size:1.1rem">My Preaching Notes</span>' +
      (showTe() ? '<span class="notesTitleTe">నా ప్రసంగ గమనికలు</span>' : '') +
      '</div><span class="notesStatus" id="noteStatus"></span></div>' +
      '<textarea class="notesArea" id="noteArea" placeholder="Where you will preach this, whom it is for, the illustration you want to use, the line you must not forget…">' + esc(noteVal) + '</textarea>' +
      '</section>';

    var imgHtml = s.imageUrl ? '<img class="hero" src="https://bible-sermons.floot.app' + esc(s.imageUrl) + '" alt="" loading="lazy" onerror="this.remove()">' : "";

    setTimeout(function () {
      var bmBtn = document.getElementById("bookmarkBtn");
      if (bmBtn) bmBtn.addEventListener("click", function () {
        toggleBookmark(s.id);
        render();
      });
      var printBtn = document.getElementById("printSermonBtn");
      if (printBtn) printBtn.addEventListener("click", function () { window.print(); });
      var area = document.getElementById("noteArea");
      var status = document.getElementById("noteStatus");
      if (area) {
        var timer = null;
        area.addEventListener("input", function () {
          status.textContent = "Saving…";
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            var p = saveNote(s.id, area.value);
            if (p && p.then) {
              p.then(function (ok) { status.textContent = ok ? "Saved" : "Error saving"; });
            } else {
              status.textContent = "Saved";
            }
          }, 500);
        });
      }
    }, 0);

    return (
      '<div class="sermonBar">' +
      '<a class="backLink" href="#/order/' + s.audience + '">← Index</a>' +
      '<button type="button" class="btn ' + (bookmarked ? "active" : "") + '" id="bookmarkBtn">' + (bookmarked ? "❖ Saved" : "Save") + '</button>' +
      '<button type="button" class="btn" id="printSermonBtn">⎙ Print</button>' +
      (s.status !== 'released' ? '<span class="draftBadge">Draft — not yet reviewed</span>' : '') +
      '<span class="barSpacer"></span>' +
      (prev ? '<a class="navPN" href="#/sermon/' + prev.id + '">← Previous</a>' : '') +
      (next ? '<a class="navPN" href="#/sermon/' + next.id + '">Next →</a>' : '') +
      '</div>' +
      '<article class="article">' +
      '<header class="shead">' +
      '<div class="sEyebrow">' + section.position + '. ' + esc(section.titleEn) + (showTe() ? ' <span class="te">· ' + esc(section.titleTe) + '</span>' : '') + '</div>' +
      imgHtml +
      (showEn() ? '<h1 class="sH1">' + esc(s.titleEn) + '</h1>' : '') +
      (showTe() ? '<h1 class="sH1Te">' + esc(s.titleTe) + '</h1>' : '') +
      (showEn() && s.subtitleEn ? '<p class="sSubEn">' + esc(s.subtitleEn) + '</p>' : '') +
      (showTe() && s.subtitleTe ? '<p class="sSubTe">' + esc(s.subtitleTe) + '</p>' : '') +
      '<div class="sMeta">' + refBtn(s.keyRef) + '<span>·</span><span>' + s.minutes + ' min</span></div>' +
      '</header>' +
      '<section class="keyTextBlock"><div class="keyRefLine">' + esc(s.keyRef) + (lang ? '<span class="lang">' + esc(lang.short) + '</span>' : '') + '</div>' +
      diglot([en.keyText], [te.keyText || en.keyText], { variant: "scripture" }) +
      '</section>' +
      '<div class="thesisBlock">' + diglot([s.thesisEn], [s.thesisTe], { variant: "lead" }) + '</div>' +
      movementsHtml + apostolicHtml + guardHtml + storyHtml + applicationHtml + conclusionHtml + xrefsHtml + summaryHtml + notesHtml +
      '</article>'
    );
  }

  /* ---------------- router ---------------- */

  function parseHash() {
    var h = (location.hash || "#/").replace(/^#/, "");
    var clean = h.split("#")[0];
    var parts = clean.split("/").filter(Boolean);
    return parts;
  }

  function render() {
    closePopover();
    document.title = "Bible Sermons";

    if (!session) {
      renderMasthead();
      document.getElementById("main").innerHTML = pageAuth();
      wireAuthForm();
      window.scrollTo(0, 0);
      return;
    }

    if (loadErrorMsg) {
      renderMasthead();
      document.getElementById("main").innerHTML = pageLoadError();
      var retryBtn = document.getElementById("retryLoadBtn");
      if (retryBtn) retryBtn.addEventListener("click", function () { handleAuthChange(session); });
      window.scrollTo(0, 0);
      return;
    }

    if (!appReady) {
      renderMasthead();
      document.getElementById("main").innerHTML = pageLoading();
      window.scrollTo(0, 0);
      return;
    }

    renderMasthead();
    var parts = parseHash();
    var html;
    if (parts.length === 0) {
      html = pageHome();
    } else if (parts[0] === "order") {
      html = pageOrder(parts[1]);
      document.title = "The Index · Bible Sermons";
    } else if (parts[0] === "saved") {
      html = pageSaved();
      document.title = "Saved · Bible Sermons";
    } else if (parts[0] === "sermon" && parts[1]) {
      var sm = SERMONS_BY_ID[parts[1]];
      html = pageSermon(parts[1]);
      if (sm) document.title = sm.titleEn + " · Bible Sermons";
    } else {
      html = pageHome();
    }
    document.getElementById("main").innerHTML = html;
    var printIndexBtn = document.getElementById("printIndexBtn");
    if (printIndexBtn) printIndexBtn.addEventListener("click", function () { window.print(); });
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", render);
  window.addEventListener("DOMContentLoaded", render);
  if (document.readyState !== "loading") render();
})();
