# Universal Video Downloader

Chrome extension (Manifest V3) that detects videos on a page and saves them locally.

- Direct MP4/WebM, blob/MSE players, HLS (video + audio + optional embedded subtitles), Instagram/Facebook byte-range DASH
- Muxing runs in the browser with ffmpeg.wasm (`ffmpeg/`)

## Install
1. `chrome://extensions` → enable Developer mode
2. Load unpacked → select this folder
3. Play a video, open the extension popup, pick a row, Download

Only download content you have the right to save.
