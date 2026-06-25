// faqutwo live-transcript sink — qutwo-internal fork addition (NOT in upstream TranscripTonic).
//
// Upstream captures captions live and stores the rolling `transcript` array in chrome.storage.local,
// but only fires its webhook at the END of the meeting. For faqutwo we want the transcript LIVE so the
// in-page AI has it as context during the call. This watches that storage key and debounce-POSTs the
// current transcript to the local faqutwo bridge.
//
// Deliberately self-contained and loaded via a single `importScripts("faqutwo-sink.js")` line at the top
// of background.js — it touches NONE of upstream's scraping/webhook code, so `git merge upstream/main`
// stays a clean, near-conflict-free routine. Default endpoint assumes the bridge on this machine;
// override by setting `faqutwoUrl` in chrome.storage.sync.

(function () {
  const DEFAULT_URL = "http://127.0.0.1:8765/transcript";
  const MIN_INTERVAL_MS = 1500;   // throttle bursts; the bridge full-replaces, so a coarse cadence is fine
  const HEARTBEAT = "faqutwo-flush";
  let endpoint = DEFAULT_URL;
  let lastFlush = 0;
  let trailing = null;
  let inFlight = false;

  // Cache the endpoint override at load so flush() needs only ONE async hop before the fetch.
  chrome.storage.sync.get(["faqutwoUrl"], (s) => { if (s && s.faqutwoUrl) endpoint = s.faqutwoUrl; });

  // The content script mirrors the live transcript (committed blocks + the in-progress utterance buffer
  // that upstream only commits on speaker-change/meeting-end) into `faqutwoLive` as a ready-to-POST
  // string. We read that directly. `faqutwoSig` is a persisted signature of the last text we POSTed —
  // skipping unchanged text means we don't re-POST after a call ends, so the bridge transcript can go
  // stale and the chat's "transcript" chip can lapse. Persisting it (vs a module var) survives the event
  // page suspending/waking, which otherwise resets module state and would re-POST stale text on each wake.
  function flush() {
    clearTimeout(trailing); trailing = null;
    lastFlush = Date.now();
    chrome.storage.local.get(["faqutwoLive", "meetingTitle", "meetingSoftware", "faqutwoSig"], (local) => {
      const text = (local && local.faqutwoLive) || "";
      if (!text.trim()) return;
      const sig = text.length + "|" + text.slice(-48);
      if (sig === (local && local.faqutwoSig)) return;   // unchanged since last successful POST — skip
      inFlight = true;
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          meeting: (local && local.meetingTitle) || "",
          source: (local && local.meetingSoftware) || ""
        })
      })
        .then(r => {
          if (r.ok) chrome.storage.local.set({ faqutwoSig: sig });
          console.log("faqutwo-sink: POST", r.status, "—", text.length, "chars");
        })
        .catch(e => console.warn("faqutwo-sink: POST failed —", (e && e.message) || e))
        .finally(() => { inFlight = false; });
    });
  }

  // Leading-edge flush: POST immediately on the first change (the in-flight fetch keeps the event page
  // alive until it completes) and only DELAY when we flushed within MIN_INTERVAL. On every wake module
  // state resets to lastFlush=0, so the first change after a wake always flushes immediately.
  function onChange() {
    const since = Date.now() - lastFlush;
    if (since >= MIN_INTERVAL_MS && !inFlight) {
      flush();
    } else {
      clearTimeout(trailing);
      trailing = setTimeout(flush, Math.max(200, MIN_INTERVAL_MS - since));
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.faqutwoUrl) { endpoint = changes.faqutwoUrl.newValue || DEFAULT_URL; return; }
    if (area === "local" && changes.faqutwoLive) onChange();
  });

  // Heartbeat. storage.onChanged does NOT reliably wake a suspended Firefox event page, so a periodic
  // alarm guarantees we flush the latest live transcript even while the background is idle. The content
  // script keeps `faqutwoLive` current from the always-alive Meet tab; this just wakes us to ship it.
  try {
    chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === HEARTBEAT) flush(); });
  } catch (_) { /* alarms unavailable — fall back to onChanged only */ }

  console.log("faqutwo-sink: loaded → posting live transcript to", endpoint);
})();

// Reliability fix (Firefox). Two upstream gaps break Meet capture in Firefox:
//   1. Content scripts are (re)registered only on permissions.onAdded / onInstalled — never on
//      onStartup — and Firefox doesn't reliably fire onAdded for about:addons permission toggles.
//   2. reRegisterContentScripts() gates Meet on the `wantGoogleMeet` flag, set by the popup's "Google
//      Meet" checkbox — but that checkbox enables via a background-side permissions.request(), which
//      Firefox rejects unless it comes straight from a user gesture, so the checkbox reverts and the
//      flag never sticks. Net effect: even with meet.google.com granted in about:addons, nothing
//      registers, nothing is captured.
// Fix: whenever the background loads (and on startup), if the Meet host IS granted, set
// wantGoogleMeet ourselves (via permissions.contains — no request, no gesture needed) and re-run the
// idempotent reRegisterContentScripts(). This makes "granted the host" == "capture Meet", sidestepping
// the broken checkbox. (User still needs to reload the Meet tab once so the script injects.)
(function () {
  function reassert() {
    try {
      chrome.permissions.contains({ origins: ["https://meet.google.com/*"] }, (granted) => {
        const reReg = () => { try { if (typeof reRegisterContentScripts === "function") reRegisterContentScripts(); } catch (_) {} };
        if (granted) chrome.storage.sync.set({ wantGoogleMeet: true }, reReg); else reReg();
      });
    } catch (_) {}
  }
  if (chrome.runtime && chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(reassert);
  setTimeout(reassert, 3000);   // current background load: background.js (hence reRegisterContentScripts) is defined by now
})();
