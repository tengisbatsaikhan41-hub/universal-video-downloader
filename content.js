// Universal Video Downloader — content script
// Scans the page (and re-scans on DOM changes) for <video> elements and
// reports them to the background service worker. Also answers requests to
// fetch blob: URLs, which only resolve inside the document that created them
// — and, when that blob is a live MediaSource (not a plain static Blob, the
// case for most streaming players), asks page-hook.js for the bytes it
// already captured as they were appended for playback.

function collectVideos() {
  const found = [];
  const seen = new Set();

  document.querySelectorAll("video").forEach((videoEl) => {
    const candidates = [videoEl.currentSrc, videoEl.src];
    videoEl.querySelectorAll("source").forEach((s) => candidates.push(s.src));

    for (const src of candidates) {
      if (!src || seen.has(src)) continue;
      seen.add(src);
      found.push({
        url: src,
        isBlob: src.startsWith("blob:"),
        duration: Number.isFinite(videoEl.duration) ? videoEl.duration : null,
        poster: videoEl.poster || null,
        mime: videoEl.querySelector("source")?.type || null,
      });
    }
  });

  return found;
}

function reportVideos() {
  const videos = collectVideos();
  if (videos.length === 0) return;
  chrome.runtime.sendMessage({
    action: "domVideoFound",
    videos,
    pageTitle: document.title,
    pageUrl: location.href,
  });
}

// Initial scan, then watch for players that mount/change their <video> src later.
reportVideos();
let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(reportVideos, 500);
});
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });

// A few delayed re-scans catch players that take a moment to initialize.
[1000, 3000, 6000].forEach((ms) => setTimeout(reportVideos, ms));

// "HH:MM:SS.mmm" (videos under 24 h)
function vttTime(seconds) {
  return new Date(seconds * 1000).toISOString().slice(11, 23);
}

// Players that show captions through the <video>'s own text tracks (a <track>
// file, or cues added by script) — send those cues as a caption file, the
// same way the YouTube capture does. Cues only exist once CC is switched on.
const sentCaptionCounts = new Map(); // lang -> cue count already sent
function reportTextTracks() {
  for (const videoEl of document.querySelectorAll("video")) {
    for (const track of videoEl.textTracks) {
      const cues = Array.from(track.cues || []).filter((c) => typeof c.text === "string" && c.text.trim());
      if (!cues.length) continue;
      const lang = track.language || track.label || "captions";
      if (sentCaptionCounts.get(lang) === cues.length) continue;
      sentCaptionCounts.set(lang, cues.length);
      let text = "WEBVTT\n\n";
      for (const c of cues) text += `${vttTime(c.startTime)} --> ${vttTime(c.endTime)}\n${c.text}\n\n`;
      chrome.runtime.sendMessage({ action: "captionCaptured", lang, fmt: "vtt", text, pageTitle: document.title });
    }
  }
}
setInterval(reportTextTracks, 3000);

// page-hook.js (MAIN world) reports YouTube's caption track list this way —
// it's a page global, not something an isolated-world content script can
// read directly.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.__uvdResponse === "youtubeCaptions") {
    const tracks = event.data.tracks || [];
    if (tracks.length === 0) return;
    chrome.runtime.sendMessage({ action: "captionsFound", tracks, pageTitle: document.title });
  } else if (event.data?.__uvdResponse === "youtubeCaptionCaptured") {
    const { lang, fmt, text } = event.data;
    chrome.runtime.sendMessage({ action: "captionCaptured", lang, fmt, text, pageTitle: document.title });
  }
});
window.postMessage({ __uvdRequest: "getCapturedCaptions" }, "*");

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

// A MediaSource-backed blob: URL (most streaming players, not just simple
// <video src="blob:..."> clips) can't be fetch()'d — there's no fixed file
// behind it. Ask page-hook.js (running in the page's own MAIN world) for
// the bytes it captured as the player appended them for playback.
// Returns one Blob per SourceBuffer track (usually 1 for a simple file, or
// 2 — video + audio — for sites that stream them separately).
function getMseChunks(url) {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for captured playback data."));
    }, 60000);

    function onMessage(event) {
      if (event.source !== window || event.data?.__uvdResponse !== "mseChunks" || event.data.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (!event.data.hasData) {
        reject(new Error("No playback data captured — reload the page, start the video, then try again."));
      } else {
        resolve(event.data.tracks.map((t) => new Blob([t.buffer], { type: t.mime || "video/mp4" })));
      }
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ __uvdRequest: "getMseChunks", url, requestId }, "*");
  });
}

// Has page-hook.js play the video through from the start (muted, fast) so
// the player loads — and the capture records — the whole thing, not just
// what was watched. Relays progress to the background for the badge.
function runFullCapture(url) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    function onMessage(event) {
      if (event.source !== window || event.data?.requestId !== requestId) return;
      if (event.data.__uvdResponse === "captureProgress") {
        chrome.runtime.sendMessage({ action: "captureProgress", percent: event.data.percent }).catch(() => {});
      } else if (event.data.__uvdResponse === "captureDone") {
        window.removeEventListener("message", onMessage);
        resolve(event.data.url || url);
      }
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ __uvdRequest: "captureFull", url, requestId }, "*");
  });
}

async function captureBlobTracks(url) {
  try {
    // A plain (non-MediaSource) blob is already a complete file.
    return [await (await fetch(url)).blob()];
  } catch {
    const finalUrl = await runFullCapture(url);
    return getMseChunks(finalUrl);
  }
}

// chrome.runtime messages cap out at 64MiB and a full video is often far
// bigger, so the bytes go through extension storage (shared with the
// background service worker) in 8MB base64 pieces; only the keys travel in
// the message.
const STORAGE_CHUNK_BYTES = 8 * 1024 * 1024;

async function stashBlob(blob, prefix) {
  const chunkKeys = [];
  for (let off = 0, i = 0; off < blob.size; off += STORAGE_CHUNK_BYTES, i++) {
    const dataUrl = await blobToDataUrl(blob.slice(off, off + STORAGE_CHUNK_BYTES));
    const key = `${prefix}-${i}`;
    await chrome.storage.local.set({ [key]: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    chunkKeys.push(key);
  }
  return { mime: blob.type || "video/mp4", size: blob.size, chunkKeys };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "startBlobCapture") return;
  // Answer right away: a full capture can take minutes, longer than the
  // background should sit on one pending message. The result comes back
  // as a separate "blobCaptureDone" message instead.
  sendResponse({ started: true });
  (async () => {
    try {
      const blobs = await captureBlobTracks(message.url);
      const tracks = [];
      for (const [i, blob] of blobs.entries()) tracks.push(await stashBlob(blob, `${message.jobId}-t${i}`));
      await chrome.runtime.sendMessage({ action: "blobCaptureDone", jobId: message.jobId, tracks });
    } catch (err) {
      chrome.runtime.sendMessage({ action: "blobCaptureDone", jobId: message.jobId, error: err.message }).catch(() => {});
    }
  })();
});
