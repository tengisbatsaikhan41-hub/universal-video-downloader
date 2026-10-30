const statusEl = document.getElementById("status");
const listEl = document.getElementById("video-list");

const TYPE_LABEL = {
  video: "MP4/WebM",
  hls: "HLS",
  dash: "DASH",
  blob: "Blob",
  subtitle: "Captions",
};

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function shortUrl(url) {
  if (url.startsWith("blob:")) return url.slice(0, 40) + "…";
  return url.length > 70 ? url.slice(0, 67) + "…" : url;
}

// video.label/url can originate from the page being downloaded from, so
// they're untrusted — never inject them into innerHTML unescaped.
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function render(videos) {
  listEl.innerHTML = "";
  if (videos.length === 0) {
    listEl.innerHTML = '<div class="empty">No videos detected on this page yet.<br/>Play the video, then reopen this popup.</div>';
    return;
  }

  for (const video of videos) {
    const li = document.createElement("li");
    li.className = "video-item";

    const meta = document.createElement("div");
    meta.className = "meta";
    const labelPart = video.label ? `${escapeHtml(video.label)} — ` : "";
    meta.innerHTML = `<span class="tag">${TYPE_LABEL[video.type] || video.type}</span>${labelPart}${escapeHtml(shortUrl(video.url))}`;
    if (video.size) meta.innerHTML += ` <br/>${formatSize(video.size)}`;
    li.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";
    // Subtitles are only embedded on the per-quality path (videoUrl set), so
    // that's the only place the choice means anything.
    let cc = null;
    if (video.videoUrl && video.subtitleUrl) {
      const ccLabel = document.createElement("label");
      ccLabel.className = "cc-toggle";
      ccLabel.title = "Embed subtitles into the MP4";
      cc = document.createElement("input");
      cc.type = "checkbox";
      cc.checked = true;
      ccLabel.append(cc, " CC");
      actions.appendChild(ccLabel);
    }

    const btn = document.createElement("button");
    btn.className = "download-btn";
    btn.textContent = "Download";
    btn.addEventListener("click", () =>
      downloadVideo(cc && !cc.checked ? { ...video, subtitleUrl: null } : video, btn)
    );
    actions.appendChild(btn);

    if (video.type === "hls") {
      const ff = document.createElement("button");
      ff.className = "ffmpeg-btn";
      ff.textContent = "📋 ffmpeg";
      ff.title = "For long videos (~1 h): copies a command — paste it into PowerShell (needs ffmpeg installed)";
      ff.addEventListener("click", () => copyFfmpegCommand(video, ff));
      actions.appendChild(ff);
    }

    li.appendChild(actions);
    listEl.appendChild(li);
  }
}

function copyFfmpegCommand(video, btn) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ action: "getFfmpegCommand", tabId: tab.id, video }, async (response) => {
      try {
        await navigator.clipboard.writeText(response.command);
        btn.textContent = "Copied ✓";
      } catch (err) {
        btn.textContent = "Copy failed";
        console.error(err);
      }
    });
  });
}

function downloadVideo(video, btn) {
  btn.disabled = true;
  btn.textContent = "Downloading…";
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ action: "downloadVideo", tabId: tab.id, video }, (response) => {
      if (response?.pending) {
        btn.textContent = "Recording… (see % on icon)";
      } else if (response?.success) {
        btn.textContent = "Saved ✓";
      } else {
        btn.textContent = "Failed — retry";
        btn.classList.add("error");
        btn.disabled = false;
        console.error(response?.error);
      }
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.runtime.sendMessage({ action: "getVideos", tabId: tab.id }, (response) => {
    const videos = response?.videos || [];
    statusEl.textContent = videos.length
      ? `${videos.length} video${videos.length > 1 ? "s" : ""} found`
      : "No videos found yet — try playing the video first.";
    render(videos);
  });
});
