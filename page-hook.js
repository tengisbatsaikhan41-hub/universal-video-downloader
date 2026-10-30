// Runs in the page's own MAIN world (not the content script's isolated
// world) so it can see and patch the page's real MediaSource/SourceBuffer —
// needed because a blob: URL backed by a MediaSource (used by most modern
// streaming players, YouTube included) cannot be fetch()'d for its bytes;
// there is no fixed file behind it, just a live, append-fed buffer. This
// records the same bytes the browser already legitimately received and
// played, the same way a screen/audio recorder would, rather than re-asking
// a server for anything.
(function () {
  if (window.__uvdHooked) return;
  window.__uvdHooked = true;

  // Most MSE players (YouTube included) use a SEPARATE SourceBuffer for
  // video and for audio on the same MediaSource, and append media in pieces
  // that can repeat or arrive out of order (seeks, re-buffering, quality
  // switches). So rather than keeping raw append order, each track's byte
  // stream is parsed into its init segment plus media fragments keyed by
  // their own timestamp (fMP4 tfdt / WebM cluster timecode). Exporting then
  // means: init + fragments sorted by time, duplicates collapsed.
  const tracksByUrl = new Map(); // blob: url -> [track]
  const urlByMediaSource = new WeakMap();
  const trackBySourceBuffer = new WeakMap();

  function concatBytes(a, b) {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function joinBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ":" + bytes.length;
  }

  function u32(b, o) {
    return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  }

  function formatOf(mime) {
    const m = (mime || "").toLowerCase();
    return m.includes("webm") ? "webm" : m.includes("mp4") ? "mp4" : "raw";
  }

  function newTrack(mime) {
    return { mime, format: formatOf(mime), pending: new Uint8Array(0), reps: new Map(), current: null, initParts: [], frag: null, raw: [] };
  }

  // One "representation" per distinct init segment (a quality switch brings
  // a new one); exporting picks whichever collected the most data.
  function setInit(track, initBytes) {
    const sig = fnv1a(initBytes);
    let rep = track.reps.get(sig);
    if (!rep) {
      rep = { init: initBytes, mime: track.mime, frags: new Map(), unkeyed: [], bytes: 0 };
      track.reps.set(sig, rep);
    }
    track.current = rep;
  }

  function addFrag(track, key, bytes) {
    const rep = track.current;
    if (!rep) return;
    if (key == null) {
      rep.unkeyed.push(bytes);
    } else {
      const prev = rep.frags.get(key);
      if (prev) rep.bytes -= prev.length;
      rep.frags.set(key, bytes);
    }
    rep.bytes += bytes.length;
  }

  // ---- fragmented MP4 ----
  const MP4_DROP = new Set(["styp", "sidx", "emsg", "prft", "free", "skip"]);

  function mp4ChildBox(b, start, end, type) {
    let off = start;
    while (off + 8 <= end) {
      const size = u32(b, off);
      if (size < 8 || off + size > end) return null;
      if (String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]) === type) return { start: off, end: off + size };
      off += size;
    }
    return null;
  }

  function mp4FragmentTime(moof) {
    const traf = mp4ChildBox(moof, 8, moof.length, "traf");
    const tfdt = traf && mp4ChildBox(moof, traf.start + 8, traf.end, "tfdt");
    if (!tfdt) return null;
    const o = tfdt.start + 12;
    return moof[tfdt.start + 8] === 1 ? u32(moof, o) * 4294967296 + u32(moof, o + 4) : u32(moof, o);
  }

  function feedMp4(track) {
    const b = track.pending;
    let off = 0;
    while (off + 8 <= b.length) {
      let size = u32(b, off);
      let header = 8;
      const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      if (size === 1) {
        if (off + 16 > b.length) break;
        size = u32(b, off + 8) * 4294967296 + u32(b, off + 12);
        header = 16;
      }
      if (size < header) {
        track.pending = new Uint8Array(0);
        track.frag = null;
        return;
      }
      if (off + size > b.length) break;
      const box = b.slice(off, off + size);
      off += size;
      if (type === "ftyp") {
        track.initParts = [box];
      } else if (type === "moov") {
        track.initParts.push(box);
        setInit(track, joinBytes(track.initParts));
        track.initParts = [];
      } else if (type === "moof") {
        track.frag = { key: mp4FragmentTime(box), parts: [box] };
      } else if (type === "mdat") {
        if (track.frag) {
          track.frag.parts.push(box);
          addFrag(track, track.frag.key, joinBytes(track.frag.parts));
          track.frag = null;
        }
      } else if (!MP4_DROP.has(type) && track.frag) {
        track.frag.parts.push(box);
      }
    }
    track.pending = b.slice(off);
  }

  // ---- WebM ----
  const EBML_ID = 0x1a45dfa3;
  const SEGMENT_ID = 0x18538067;
  const CLUSTER_ID = 0x1f43b675;
  const TIMECODE_ID = 0xe7;
  const WEBM_INIT_KEEP = new Set([0x1549a966 /* Info */, 0x1654ae6b /* Tracks */]);
  const WEBM_LEVEL1 = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, CLUSTER_ID]);
  // Segment header rewritten to "unknown size", since the contents get rebuilt.
  const WEBM_SEGMENT_HEADER = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  function readVint(b, off, isId) {
    if (off >= b.length) return null;
    const first = b[off];
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(first & mask)) {
      mask >>= 1;
      len++;
    }
    if (len > 8) return { bad: true };
    if (off + len > b.length) return null;
    let value = isId ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      value = value * 256 + b[off + i];
      if (b[off + i] !== 0xff) allOnes = false;
    }
    return { value, len, unknown: !isId && allOnes };
  }

  function readElementHeader(b, off) {
    const id = readVint(b, off, true);
    if (!id) return null;
    if (id.bad) return { bad: true };
    const size = readVint(b, off + id.len, false);
    if (!size) return null;
    if (size.bad) return { bad: true };
    return { id: id.value, headerLen: id.len + size.len, size: size.value, unknown: size.unknown };
  }

  function webmClusterTime(b, start, end) {
    let off = start;
    while (off < end) {
      const h = readElementHeader(b, off);
      if (!h || h.bad || h.unknown) return null;
      if (h.id === TIMECODE_ID) {
        let v = 0;
        for (let i = 0; i < h.size; i++) v = v * 256 + b[off + h.headerLen + i];
        return v;
      }
      off += h.headerLen + h.size;
    }
    return null;
  }

  // An unknown-size cluster ends where the next top-level element starts.
  function webmUnknownSizeEnd(b, off) {
    while (off < b.length) {
      const h = readElementHeader(b, off);
      if (!h || h.bad || h.unknown) return null;
      if (WEBM_LEVEL1.has(h.id) || h.id === EBML_ID) return off;
      const end = off + h.headerLen + h.size;
      if (end > b.length) return null;
      off = end;
    }
    return null;
  }

  function feedWebm(track) {
    const b = track.pending;
    let off = 0;
    while (off < b.length) {
      const h = readElementHeader(b, off);
      if (!h) break;
      if (h.bad) {
        track.pending = new Uint8Array(0);
        return;
      }
      if (h.id === EBML_ID) {
        const end = off + h.headerLen + h.size;
        if (end > b.length) break;
        track.initParts = [b.slice(off, end)];
        off = end;
      } else if (h.id === SEGMENT_ID) {
        // Only the header; the Segment's children follow inline.
        track.initParts.push(WEBM_SEGMENT_HEADER);
        off += h.headerLen;
      } else if (h.id === CLUSTER_ID) {
        if (track.initParts.length) {
          setInit(track, joinBytes(track.initParts));
          track.initParts = [];
        }
        const end = h.unknown ? webmUnknownSizeEnd(b, off + h.headerLen) : off + h.headerLen + h.size;
        if (end == null || end > b.length) break;
        addFrag(track, webmClusterTime(b, off + h.headerLen, end), b.slice(off, end));
        off = end;
      } else {
        // Info / Tracks (kept for the init) or SeekHead / Cues / Void / Tags
        // (dropped — their byte offsets would be wrong in the rebuilt file).
        if (h.unknown) {
          track.pending = new Uint8Array(0);
          return;
        }
        const end = off + h.headerLen + h.size;
        if (end > b.length) break;
        if (WEBM_INIT_KEEP.has(h.id) && track.initParts.length) track.initParts.push(b.slice(off, end));
        off = end;
      }
    }
    track.pending = b.slice(off);
  }

  // An unknown-size WebM cluster only ends when the next one starts, so the
  // last cluster of a stream is still sitting in `pending`. Take whatever
  // complete blocks it has.
  function pendingWebmCluster(track) {
    if (track.format !== "webm") return null;
    const b = track.pending;
    const h = readElementHeader(b, 0);
    if (!h || h.bad || h.id !== CLUSTER_ID || !h.unknown) return null;
    let off = h.headerLen;
    while (off < b.length) {
      const c = readElementHeader(b, off);
      if (!c || c.bad || c.unknown || off + c.headerLen + c.size > b.length) break;
      off += c.headerLen + c.size;
    }
    if (off <= h.headerLen) return null;
    return { key: webmClusterTime(b, h.headerLen, off), bytes: b.slice(0, off) };
  }

  function exportTrack(track) {
    let best = null;
    for (const rep of track.reps.values()) if (!best || rep.bytes > best.bytes) best = rep;
    if (!best) {
      // Unrecognized container — fall back to raw append order.
      const bytes = joinBytes(track.raw);
      return bytes.length ? { mime: track.mime, bytes } : null;
    }
    const frags = new Map(best.frags);
    const unkeyed = best.unkeyed.slice();
    const tail = best === track.current ? pendingWebmCluster(track) : null;
    if (tail) {
      if (tail.key == null) unkeyed.push(tail.bytes);
      else if (!frags.has(tail.key)) frags.set(tail.key, tail.bytes);
    }
    const keys = Array.from(frags.keys()).sort((a, b) => a - b);
    const media = keys.length ? keys.map((k) => frags.get(k)) : unkeyed;
    if (!media.length) return null;
    return { mime: best.mime, bytes: joinBytes([best.init, ...media]) };
  }

  function trackBytes(tracks) {
    let n = 0;
    for (const t of tracks || []) {
      for (const r of t.reps.values()) n += r.bytes;
      for (const c of t.raw) n += c.length;
    }
    return n;
  }

  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL(obj);
    if (typeof MediaSource !== "undefined" && obj instanceof MediaSource) {
      urlByMediaSource.set(obj, url);
      tracksByUrl.set(url, []);
    }
    return url;
  };

  if (typeof MediaSource !== "undefined") {
    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sb = origAddSourceBuffer.call(this, mimeType);
      const url = urlByMediaSource.get(this);
      const track = newTrack(mimeType);
      if (url && tracksByUrl.has(url)) tracksByUrl.get(url).push(track);
      trackBySourceBuffer.set(sb, track);
      return sb;
    };

    const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        const track = trackBySourceBuffer.get(this);
        if (track) {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            : new Uint8Array(data).slice();
          if (track.format === "raw") {
            track.raw.push(bytes);
          } else {
            track.pending = concatBytes(track.pending, bytes);
            if (track.format === "mp4") feedMp4(track);
            else feedWebm(track);
          }
        }
      } catch {
        /* never let capture break real playback */
      }
      return origAppendBuffer.call(this, data);
    };

    // The player discards a half-appended segment on abort() (e.g. a seek);
    // our parser must drop its partial bytes too.
    const origAbort = SourceBuffer.prototype.abort;
    SourceBuffer.prototype.abort = function () {
      const track = trackBySourceBuffer.get(this);
      if (track) {
        track.pending = new Uint8Array(0);
        track.frag = null;
      }
      return origAbort.apply(this, arguments);
    };

    if (SourceBuffer.prototype.changeType) {
      const origChangeType = SourceBuffer.prototype.changeType;
      SourceBuffer.prototype.changeType = function (type) {
        const track = trackBySourceBuffer.get(this);
        if (track) {
          track.mime = type;
          track.format = formatOf(type);
          track.pending = new Uint8Array(0);
          track.frag = null;
          track.initParts = [];
        }
        return origChangeType.apply(this, arguments);
      };
    }
  }

  // ---- Full-length capture ----
  // The player only loads a little ahead of where you're watching, so a
  // capture holds just what's been played so far. To get the whole video,
  // play it through from the start, muted and fast, while recording.
  const FULL_CAPTURE_SPEED = 8;

  function findVideoFor(url) {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((v) => v.src === url || v.currentSrc === url) || videos.find((v) => v.src?.startsWith("blob:")) || null;
  }

  // On YouTube, keep the player from dropping quality when it can't keep up
  // with the faster-than-realtime playback.
  function lockYoutubeQuality() {
    try {
      const p = document.getElementById("movie_player");
      const best = (p?.getAvailableQualityLevels?.() || []).find((q) => q !== "auto");
      if (best) {
        p.setPlaybackQualityRange?.(best, best);
        p.setPlaybackQuality?.(best);
      }
    } catch {
      /* not YouTube, or the API changed — fine either way */
    }
  }

  function captureFull(url, requestId) {
    const post = (msg) => window.postMessage({ requestId, ...msg }, "*");
    const video = findVideoFor(url);
    if (!video) {
      post({ __uvdResponse: "captureDone", url });
      return;
    }
    lockYoutubeQuality();
    const prev = { rate: video.playbackRate, muted: video.muted };
    video.muted = true;
    try {
      video.currentTime = 0;
    } catch {
      /* ignore */
    }
    video.playbackRate = FULL_CAPTURE_SPEED;
    video.play().catch(() => {});

    let lastTime = -1;
    let lastProgressAt = Date.now();
    const timer = setInterval(() => {
      if (video.playbackRate !== FULL_CAPTURE_SPEED) video.playbackRate = FULL_CAPTURE_SPEED;
      if (video.paused && !video.ended) video.play().catch(() => {});
      const t = video.currentTime;
      const dur = video.duration;
      if (t > lastTime + 0.01) {
        lastTime = t;
        lastProgressAt = Date.now();
      }
      const percent = Number.isFinite(dur) && dur > 0 ? Math.min(100, Math.floor((t / dur) * 100)) : 0;
      post({ __uvdResponse: "captureProgress", percent });

      const done = video.ended || (Number.isFinite(dur) && dur > 0 && t >= dur - 0.5);
      const stalled = Date.now() - lastProgressAt > 60000;
      if (done || stalled) {
        clearInterval(timer);
        video.playbackRate = prev.rate;
        video.muted = prev.muted;
        video.pause();
        post({ __uvdResponse: "captureDone", url: video.src || url, stalled: stalled && !done });
      }
    }, 1000);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const req = event.data?.__uvdRequest;
    if (req === "captureFull") {
      captureFull(event.data.url, event.data.requestId);
    } else if (req === "getMseChunks") {
      const { requestId } = event.data;
      let tracks = tracksByUrl.get(event.data.url);
      // The player may have swapped MediaSources (new blob: URL) mid-capture;
      // fall back to whichever one actually holds the data.
      if (!trackBytes(tracks)) {
        for (const ts of tracksByUrl.values()) if (trackBytes(ts) > trackBytes(tracks)) tracks = ts;
      }
      const exported = (tracks || [])
        .map(exportTrack)
        .filter(Boolean)
        .map((t) => ({ mime: t.mime, buffer: t.bytes.buffer }));
      window.postMessage(
        { __uvdResponse: "mseChunks", requestId, hasData: exported.length > 0, tracks: exported },
        "*",
        exported.map((t) => t.buffer)
      );
    }
  });

  // YouTube lists its caption tracks (languages, auto-generated or not) in a
  // page global rather than a fetchable playlist like HLS sites use. These
  // are the exact tracks already rendered on screen via the CC button — not
  // the video stream itself, so no signed-URL/Referer protection applies;
  // the timedtext endpoint they point to is the same one the CC button uses.
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    function getYtCaptionTracks() {
      try {
        const fromInitial = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (fromInitial?.length) return fromInitial;
        // Falls back to the live player object, which reflects the current
        // video even after YouTube's SPA navigation (ytInitialPlayerResponse
        // only reflects whatever video the page first loaded with).
        const resp = document.getElementById("movie_player")?.getPlayerResponse?.();
        return resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
      } catch {
        return null;
      }
    }

    let attempts = 0;
    // Keeps retrying/re-posting for a while rather than stopping at the
    // first success — content.js's listener (registered at document_idle,
    // later than this document_start script) might not be attached yet the
    // first time this fires, so a single post could race and be missed.
    const timer = setInterval(() => {
      attempts++;
      const tracks = getYtCaptionTracks();
      if (tracks?.length) {
        const list = tracks.map((t) => {
          // fmt=vtt is flaky (often comes back empty, auto-generated
          // tracks especially) — srv1's plain <text start dur> XML is the
          // most reliably-supported format; background.js converts it.
          const url = new URL(t.baseUrl, location.href);
          url.searchParams.set("fmt", "srv1");
          return {
            url: url.href,
            lang: t.languageCode || null,
            name: (t.name?.simpleText || t.name?.runs?.[0]?.text || null) + (t.kind === "asr" ? " (auto)" : ""),
          };
        });
        console.log("[UVD page-hook] found caption tracks:", list);
        window.postMessage({ __uvdResponse: "youtubeCaptions", tracks: list }, "*");
      } else if (attempts === 5) {
        console.log("[UVD page-hook] no caption tracks found yet after 5s (this video may simply have none).");
      }
      if (attempts > 20) clearInterval(timer);
    }, 1000);

    // A timedtext request we make ourselves comes back empty — YouTube only
    // serves caption text to its own player's requests. So instead, record
    // the response the player itself receives when the user turns CC on,
    // the same "keep what the browser already got" approach as the MSE
    // capture above.
    const capturedCaptions = new Map(); // lang -> {lang, fmt, text}

    function maybeCaptureTimedtext(url, text) {
      try {
        const u = new URL(url, location.href);
        if (!u.pathname.includes("/api/timedtext") || !text || !text.trim()) return;
        const entry = {
          lang: u.searchParams.get("tlang") || u.searchParams.get("lang") || "unknown",
          fmt: u.searchParams.get("fmt") || "",
          text,
        };
        capturedCaptions.set(entry.lang, entry);
        console.log("[UVD page-hook] captured caption track from player:", entry.lang);
        window.postMessage({ __uvdResponse: "youtubeCaptionCaptured", ...entry }, "*");
      } catch {
        /* never let capture break the page */
      }
    }

    const origFetch = window.fetch;
    window.fetch = async function (input) {
      const res = await origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url;
        if (url && url.includes("/api/timedtext")) {
          res.clone().text().then((t) => maybeCaptureTimedtext(url, t)).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__uvdUrl = String(url);
      return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this.__uvdUrl?.includes("/api/timedtext")) {
        this.addEventListener("load", () => {
          try {
            let t = null;
            if (this.responseType === "" || this.responseType === "text") t = this.responseText;
            else if (this.responseType === "json" && this.response) t = JSON.stringify(this.response);
            else if (typeof this.response === "string") t = this.response;
            if (t) maybeCaptureTimedtext(this.__uvdUrl, t);
          } catch {
            /* ignore */
          }
        });
      }
      return origSend.apply(this, arguments);
    };

    // content.js loads later than this script — let it ask for anything
    // already captured before its listener existed.
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.__uvdRequest !== "getCapturedCaptions") return;
      for (const entry of capturedCaptions.values()) {
        window.postMessage({ __uvdResponse: "youtubeCaptionCaptured", ...entry }, "*");
      }
    });
  }
})();
