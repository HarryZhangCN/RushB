"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const fsp = fs.promises;
const WATCH_URL = /^https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})$/;
const VIDEO_EXTENSION = /^\.(mkv|mp4|webm|mov|m4v|flv|avi|ts|3gp)$/i;
const INFO = "RUSHB_YT_INFO:";
const PROGRESS = "RUSHB_YT_PROGRESS:";
const MERGE = "RUSHB_YT_MERGE:";
const FINAL = "RUSHB_YT_FINAL:";
const liveChildren = new Set();

function stopChildren() {
  for (const child of liveChildren) child.kill();
}

async function requireTool(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(`${label} 路径无效。`);
  try {
    if (!(await fsp.stat(file)).isFile()) throw new Error();
  } catch {
    throw new Error(`找不到 ${label}，请检查 YouTube 下载组件。`);
  }
}

function failMessage(line) {
  const detail = String(line || "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[链接]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 260);
  if (/sign in|log[ -]?in|age.restrict|members.only|private video|confirm you.re not a bot/i.test(detail)) {
    return "YouTube 要求登录或验证，暂时无法匿名下载这条视频。";
  }
  if (/unavailable|removed|not available|copyright|deleted/i.test(detail)) {
    return "这条 YouTube 视频或选定格式不可下载。";
  }
  if (/403|429|timeout|timed out|proxy|network|unable to download|connection|certificate/i.test(detail)) {
    return "无法从 YouTube 获取视频，请检查网络或稍后重试。";
  }
  if (/no space|disk full|errno 28/i.test(detail)) return "保存目录的可用空间不足。";
  if (/permission denied|access is denied/i.test(detail)) return "无法写入保存目录，请检查权限。";
  return detail ? `YouTube 下载失败：${detail}` : "YouTube 下载失败，未生成文件。";
}

function numeric(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseRecord(line, marker) {
  if (!line.startsWith(marker)) return null;
  try {
    return JSON.parse(line.slice(marker.length));
  } catch {
    return null;
  }
}

function runYtDlp(executable, args, stage, id, report) {
  return new Promise((resolve, reject) => {
    let completed;
    let title = "";
    let errorLine = "";
    let expectedStreamCount = 1;
    let timedOut = false;
    let highestProgress = 0;
    let isMerging = false;
    const streams = new Map();
    const child = spawn(executable, args, {
      cwd: stage,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    if (liveChildren.size === 0) process.once("exit", stopChildren);
    liveChildren.add(child);

    const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    let idleTimer;
    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stopForTimeout, 3 * 60 * 1000);
    }
    function stopForTimeout() {
      timedOut = true;
      child.kill();
    }
    const overallTimer = setTimeout(stopForTimeout, 2 * 60 * 60 * 1000);
    resetIdle();

    function update(stageName, speed = 0) {
      const rows = Array.from(streams.values());
      const bytesReceived = rows.reduce((sum, row) => sum + row.downloaded, 0);
      const haveTotals = rows.length === expectedStreamCount && rows.every((row) => row.total > 0);
      const totalBytes = haveTotals ? rows.reduce((sum, row) => sum + row.total, 0) : 0;
      const fractions = rows.reduce((sum, row) => sum + (row.total ? Math.min(1, row.downloaded / row.total) : 0), 0);
      const progress = stageName === "merging" ? 98 : Math.min(96, 96 * fractions / expectedStreamCount);
      highestProgress = Math.max(highestProgress, progress);
      report({ stage: stageName, title, progress: highestProgress, bytesReceived, totalBytes, bytesPerSecond: speed });
    }

    function onLine(line, isStderr) {
      resetIdle();
      const info = parseRecord(line, INFO);
      if (info && info.id === id) {
        if (typeof info.title === "string") title = info.title;
        expectedStreamCount = info.secondFormat ? 2 : 1;
        report({ stage: "resolving", title });
        return;
      }
      const progress = parseRecord(line, PROGRESS);
      if (progress) {
        if (!isMerging) {
          const downloaded = numeric(progress.downloaded);
          const suppliedTotal = numeric(progress.total);
          streams.set(String(progress.format || "combined"), {
            downloaded,
            total: Math.max(downloaded, suppliedTotal),
          });
          update("downloading", numeric(progress.speed));
        }
        return;
      }
      if (line.startsWith(MERGE)) {
        if (!isMerging) {
          isMerging = true;
          update("merging");
        }
        return;
      }
      const result = parseRecord(line, FINAL);
      if (result && result.id === id) {
        completed = result;
        return;
      }
      // Errors can contain signed media URLs, so retain only a bounded line and sanitize on output.
      const clean = line.trim();
      if (isStderr && (/^ERROR:/i.test(clean) || (!errorLine && clean))) {
        errorLine = clean.slice(0, 1200);
      }
    }
    stdout.on("line", (line) => onLine(line, false));
    stderr.on("line", (line) => onLine(line, true));
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      stdout.close();
      stderr.close();
      liveChildren.delete(child);
      if (liveChildren.size === 0) process.removeListener("exit", stopChildren);
      if (timedOut) reject(new Error("YouTube 下载已超时，请检查网络后重试。"));
      else if (spawnError) reject(new Error("无法启动 yt-dlp，请检查 YouTube 下载组件。"));
      else if (code !== 0) reject(new Error(failMessage(errorLine)));
      else if (!completed) reject(new Error(title
        ? "YouTube 下载结束，但未生成最终文件。"
        : "YouTube 没有生成视频。正在直播或尚未开始的直播暂不支持。"));
      else resolve({ ...completed, title: completed.title || title });
    });
  });
}

async function inspectOutput(stage, reportedPath) {
  if (typeof reportedPath !== "string" || !path.isAbsolute(reportedPath)) {
    throw new Error("YouTube 下载结果没有有效的文件路径。");
  }
  const output = path.resolve(reportedPath);
  if (path.relative(stage, path.dirname(output)) || !VIDEO_EXTENSION.test(path.extname(output))) {
    throw new Error("YouTube 下载结果没有有效的视频文件。");
  }
  const stat = await fsp.lstat(output).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error("YouTube 视频文件未完整生成。");
  return { output, size: stat.size };
}

async function publishExclusive(stageFile, folder) {
  const { name, ext } = path.parse(path.basename(stageFile));
  const fallbackCodes = new Set(["EACCES", "EINVAL", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);
  let canHardLink = true;
  for (let i = 0; i < 1000; i += 1) {
    const output = path.join(folder, `${name}${i ? ` (${i + 1})` : ""}${ext}`);
    try {
      if (canHardLink) {
        try {
          await fsp.link(stageFile, output);
          return output;
        } catch (error) {
          if (!fallbackCodes.has(error.code)) throw error;
          canHardLink = false;
        }
      }
      await fsp.copyFile(stageFile, output, fs.constants.COPYFILE_EXCL);
      return output;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("保存目录已有过多同名 YouTube 视频。");
}

module.exports = function createYouTubeDownloader({ toolsDirectory, ffmpegLocation }) {
  return async function downloadYouTube({ url, folder, onUpdate }) {
    const id = typeof url === "string" && WATCH_URL.exec(url)?.[1];
    if (!id) throw new Error("请输入有效的 YouTube 视频链接。");
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("YouTube 视频的保存目录无效。");
    if (typeof toolsDirectory !== "string" || !path.isAbsolute(toolsDirectory)) {
      throw new Error("YouTube 下载组件的路径无效。");
    }
    const ytDlp = path.join(toolsDirectory, "yt-dlp.exe");
    const deno = path.join(toolsDirectory, "deno.exe");
    await Promise.all([
      requireTool(ytDlp, "yt-dlp"),
      requireTool(deno, "Deno"),
      requireTool(ffmpegLocation, "FFmpeg"),
    ]);
    const report = (data) => {
      if (typeof onUpdate !== "function") return;
      try {
        onUpdate({ title: "", progress: 0, bytesReceived: 0, totalBytes: 0, bytesPerSecond: 0, ...data });
      } catch {
        // The download does not depend on a live renderer.
      }
    };
    await fsp.mkdir(folder, { recursive: true });
    const saveFolder = await fsp.realpath(folder);
    const stage = await fsp.mkdtemp(path.join(saveFolder, ".rushb-yt-"));
    try {
      report({ stage: "resolving" });
      const args = [
        "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-cookies", "--no-cookies-from-browser",
        "--js-runtimes", `deno:${deno}`,
        "--ffmpeg-location", ffmpegLocation,
        "--no-playlist", "--match-filters", "!is_live & live_status!=?is_upcoming",
        "--format", "bv+ba/b", "--merge-output-format", "mkv",
        "--no-overwrites", "--windows-filenames", "--trim-filenames", "140",
        "--paths", stage, "--output", "%(title).115B [%(id)s].%(ext)s",
        "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "3",
        "--no-color", "--no-simulate", "--progress", "--newline", "--progress-delta", "0.25",
        "--output-na-placeholder", "null",
        "--print", `before_dl:${INFO}{"id":%(id)j,"title":%(title)j,"secondFormat":%(requested_formats.1.format_id)j}`,
        "--progress-template", `download:${PROGRESS}{"format":%(info.format_id)j,"downloaded":%(progress.downloaded_bytes)j,"total":%(progress.total_bytes,progress.total_bytes_estimate)j,"speed":%(progress.speed)j}`,
        "--progress-template", `postprocess:${MERGE}%(progress.status)s`,
        "--print", `after_move:${FINAL}{"id":%(id)j,"title":%(title)j,"path":%(filepath)j}`,
        "--", url,
      ];
      const result = await runYtDlp(ytDlp, args, stage, id, report);
      const { output: stageFile, size } = await inspectOutput(stage, result.path);
      const output = await publishExclusive(stageFile, saveFolder);
      const title = typeof result.title === "string" && result.title.trim() ? result.title.trim() : `YouTube 视频 ${id}`;
      report({ stage: "completed", title, progress: 100, bytesReceived: size, totalBytes: size });
      return { id, title, path: output };
    } finally {
      await fsp.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
  };
};
