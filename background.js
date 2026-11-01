// Universal Video Downloader — background service worker
// Tracks videos per tab (from network sniffing + DOM reports) and performs downloads.

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|flv)(\?|#|$)/i;
const HLS_EXT_RE = /\.m3u8(\?|#|$)/i;
const DASH_EXT_RE = /\.mpd(\?|#|$)/i;
const MAX_SEGMENT_CONCURRENCY = 6;

/** @type {Map<number, Map<string, object>>} tabId -> (url -> videoInfo) */
const tabVideos = new Map();
/** @type {Map<number, string>} tabId -> page title */
const tabTitles = new Map();
/** @type {Map<number, string>} tabId -> page URL (used to spoof Referer/Origin on CDN requests) */
const tabPageUrls = new Map();
/** @type {Set<string>} .m3u8 URLs already classified as master-or-not, so we don't re-fetch them */
const classifiedHlsUrls = new Set();
/** @type {Map<number, Map<string, string>>} tabId -> (lang -> WebVTT) captions captured from YouTube's own player */
const capturedCaptions = new Map();
/** @type {Map<string, {tabId: number, base: string}>} in-progress full-length blob captures */
const blobJobs = new Map();

function classifyUrl(url) {
  // Analytics/beacon calls on some sites (Skool/Mux playback pings, for
  // example) are sometimes served with a video-ish content-type even though
  // the body is JSON. Never treat those as a real video.
  if (/\.json(\?|#|$)/i.test(url)) return null;
  if (HLS_EXT_RE.test(url)) return "hls";
  if (DASH_EXT_RE.test(url)) return "dash";
  if (VIDEO_EXT_RE.test(url)) return "video";
  if (/\.(vtt|srt)(\?|#|$)/i.test(url)) return "subtitle";
  return null;
}

function getTabMap(tabId) {
  let map = tabVideos.get(tabId);
  if (!map) {
    map = new Map();
    tabVideos.set(tabId, map);
  }
  return map;
}

/** @type {Map<number, number>} tabId -> percent of the download running for that tab */
const activeProgress = new Map();

function updateBadge(tabId) {
  const count = tabVideos.get(tabId)?.size || 0;
  const pct = activeProgress.get(tabId);
  chrome.action.setBadgeText({ tabId, text: pct != null ? `${pct}%` : count ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d9534f" });
}

// One place every download kind reports through: icon badge + the open popup.
// percent null = finished/failed, back to the video count.
function setProgress(tabId, percent) {
  if (tabId == null) return;
  const next = percent == null ? null : Math.min(100, Math.round(percent));
  if ((activeProgress.get(tabId) ?? null) === next) return;
  if (next == null) activeProgress.delete(tabId);
  else activeProgress.set(tabId, next);
  updateBadge(tabId);
  chrome.runtime.sendMessage({ action: "downloadProgress", tabId, percent: next }).catch(() => {});
}

function upsertVideo(tabId, info) {
  if (tabId == null || tabId < 0) return;
  const map = getTabMap(tabId);
  const existing = map.get(info.url);
  map.set(info.url, { ...existing, ...info, detectedAt: existing?.detectedAt || Date.now() });
  updateBadge(tabId);
}

function clearTab(tabId) {
  tabVideos.delete(tabId);
  tabTitles.delete(tabId);
  tabPageUrls.delete(tabId);
  capturedCaptions.delete(tabId);
  rangedAudio.delete(tabId);
  for (const key of classifiedHlsUrls) if (key.startsWith(`${tabId}|`)) classifiedHlsUrls.delete(key);
  updateBadge(tabId);
}

// The live tab URL, not just our cached copy: the cache is in-memory, so
// it's empty after the service worker restarts (extension reload, or simply
// idling), and an F5 on the same page doesn't report the URL again — without
// it there's no Referer spoof, and Skool's CDN rejects the request.
async function getPageUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) return tab.url;
  } catch {
    /* tab may be gone */
  }
  return tabPageUrls.get(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

// Reset the list whenever the top frame navigates to a new document.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearTab(tabId);
    tabPageUrls.set(tabId, changeInfo.url);
  }
  if (changeInfo.title) {
    tabTitles.set(tabId, changeInfo.title);
  }
  if (changeInfo.url) {
    tabPageUrls.set(tabId, changeInfo.url);
  }
});

// --- Network sniffing -------------------------------------------------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId == null || details.tabId < 0) return;
    // Never a real video file — some sites (Skool/Mux playback pings, for
    // example) send analytics/tracking beacons to URLs like this.
    if (/\.json(\?|#|$)/i.test(details.url)) return;

    const headers = details.responseHeaders || [];
    const contentType = (headers.find((h) => h.name.toLowerCase() === "content-type")?.value || "").toLowerCase();
    if (contentType.includes("json")) return;
    const contentLength = headers.find((h) => h.name.toLowerCase() === "content-length")?.value;
    const size = contentLength ? parseInt(contentLength, 10) : null;

    if (handleRangedMp4(details)) return;

    let kind = classifyUrl(details.url);
    if (!kind && contentType.startsWith("video/")) {
      // Content-type claims video but the URL doesn't look like a media
      // file — only trust this for sizable responses; small bodies are
      // usually analytics beacons mislabeled as video, not real media.
      if (size == null || size > 20000) kind = "video";
    }

    if (!kind && contentType.startsWith("text/vtt")) kind = "subtitle";
    if (!kind) return;

    // A plain caption file loaded by the player (sites with direct MP4s). On
    // HLS sites captions already come from the playlist and these .vtt hits
    // are only its segments, so skip them there.
    if (kind === "subtitle") {
      const tabHasHls = Array.from(tabVideos.get(details.tabId)?.values() || []).some((v) => v.type === "hls");
      if (tabHasHls || /\/(chunk|segment|seg-|fragment)/i.test(details.url)) return;
      upsertVideo(details.tabId, {
        url: details.url,
        source: "network",
        type: "subtitle",
        mime: "text/vtt",
        size,
        frameId: details.frameId,
        label: decodeURIComponent(new URL(details.url).pathname.split("/").pop() || "Captions"),
      });
      return;
    }

    // Adaptive-bitrate players (HLS/DASH) fetch dozens of small segment
    // files per video — each one technically matches a video extension or
    // content-type, but downloading just one is useless. Only keep direct
    // "video" hits that look like a real, complete file; the HLS/DASH
    // playlist entries already cover downloading the full stream.
    if (kind === "video") {
      const looksLikeSegment = /\/(chunk|segment|seg-|fragment)/i.test(details.url);
      const tooSmall = size != null && size < 150000;
      if (looksLikeSegment || tooSmall) return;
    }

    if (kind === "hls") {
      // A master playlist (lists variants, handles audio+video muxing
      // automatically) is the only useful download target — its individual
      // video-only/audio-only renditions show up as separate .m3u8 network
      // hits too, and downloading one of those alone gives a soundless or
      // silent-video file. Classify before showing it.
      maybeAddHlsEntry(details.tabId, details.url, details.frameId, contentType, size);
      return;
    }

    upsertVideo(details.tabId, {
      url: details.url,
      source: "network",
      type: kind === "dash" ? "dash" : "video",
      mime: contentType || null,
      size,
      frameId: details.frameId,
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"]
);

function parseSubtitleTracks(text) {
  const tracks = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXT-X-MEDIA") && /TYPE=SUBTITLES/.test(line)) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (!uriMatch) continue;
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const langMatch = line.match(/LANGUAGE="([^"]+)"/);
      const isDefault = /DEFAULT=YES/.test(line);
      tracks.push({ uri: uriMatch[1], name: nameMatch?.[1] || null, lang: langMatch?.[1] || null, isDefault });
    }
  }
  return tracks;
}

// Fetches a small .m3u8 just far enough to tell a master playlist (what we
// want to show, broken out into one entry per quality) apart from one of its
// own video-only/audio-only renditions (same file extension, picked up by
// the same network sniffing, but useless as a standalone download).
async function maybeAddHlsEntry(tabId, url, frameId, mime, size) {
  const classifyKey = `${tabId}|${url}`;
  if (classifiedHlsUrls.has(classifyKey)) return;
  classifiedHlsUrls.add(classifyKey);

  let text;
  try {
    const pageUrl = await getPageUrl(tabId);
    text = await withRefererOverride(pageUrl, async (ensureRuleFor) => {
      const res = await fetchOrThrow(url, { ensureRuleFor });
      return res.text();
    });
  } catch (err) {
    // Couldn't classify (expired/blocked) — fail open and show it anyway so
    // the user still has an option, rather than silently hiding the video.
    console.warn("[UVD] could not classify HLS playlist, showing it anyway:", err.message);
    upsertVideo(tabId, { url, source: "network", type: "hls", mime, size, frameId });
    return;
  }

  if (!text.includes("#EXT-X-STREAM-INF")) return; // a bare rendition, not a master — hide it

  // Pick one subtitle track to auto-embed into every quality option below
  // (prefer whichever the playlist itself marks DEFAULT=YES), so a normal
  // "Download" already comes out with captions baked in — no separate file,
  // no manually loading a .vtt into a player afterwards.
  const subtitleTracks = parseSubtitleTracks(text);
  const defaultSubtitle = subtitleTracks.find((t) => t.isDefault) || subtitleTracks[0] || null;
  const defaultSubtitleUrl = defaultSubtitle ? new URL(defaultSubtitle.uri, url).href : null;

  const variants = parseMasterVariants(text);
  if (variants.length === 0) {
    upsertVideo(tabId, { url, source: "network", type: "hls", mime, size, frameId, subtitleUrl: defaultSubtitleUrl });
  } else {
    for (const variant of variants) {
      const videoUrl = new URL(variant.uri, url).href;
      upsertVideo(tabId, {
        url: videoUrl,
        source: "network",
        type: "hls",
        mime,
        size: null,
        frameId,
        label: variantLabel(variant) + (defaultSubtitleUrl ? " + CC" : ""),
        videoUrl,
        audioUrl: variant.audioUri ? new URL(variant.audioUri, url).href : null,
        subtitleUrl: defaultSubtitleUrl,
      });
    }
  }

  // Also list every subtitle track on its own, for a different language or
  // a standalone .vtt the user wants separately.
  for (const track of subtitleTracks) {
    upsertVideo(tabId, {
      url: new URL(track.uri, url).href,
      source: "network",
      type: "subtitle",
      mime: "text/vtt",
      size: null,
      frameId,
      label: track.lang || track.name || "Subtitles",
    });
  }
}

// --- Instagram/Facebook byte-range DASH ---------------------------------
// Their player fetches each representation in pieces as
// file.mp4?...&bytestart=X&byteend=Y, video and audio as separate files.
// Dropping those two params gives the whole file; the base64 JSON "efg"
// param says whether it's audio and which asset it belongs to, so the audio
// can be paired with its video and muxed at download time.

/** @type {Map<number, Map<string, string>>} tabId -> (assetId -> full audio URL) */
const rangedAudio = new Map();

function parseRangedMp4(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.searchParams.has("bytestart") || !/\.mp4$/i.test(u.pathname)) return null;
  u.searchParams.delete("bytestart");
  u.searchParams.delete("byteend");
  let efg = {};
  try {
    const b64 = u.searchParams.get("efg").replace(/-/g, "+").replace(/_/g, "/");
    efg = JSON.parse(atob(b64));
  } catch {
    /* no/unknown efg — still usable, just can't be paired with its audio */
  }
  const tag = String(efg.vencode_tag || "");
  return {
    fullUrl: u.href,
    isAudio: /audio/i.test(tag),
    assetId: efg.xpv_asset_id != null ? String(efg.xpv_asset_id) : efg.video_id != null ? String(efg.video_id) : null,
    bitrate: Number(efg.bitrate) || null,
  };
}

function handleRangedMp4(details) {
  const r = parseRangedMp4(details.url);
  if (!r) return false;
  const tabId = details.tabId;
  if (r.isAudio) {
    if (!r.assetId) return true;
    let byAsset = rangedAudio.get(tabId);
    if (!byAsset) rangedAudio.set(tabId, (byAsset = new Map()));
    byAsset.set(r.assetId, r.fullUrl);
    // Video seen first: attach the audio to it now.
    for (const v of tabVideos.get(tabId)?.values() || []) {
      if (v.assetId === r.assetId && !v.audioUrl) upsertVideo(tabId, { ...v, audioUrl: r.fullUrl, label: v.label + " + audio" });
    }
    return true;
  }
  const audioUrl = (r.assetId && rangedAudio.get(tabId)?.get(r.assetId)) || null;
  const label = (r.bitrate ? `${Math.round(r.bitrate / 1000)} kbps` : "Video") + (audioUrl ? " + audio" : "");
  const existing = tabVideos.get(tabId)?.get(r.fullUrl);
  if (existing?.audioUrl) return true; // already complete
  upsertVideo(tabId, {
    url: r.fullUrl,
    source: "network",
    type: "video",
    mime: "video/mp4",
    size: null, // the response is one piece, not the whole file
    frameId: details.frameId,
    assetId: r.assetId,
    audioUrl,
    label,
  });
  return true;
}

// --- Messages from content scripts / popup -----------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "domVideoFound") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    if (message.pageTitle) tabTitles.set(tabId, message.pageTitle);
    if (message.pageUrl) tabPageUrls.set(tabId, message.pageUrl);
    for (const v of message.videos || []) {
      const type = v.isBlob ? "blob" : classifyUrl(v.url) || "video";
      if (type === "hls") {
        maybeAddHlsEntry(tabId, v.url, sender.frameId, v.mime || null, null);
        continue;
      }
      upsertVideo(tabId, {
        url: v.url,
        source: "dom",
        type,
        mime: v.mime || null,
        size: null,
        duration: v.duration || null,
        poster: v.poster || null,
        frameId: sender.frameId,
      });
    }
    return;
  }

  if (message.action === "captionsFound") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    if (message.pageTitle) tabTitles.set(tabId, message.pageTitle);
    for (const track of message.tracks || []) {
      upsertVideo(tabId, {
        url: track.url,
        source: "dom",
        type: "subtitle",
        mime: "text/vtt",
        size: null,
        frameId: sender.frameId,
        lang: track.lang,
        label: track.name || track.lang || "Subtitles",
      });
    }
    return;
  }

  if (message.action === "captionCaptured") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const vtt = captionTextToVtt(message.text);
    if (!vtt) {
      console.warn("[UVD] captured caption in an unrecognized format:", message.fmt, message.text.slice(0, 200));
      return;
    }
    let byLang = capturedCaptions.get(tabId);
    if (!byLang) capturedCaptions.set(tabId, (byLang = new Map()));
    byLang.set(message.lang, vtt);
    console.log("[UVD] captured captions for", message.lang);

    // Usually the listed track for this language already exists and will pick
    // the captured text up at download time; only add an entry if it doesn't.
    const listed = Array.from(tabVideos.get(tabId)?.values() || []).some(
      (v) => v.type === "subtitle" && v.lang === message.lang
    );
    if (!listed) {
      upsertVideo(tabId, {
        url: `yt-caption:${message.lang}`,
        source: "dom",
        type: "subtitle",
        mime: "text/vtt",
        size: null,
        frameId: sender.frameId,
        lang: message.lang,
        label: `${message.lang} (captured)`,
      });
    }
    return;
  }

  if (message.action === "getFfmpegCommand") {
    getPageUrl(message.tabId).then((pageUrl) => {
      const v = message.video;
      const quality = (v.label || "").split(" ")[0];
      sendResponse({
        command: buildFfmpegCommand({
          pageUrl,
          videoUrl: v.videoUrl || v.url,
          audioUrl: v.audioUrl || null,
          filename: `${sanitizeFilename(tabTitles.get(message.tabId) || "video")}${quality ? "_" + quality : ""}.mp4`,
        }),
      });
    });
    return true; // async
  }

  if (message.action === "getVideos") {
    const tabId = message.tabId;
    let list = Array.from(tabVideos.get(tabId)?.values() || []).sort(
      (a, b) => (a.detectedAt || 0) - (b.detectedAt || 0)
    );
    // Blob capture plays the video at 8x, so Instagram's player drops to its
    // lowest quality; the full-file entries are always better there.
    if (list.some((v) => v.assetId)) list = list.filter((v) => v.type !== "blob");
    sendResponse({ videos: list, pageTitle: tabTitles.get(tabId) || "" });
    return;
  }

  if (message.action === "captureProgress") {
    const tabId = sender.tab?.id;
    setProgress(tabId, message.percent);
    return;
  }

  if (message.action === "blobCaptureDone") {
    const tabId = sender.tab?.id;
    const job = blobJobs.get(message.jobId) || {
      tabId,
      base: sanitizeFilename(tabTitles.get(tabId) || "video") + "_" + Date.now(),
    };
    blobJobs.delete(message.jobId);
    finishBlobJob(job, message)
      .then(() => notify("Download complete", "The video was saved to your Downloads folder."))
      .catch((err) => {
        console.error("[UVD] download failed:", err);
        notify("Download failed", err.message);
      })
      .finally(() => setProgress(job.tabId, null));
    return;
  }

  if (message.action === "downloadVideo") {
    console.log("[UVD] download requested:", message.video.type, message.video.url);
    handleDownload(message.tabId, message.video)
      .finally(() => setProgress(message.tabId, null))
      .then((result) => {
        if (result?.pending) {
          notify(
            "Recording video",
            "Playing it through from the start at high speed (muted) to capture the whole video. Keep the tab open — it downloads automatically when done."
          );
          try {
            sendResponse(result);
          } catch {
            /* popup already closed */
          }
          return;
        }
        console.log("[UVD] download succeeded:", result);
        notify("Download complete", "The video was saved to your Downloads folder.");
        try {
          sendResponse(result);
        } catch {
          /* popup already closed — the notification above is the real feedback */
        }
      })
      .catch((err) => {
        console.error("[UVD] download failed:", err);
        notify("Download failed", err.message);
        try {
          sendResponse({ success: false, error: err.message });
        } catch {
          /* popup already closed */
        }
      });
    return true; // async
  }
});

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
  });
}

// --- Download handling --------------------------------------------------

function guessExtension(video) {
  if (video.type === "hls") return video._fmp4 ? "mp4" : "ts";
  const match = video.url.match(VIDEO_EXT_RE);
  if (match) return match[1].toLowerCase();
  if (video.mime?.includes("webm")) return "webm";
  return "mp4";
}

// PowerShell single quotes: nothing inside expands; a ' is written as ''.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// For videos too long to assemble in the browser (~1 h): real ffmpeg on the
// user's PC streams to disk. -referer/-headers are forwarded by ffmpeg's HLS
// demuxer to every segment request — the same check the extension satisfies
// with its Referer rewrite.
function buildFfmpegCommand({ pageUrl, videoUrl, audioUrl, filename }) {
  const headerArgs = pageUrl ? `-referer ${psQuote(pageUrl)} -headers ${psQuote(`Origin: ${new URL(pageUrl).origin}`)} ` : "";
  const parts = ["ffmpeg", `${headerArgs}-i ${psQuote(videoUrl)}`];
  if (audioUrl) parts.push(`${headerArgs}-i ${psQuote(audioUrl)}`, "-map 0:v:0 -map 1:a:0");
  parts.push("-c copy", psQuote(filename));
  return parts.join(" ");
}

function sanitizeFilename(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

async function handleDownload(tabId, video) {
  const base = sanitizeFilename(tabTitles.get(tabId) || "video") + "_" + Date.now();
  const onProgress = (percent) => setProgress(tabId, percent);
  const pageUrl = await getPageUrl(tabId);
  console.log("[UVD] using page URL for Referer spoof:", pageUrl);

  if (video.type === "blob") {
    // blob: URLs only resolve inside their own page, so the content script
    // does the capturing. A full-length capture can take minutes, so this
    // only starts it; "blobCaptureDone" finishes the job later.
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    blobJobs.set(jobId, { tabId, base });
    await new Promise((resolve, reject) => {
      const options = video.frameId != null ? { frameId: video.frameId } : {};
      chrome.tabs.sendMessage(tabId, { action: "startBlobCapture", url: video.url, jobId }, options, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
    return { success: true, pending: true };
  }

  if (video.type === "dash") {
    throw new Error("DASH (.mpd) streams are not supported yet — try the HLS/direct file link if the site offers one.");
  }

  // Many CDNs (Skool/Bunny/Fastly included) reject requests whose
  // Referer/Origin doesn't match the page that's supposed to be playing the
  // video. A request we fire from the service worker has no such header by
  // default, so we temporarily rewrite it to look like it came from the
  // lesson page itself, for just the hostnames this download touches.
  return withRefererOverride(pageUrl, async (ensureRuleFor) => {
    if (video.type === "subtitle") {
      let vttText = video.lang ? capturedCaptions.get(tabId)?.get(video.lang) : null;
      if (!vttText && /youtube\.com\/api\/timedtext|^yt-caption:/.test(video.url)) {
        throw new Error(
          "YouTube only gives caption text to its own player. Turn on CC in the video player " +
            "(choose this language), let it play a few seconds, then click Download again."
        );
      }
      if (!vttText) vttText = await downloadSubtitleTrack(video.url, ensureRuleFor);
      return downloadBlob(new Blob([vttText], { type: "text/vtt" }), `${base}.vtt`);
    }

    if (video.type === "hls") {
      // A quality the popup listed has its video (and, if split, audio and
      // subtitle) rendition URLs already resolved — go straight there
      // instead of re-fetching and re-picking from the master playlist.
      const { blob, ext } = video.videoUrl
        ? await downloadHlsVariant(video.videoUrl, video.audioUrl || null, video.subtitleUrl || null, ensureRuleFor, onProgress)
        : await downloadHls(video.url, ensureRuleFor, onProgress);
      return downloadBlob(blob, `${base}.${ext}`);
    }

    // Separate video + audio files (Instagram/Facebook DASH) -> one MP4.
    if (video.audioUrl) {
      const fractions = [0, 0];
      const part = (i) => (f) => {
        fractions[i] = f;
        onProgress((fractions[0] + fractions[1]) * 45);
      };
      const [videoBytes, audioBytes] = await Promise.all([
        fetchBlobWithProgress(video.url, ensureRuleFor, part(0)),
        fetchBlobWithProgress(video.audioUrl, ensureRuleFor, part(1)),
      ]);
      onProgress(95);
      return downloadBlob(await muxTracks({ videoBytes, audioBytes }), `${base}.mp4`);
    }

    // Plain http(s) video file.
    await ensureRuleFor(video.url);
    const filename = `${base}.${guessExtension(video)}`;
    let chromeId;
    try {
      chromeId = await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: video.url, filename, saveAs: true }, (id) => {
          if (chrome.runtime.lastError || !id) reject(new Error(chrome.runtime.lastError?.message || "download failed"));
          else resolve(id);
        });
      });
    } catch (directErr) {
      // Fallback: fetch it ourselves (with cookies, since the service worker
      // doesn't send them cross-origin by default) and save the result.
      return downloadBlob(await fetchBlobWithProgress(video.url, ensureRuleFor, (f) => onProgress(f * 95)), filename);
    }
    await waitForChromeDownload(chromeId, onProgress);
    return { success: true, chromeDownloadId: chromeId };
  });
}

// Reads a response body chunk by chunk so progress can be reported; falls
// back to no progress when the server doesn't send Content-Length.
async function fetchBlobWithProgress(url, ensureRuleFor, onFraction) {
  const res = await fetchOrThrow(url, { ensureRuleFor });
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onFraction(Math.min(1, got / total));
  }
  return new Blob(chunks);
}

// chrome.downloads has no progress event, so poll until it settles.
function waitForChromeDownload(id, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      const [d] = await chrome.downloads.search({ id });
      if (d?.state === "in_progress") {
        if (d.totalBytes > 0) onProgress((d.bytesReceived / d.totalBytes) * 100);
        return;
      }
      clearInterval(timer);
      if (d?.state === "complete") resolve();
      else reject(new Error(d?.error || "The download did not complete."));
    }, 500);
  });
}

// --- Referer/Origin spoofing via declarativeNetRequest -------------------
// (Needed because fetch()/chrome.downloads can't set these headers directly
// — they're "forbidden" headers the browser manages itself.)

let nextDnrRuleId = (Date.now() % 1000000) + 1;

async function withRefererOverride(refererUrl, fn) {
  const addedRuleIds = [];
  const seenHosts = new Set();

  async function ensureRuleFor(url) {
    if (!refererUrl) return;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (seenHosts.has(host)) return;
    seenHosts.add(host);
    const id = nextDnrRuleId++;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id,
            priority: 1,
            condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest", "other", "media"] },
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "Referer", operation: "set", value: refererUrl },
                { header: "Origin", operation: "set", value: new URL(refererUrl).origin },
              ],
            },
          },
        ],
      });
      addedRuleIds.push(id);
      console.log(`[UVD] spoofing Referer for ${host} -> ${refererUrl}`);
    } catch (err) {
      console.warn(`[UVD] could not add header-override rule for ${host}:`, err.message);
    }
  }

  try {
    return await fn(ensureRuleFor);
  } finally {
    if (addedRuleIds.length) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addedRuleIds }).catch(() => {});
    }
  }
}

// The service worker can't make a blob: URL itself, and a data: URL (the
// old way) is a base64 copy that breaks past ~0.5 GB — an hour-long lesson.
// The offscreen page can make a real blob: URL, which Chrome reads directly.
const blobUrlByDownloadId = new Map();

async function downloadBlob(blob, filename) {
  await ensureOffscreenDocument();
  const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await putBlob(id, blob);
  const res = await chrome.runtime.sendMessage({ action: "makeObjectUrl", id });
  if (!res?.url) {
    deleteBlob(id).catch(() => {});
    throw new Error(res?.error || "Could not prepare the file for saving.");
  }
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: res.url, filename, saveAs: true }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        chrome.runtime.sendMessage({ action: "revokeObjectUrl", url: res.url }).catch(() => {});
        reject(new Error(chrome.runtime.lastError?.message || "download failed"));
      } else {
        blobUrlByDownloadId.set(downloadId, res.url);
        resolve({ success: true, chromeDownloadId: downloadId });
      }
    });
  });
}

// Free the file's memory once Chrome has finished reading it.
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const url = blobUrlByDownloadId.get(delta.id);
  if (!url) return;
  blobUrlByDownloadId.delete(delta.id);
  chrome.runtime.sendMessage({ action: "revokeObjectUrl", url }).catch(() => {});
});

// Reassembles one captured track the content script stashed in extension
// storage as 8MB base64 pieces (see stashBlob in content.js).
async function readStashedBytes({ size, chunkKeys }) {
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const key of chunkKeys) {
    const b64 = (await chrome.storage.local.get(key))[key];
    chrome.storage.local.remove(key).catch(() => {});
    if (!b64) throw new Error("Captured video data was not found.");
    const bin = atob(b64);
    for (let i = 0; i < bin.length; i++) bytes[off + i] = bin.charCodeAt(i);
    off += bin.length;
  }
  return bytes;
}

function extForMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("matroska")) return "mkv";
  return "mp4";
}

// More than one track means the page streamed video and audio separately
// (common — YouTube included), which need muxing into one file.
async function assembleTracks(tracks) {
  const video = tracks.find((t) => t.mime?.startsWith("video/")) || tracks[0];
  const audio = tracks.find((t) => t !== video && t.mime?.startsWith("audio/"));
  const videoExt = extForMime(video.mime);
  if (!audio) {
    return { blob: new Blob([video.bytes], { type: (video.mime || "video/mp4").split(";")[0] }), ext: videoExt };
  }
  const audioExt = extForMime(audio.mime);
  // WebM (VP9/Opus) and MP4 (H.264/AAC) can't always share a container —
  // fall back to MKV, which holds any mix.
  const outputExt = videoExt === audioExt ? videoExt : "mkv";
  console.log(`[UVD] muxing captured ${videoExt} video + ${audioExt} audio -> .${outputExt}`);
  const blob = await muxTracks({ videoBytes: video.bytes, audioBytes: audio.bytes, videoExt, audioExt, outputExt });
  return { blob, ext: outputExt };
}

async function finishBlobJob(job, message) {
  if (message.error) throw new Error(message.error);
  const tracks = [];
  for (const t of message.tracks || []) tracks.push({ mime: t.mime, bytes: await readStashedBytes(t) });
  if (tracks.length === 0) throw new Error("Captured video data was not found.");
  const { blob, ext } = await assembleTracks(tracks);
  return downloadBlob(blob, `${job.base}.${ext}`);
}

// --- Basic HLS downloader (progressive MPEG-TS or fMP4 segment concat) --

// Service worker fetch() defaults to NOT sending cookies cross-origin.
// Many video CDNs (Skool/Mux included) gate access behind the viewer's
// session cookie even when the URL itself looks "signed", so every request
// here explicitly includes credentials and surfaces the real HTTP status
// instead of silently swallowing a 401/403 as garbage playlist text.
async function fetchOrThrow(url, { ensureRuleFor, extra = {} } = {}) {
  console.log("[UVD] fetching:", url);
  if (ensureRuleFor) await ensureRuleFor(url);
  let response;
  try {
    response = await fetch(url, { credentials: "include", ...extra });
  } catch (err) {
    throw new Error(`Network request to ${new URL(url).hostname} failed (${err.message}). This can happen if the link expired or the site blocks direct fetches.`);
  }
  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = (await response.clone().text()).slice(0, 300);
    } catch {
      /* body not readable, ignore */
    }
    console.error(`[UVD] HTTP ${response.status} for ${url}${bodyText ? " — body: " + bodyText : ""}`);
    throw new Error(
      `${new URL(url).hostname} returned HTTP ${response.status} ${response.statusText}` +
        (bodyText ? ` — body: ${bodyText}` : "") +
        ` — the link may have expired; try reopening the lesson and re-detecting.`
    );
  }
  return response;
}

// A master playlist lists one or more video variants (#EXT-X-STREAM-INF,
// one per quality) and, when audio is streamed separately for adaptive
// bitrate, one or more #EXT-X-MEDIA:TYPE=AUDIO entries grouped by GROUP-ID.
// A variant that wants one of those groups names it via AUDIO="<group-id>".
function parseMasterVariants(text) {
  const lines = text.split("\n");
  const audioByGroup = {};
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(line)) {
      const groupMatch = line.match(/GROUP-ID="([^"]+)"/);
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (groupMatch && uriMatch) audioByGroup[groupMatch[1]] = uriMatch[1];
    }
  }

  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
      const audioGroupMatch = lines[i].match(/AUDIO="([^"]+)"/);
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith("#")) {
        variants.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
          resolution: resMatch ? resMatch[1] : null,
          uri,
          audioUri: audioGroupMatch ? audioByGroup[audioGroupMatch[1]] || null : null,
        });
      }
    }
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

function variantLabel(variant) {
  if (variant.resolution) return `${variant.resolution.split("x")[1]}p`;
  return variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : "quality unknown";
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function formatVttTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = (totalSeconds % 60).toFixed(3);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.padStart(6, "0")}`;
}

// YouTube's timedtext endpoint (fmt=srv1) returns plain
// <text start="1.2" dur="3.4">caption</text> XML — convert it to WebVTT.
function srv1XmlToVtt(xml) {
  let vtt = "WEBVTT\n\n";
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  let count = 0;
  while ((match = re.exec(xml))) {
    const start = parseFloat(match[1]);
    const end = start + parseFloat(match[2]);
    const text = decodeXmlEntities(match[3]).replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;
    vtt += `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n${text}\n\n`;
    count++;
  }
  return count > 0 ? vtt : null;
}

function cuesToVtt(cues) {
  if (cues.length === 0) return null;
  // Auto-generated tracks overlap each cue with the next — clip them so
  // players don't stack two lines on screen at once.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  let vtt = "WEBVTT\n\n";
  for (const c of cues) vtt += `${formatVttTimestamp(c.start)} --> ${formatVttTimestamp(c.end)}\n${c.text}\n\n`;
  return vtt;
}

// YouTube's own player usually asks for fmt=json3:
// {events: [{tStartMs, dDurationMs, segs: [{utf8}]}]}
function json3ToVtt(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const cues = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (ev.dDurationMs || 0) / 1000, text });
  }
  return cuesToVtt(cues);
}

// fmt=srv3: <p t="1200" d="3400">text, possibly with <s> word spans</p>
function srv3XmlToVtt(xml) {
  const cues = [];
  const re = /<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = re.exec(xml))) {
    const text = decodeXmlEntities(match[3].replace(/<[^>]+>/g, "")).replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;
    const start = parseInt(match[1], 10) / 1000;
    cues.push({ start, end: start + parseInt(match[2] || "0", 10) / 1000, text });
  }
  return cuesToVtt(cues);
}

function captionTextToVtt(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("WEBVTT")) return trimmed;
  if (trimmed.startsWith("{")) return json3ToVtt(trimmed);
  if (trimmed.includes("<text start=")) return srv1XmlToVtt(trimmed);
  if (trimmed.includes("<p t=")) return srv3XmlToVtt(trimmed);
  // SRT: same cues as VTT, but "," before the milliseconds and no header.
  if (/^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(trimmed.replace(/\r/g, ""))) {
    return "WEBVTT\n\n" + trimmed.replace(/\r/g, "").replace(/(\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  }
  return null;
}

// A subtitle "playlist" is a single WebVTT file directly, YouTube's XML
// transcript format, or (on HLS sites) its own small media playlist listing
// WebVTT segment files — same shape as a video/audio media playlist, but
// text instead of bytes.
async function downloadSubtitleTrack(subtitlePlaylistUrl, ensureRuleFor) {
  const text = await (await fetchOrThrow(subtitlePlaylistUrl, { ensureRuleFor })).text();
  const direct = captionTextToVtt(text); // a whole caption file (VTT, SRT, YouTube XML/JSON)
  if (direct) return direct;

  const lines = text.split("\n").map((l) => l.trim());
  const segmentUrls = lines.filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, subtitlePlaylistUrl).href);
  if (segmentUrls.length === 0) {
    console.error("[UVD] subtitle fetch returned unexpected content:", text.slice(0, 300));
    throw new Error(
      text.trim()
        ? "Captions came back in an unexpected format (not WebVTT) — the site may not support this."
        : "Captions response was empty — this track may not actually be available."
    );
  }

  const parts = new Array(segmentUrls.length);
  let next = 0;
  async function worker() {
    while (next < segmentUrls.length) {
      const i = next++;
      parts[i] = await (await fetchOrThrow(segmentUrls[i], { ensureRuleFor })).text();
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_SEGMENT_CONCURRENCY, segmentUrls.length) }, worker));

  // Every segment repeats its own "WEBVTT" header, which is only valid once
  // per file — keep the first segment as-is and strip the header from the rest.
  return parts
    .map((t, i) => (i === 0 ? t : t.replace(/^WEBVTT[^\n]*\n+/, "")))
    .join("\n");
}

// Downloads every segment (plus init segment, if any) of ONE media playlist
// (not a master) and returns it as a single concatenated byte array — a
// valid standalone file if the playlist is self-contained, or one half of
// an audio+video pair that still needs muxing.
async function downloadMediaPlaylistTrack(mediaPlaylistUrl, ensureRuleFor, label, onFraction) {
  console.log(`[UVD] fetching ${label} playlist:`, mediaPlaylistUrl);
  const text = await (await fetchOrThrow(mediaPlaylistUrl, { ensureRuleFor })).text();

  if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(text)) {
    throw new Error("This stream is encrypted (DRM-protected) and cannot be downloaded.");
  }

  const lines = text.split("\n").map((l) => l.trim());
  let initSegmentUrl = null;
  const mapLine = lines.find((l) => l.startsWith("#EXT-X-MAP"));
  if (mapLine) {
    const uriMatch = mapLine.match(/URI="([^"]+)"/);
    if (uriMatch) initSegmentUrl = new URL(uriMatch[1], mediaPlaylistUrl).href;
  }

  const segmentUrls = lines.filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, mediaPlaylistUrl).href);
  if (segmentUrls.length === 0) throw new Error(`No segments found in ${label} playlist.`);
  console.log(`[UVD] downloading ${segmentUrls.length} ${label} segments...`);

  const parts = new Array(segmentUrls.length);
  if (initSegmentUrl) {
    parts.unshift(await (await fetchOrThrow(initSegmentUrl, { ensureRuleFor })).arrayBuffer());
  }

  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < segmentUrls.length) {
      const i = next++;
      const res = await fetchOrThrow(segmentUrls[i], { ensureRuleFor });
      parts[initSegmentUrl ? i + 1 : i] = await res.arrayBuffer();
      completed++;
      onFraction?.(completed / segmentUrls.length);
      if (completed % 10 === 0 || completed === segmentUrls.length) {
        console.log(`[UVD] ${label} progress: ${completed}/${segmentUrls.length}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(MAX_SEGMENT_CONCURRENCY, segmentUrls.length) }, worker);
  await Promise.all(workers);

  const totalBytes = parts.reduce((n, p) => n + p.byteLength, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p of parts) {
    bytes.set(new Uint8Array(p), offset);
    offset += p.byteLength;
  }
  return { bytes, hasInitSegment: !!initSegmentUrl };
}

// Downloads one specific video rendition (optionally paired with a separate
// audio rendition, muxed together with ffmpeg.wasm) and returns a playable
// file. Used both when the user picked an exact quality from the popup list
// and as the "just get me something" fallback for a bare HLS URL.
async function downloadHlsVariant(videoPlaylistUrl, audioPlaylistUrl, subtitleUrl, ensureRuleFor, onProgress) {
  // Tracks fill 0-90%; the rest is muxing and saving.
  const span = audioPlaylistUrl ? 45 : 90;
  const { bytes: videoBytes, hasInitSegment } = await downloadMediaPlaylistTrack(
    videoPlaylistUrl,
    ensureRuleFor,
    "video",
    (f) => onProgress?.(f * span)
  );

  let audioBytes = null;
  if (audioPlaylistUrl) {
    console.log("[UVD] separate audio + video renditions detected, downloading both...");
    audioBytes = (
      await downloadMediaPlaylistTrack(audioPlaylistUrl, ensureRuleFor, "audio", (f) => onProgress?.(span + f * span))
    ).bytes;
  }

  let subtitleText = null;
  if (subtitleUrl) {
    console.log("[UVD] fetching subtitles to embed...");
    try {
      subtitleText = await downloadSubtitleTrack(subtitleUrl, ensureRuleFor);
    } catch (err) {
      console.warn("[UVD] could not fetch subtitles, continuing without them:", err.message);
    }
  }

  if (!audioBytes && !subtitleText) {
    // Nothing to combine — the original single-track file is already final.
    return { blob: new Blob([videoBytes], { type: hasInitSegment ? "video/mp4" : "video/mp2t" }), ext: hasInitSegment ? "mp4" : "ts" };
  }

  console.log("[UVD] muxing with ffmpeg.wasm...");
  onProgress?.(95);
  return { blob: await muxTracks({ videoBytes, audioBytes, subtitleText }), ext: "mp4" };
}

// Fallback for an HLS entry with no pre-resolved quality info (e.g. the
// popup classifier couldn't reach it) — fetch it fresh and auto-pick the
// highest-bandwidth variant, same as before quality selection existed.
async function downloadHls(playlistUrl, ensureRuleFor, onProgress) {
  console.log("[UVD] fetching HLS playlist:", playlistUrl);
  const text = await (await fetchOrThrow(playlistUrl, { ensureRuleFor })).text();

  if (!text.includes("#EXT-X-STREAM-INF")) {
    return downloadHlsVariant(playlistUrl, null, null, ensureRuleFor, onProgress);
  }

  const [best] = parseMasterVariants(text);
  if (!best) throw new Error("Could not find a playable variant in the HLS master playlist.");
  const videoPlaylistUrl = new URL(best.uri, playlistUrl).href;
  const audioPlaylistUrl = best.audioUri ? new URL(best.audioUri, playlistUrl).href : null;
  const [defaultSub] = parseSubtitleTracks(text);
  const subtitleUrl = defaultSub ? new URL(defaultSub.uri, playlistUrl).href : null;
  console.log("[UVD] master playlist -> best variant:", videoPlaylistUrl);
  return downloadHlsVariant(videoPlaylistUrl, audioPlaylistUrl, subtitleUrl, ensureRuleFor, onProgress);
}

// --- Audio/video/subtitle muxing via an offscreen document (ffmpeg.wasm) -
// The service worker has no Worker/DOM access, which ffmpeg.wasm needs, so
// the actual muxing happens in offscreen.html/offscreen.js instead.

async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS", "BLOBS"],
      justification: "Mux separately-streamed audio/video/subtitle HLS renditions into one playable MP4 with ffmpeg.wasm",
    });
  } catch (err) {
    if (!String(err.message).includes("single offscreen")) throw err;
  }
}

// chrome.runtime.sendMessage caps a message at 64MiB, which an ordinary
// lecture video blows past easily — so the actual video/audio bytes travel
// through IndexedDB (shared by this service worker and the offscreen
// document, no size limit) and only a small reference id goes through the
// message itself.
function openTransferDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("uvd-transfer", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("blobs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBlob(id, blob) {
  const db = await openTransferDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getBlob(id) {
  const db = await openTransferDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readonly");
    const req = tx.objectStore("blobs").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteBlob(id) {
  const db = await openTransferDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function muxTracks({
  videoBytes,
  audioBytes = null,
  subtitleText = null,
  videoExt = "mp4",
  audioExt = "mp4",
  outputExt = "mp4",
}) {
  await ensureOffscreenDocument();
  const transferId = `mux-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const hasAudio = !!audioBytes;
  const hasSubtitle = subtitleText != null;

  await putBlob(`${transferId}-video`, new Blob([videoBytes]));
  if (hasAudio) await putBlob(`${transferId}-audio`, new Blob([audioBytes]));
  if (hasSubtitle) await putBlob(`${transferId}-subtitle`, new Blob([subtitleText], { type: "text/vtt" }));

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      action: "muxTracks",
      transferId,
      hasAudio,
      hasSubtitle,
      videoExt,
      audioExt,
      outputExt,
    });
  } finally {
    deleteBlob(`${transferId}-video`).catch(() => {});
    if (hasAudio) deleteBlob(`${transferId}-audio`).catch(() => {});
    if (hasSubtitle) deleteBlob(`${transferId}-subtitle`).catch(() => {});
  }

  if (!response?.success) throw new Error(response?.error || "Muxing failed.");

  const outputBlob = await getBlob(`${transferId}-output`);
  deleteBlob(`${transferId}-output`).catch(() => {});
  if (!outputBlob) throw new Error("Muxed output was not found.");
  return outputBlob;
}
