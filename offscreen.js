// Runs inside the extension's offscreen document (has DOM/Worker access the
// service worker doesn't) to mux a separately-streamed audio track and/or a
// subtitle track into one playable MP4 with ffmpeg.wasm.
//
// Video/audio/subtitle bytes come in through IndexedDB rather than
// chrome.runtime messages — a message carrying a whole video is routinely
// well over chrome.runtime.sendMessage's hard 64MiB cap, but IndexedDB has
// no such limit and both this document and the background service worker
// share the same extension origin, so they can read/write the same database.

const { FFmpeg } = FFmpegWASM;
let ffmpegPromise = null;

function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("log", ({ message }) => console.log("[ffmpeg]", message));
      await ffmpeg.load({
        coreURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

function openTransferDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("uvd-transfer", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("blobs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

async function putBlob(id, blob) {
  const db = await openTransferDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

// The service worker can't create blob: URLs, so it hands the finished file
// over here and gets back a URL chrome.downloads can read directly.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "revokeObjectUrl") {
    URL.revokeObjectURL(message.url);
    return;
  }
  if (message.action !== "makeObjectUrl") return;
  (async () => {
    try {
      const blob = await getBlob(message.id);
      if (!blob) throw new Error("File to save was not found.");
      deleteBlob(message.id).catch(() => {});
      sendResponse({ url: URL.createObjectURL(blob) });
    } catch (err) {
      sendResponse({ error: err?.message || String(err) });
    }
  })();
  return true; // async response
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "muxTracks") return;

  (async () => {
    const { transferId, hasAudio, hasSubtitle, videoExt = "mp4", audioExt = "mp4", outputExt = "mp4" } = message;
    const videoIn = `video_in.${videoExt}`;
    const audioIn = `audio_in.${audioExt}`;
    const outName = `output.${outputExt}`;
    const ffmpeg = await getFFmpeg();
    const writtenFiles = [videoIn];
    try {
      const videoBlob = await getBlob(`${transferId}-video`);
      if (!videoBlob) throw new Error("Video data not found for muxing.");
      await ffmpeg.writeFile(videoIn, new Uint8Array(await videoBlob.arrayBuffer()));

      const inputArgs = ["-i", videoIn];
      const mapArgs = ["-map", "0:v:0"];

      if (hasAudio) {
        const audioBlob = await getBlob(`${transferId}-audio`);
        if (!audioBlob) throw new Error("Audio data not found for muxing.");
        await ffmpeg.writeFile(audioIn, new Uint8Array(await audioBlob.arrayBuffer()));
        writtenFiles.push(audioIn);
        inputArgs.push("-i", audioIn);
        mapArgs.push("-map", "1:a:0");
      } else {
        // "?" marks the map optional — the video file might already carry
        // its own audio track (single, non-split rendition) or might not.
        mapArgs.push("-map", "0:a:0?");
      }

      const codecArgs = ["-c:v", "copy", "-c:a", "copy"];

      if (hasSubtitle) {
        const subtitleBlob = await getBlob(`${transferId}-subtitle`);
        if (!subtitleBlob) throw new Error("Subtitle data not found for muxing.");
        await ffmpeg.writeFile("subs_in.vtt", new Uint8Array(await subtitleBlob.arrayBuffer()));
        writtenFiles.push("subs_in.vtt");
        const subtitleInputIndex = inputArgs.filter((a) => a === "-i").length;
        inputArgs.push("-i", "subs_in.vtt");
        mapArgs.push("-map", `${subtitleInputIndex}:s:0`);
        // Soft subtitle codec each container accepts.
        codecArgs.push("-c:s", outputExt === "mp4" ? "mov_text" : outputExt === "webm" ? "webvtt" : "srt");
      }

      writtenFiles.push(outName);
      await ffmpeg.exec([...inputArgs, ...codecArgs, ...mapArgs, outName]);

      const output = await ffmpeg.readFile(outName);
      const outputType = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" }[outputExt] || "video/mp4";
      await putBlob(`${transferId}-output`, new Blob([output.slice()], { type: outputType }));
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err?.message || String(err) });
    } finally {
      for (const f of writtenFiles) {
        try {
          await ffmpeg.deleteFile(f);
        } catch {
          /* best effort cleanup */
        }
      }
    }
  })();

  return true; // async response
});
