# RushB（B站视频下载器）

> 世界上最好用的B站视频下载器

## Features

- Paste Bilibili, Douyin, and YouTube video URLs or share text in the same input. YouTube watch URLs, Shorts, and short links download one public video per URL.
- Regular multi-page videos download every page by default. Series show an episode picker, preselecting the episode from the pasted URL; choose individual episodes, select all, or skip that link.
- A URL containing `?p=` preselects the requested page or episode.
- Automatically select the highest available video and audio quality.
- Set a destination folder and inspect the current account status.
- Click the compact circular title-bar button to see active, queued, paused, and failed tasks with progress and speed, or switch to the downloaded-records tab. Each downloaded record has a folder button that opens its saved download directory.
- Clear downloaded history records from that panel; this does not delete the video files on disk.
- Open the download folder from the title-bar download panel. Set the save path and view the highest available quality in Settings.
- Open **Settings → Download components** to see installed versions and check for stable updates to yt-dlp, Deno, and FFmpeg. Updates verify the publisher's SHA-256 checksum and retain the previous executable.
- Sign in with the built-in Bilibili QR code, or import an existing session from the default Edge or Chrome profile. RushB reports a missing bridge or a timed-out import and offers a direct link to QR login.
- Open **Settings → Software statement** for source attribution, content-use rules, local login-data handling, and the disclaimer.
- Dark by default, with higher-opacity Fluent surfaces over real Windows Desktop Acrylic. On Windows build 22621+, the app calls the documented `DwmSetWindowAttribute` API with `DWMWA_SYSTEMBACKDROP_TYPE=DWMSBT_TRANSIENTWINDOW` for the whole window. The bundled Electron 13.6.9 runtime does not expose Electron's newer `backgroundMaterial` method, so RushB passes its native window handle to the Windows helper. The helper logs results to the program folder's `backdrop.log`, falling back to `%LOCALAPPDATA%\RushB\logs\backdrop.log`.
- Minimal interface with downloads shown only in the compact task panel.
- The Windows taskbar uses the RushB name and pink lightning icon.

## Build on Windows

Install Bilidown 1.2.7 locally, then point `BILIDOWN_DIR` at its installation directory and run the builder:

```powershell
$env:BILIDOWN_DIR = 'C:\Path\To\Bilidown'
python .\build_rushb.py
```

The build writes to `dist\`. Set `RUSHB_OUTPUT` to choose another output directory. The builder copies the local Bilidown runtime and patches its ASAR archive with the RushB interface; the upstream installer and runtime are not stored in this repository.

To include YouTube support, set `RUSHB_YOUTUBE_TOOLS` to a directory with `yt-dlp.exe` and `deno.exe`. The tools can also be placed in `resources/bin/youtube/` after installation. YouTube uses the bundled FFmpeg to merge the selected streams without re-encoding.

## Browser login bridge

RushB stores its Electron user data separately at `%APPDATA%\RushB`; it does not reuse the Bilidown profile. The source repository does not contain browser profiles, login cookies, account sessions, download history, or machine-specific settings.

To import a separate Edge or Chrome session, load `browser-extension/` as an unpacked extension in the browser profile signed in to Bilibili. In RushB, open **Settings → From browser** and start the import. The extension transfers only the listed Bilibili login cookies through a one-time token to the local RushB process. The import is user-initiated each time. You can also choose **Settings → QR login** and confirm the sign-in in the Bilibili app.

## Source attribution

RushB is published by **Harry张**.

RushB is a modified version of Bilidown by Bilibili creator **@王子周棋洛**. The original project is no longer maintained and is now being refined and updated by **@Harry张**.
The original project's source availability and license scope have not been verified. This attribution does not imply endorsement or grant additional rights.

## Project layout

- `src/rushb_ui.js` and `src/rushb_ui.css`: desktop interface and batch download flow.
- `browser-extension/`: Edge and Chrome login bridge.
- `launcher/`: Windows launch scripts and a native backdrop helper that applies DWM Desktop Acrylic, dark title bar, rounded corners, and result logging.
- `build_rushb.py`: packages RushB over a local Bilidown installation.
