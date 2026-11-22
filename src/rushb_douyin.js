"use strict";

const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { Transform, pipeline } = require("stream");
const { promisify } = require("util");

const pump = promisify(pipeline);
const PLAYER_HOST = "open.douyin.com";
const SHARE_HOST = "v.douyin.com";
const VIDEO_HOSTS = new Set(["douyin.com", "www.douyin.com", "m.douyin.com", "www.iesdouyin.com", "iesdouyin.com"]);
const PLAYER_DOMAINS = [
  "douyin.com", "open-douyin.com", "douyinvod.com",
  "byteimg.com", "bytetos.com", "ibytedtos.com", "bytescm.com",
  "snssdk.com", "pstatp.com",
];
const REQUEST_TIMEOUT = 18000;
const MAX_METADATA_BYTES = 128 * 1024;

function secureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch (_) {
    return null;
  }
}

function isDomain(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

function isMediaUrl(url) {
  return url && isDomain(url.hostname, "douyinvod.com");
}

function videoId(url) {
  if (!url || !VIDEO_HOSTS.has(url.hostname)) return null;
  const match = /^\/(?:share\/)?video\/(\d{10,24})\/?$/.exec(url.pathname);
  return match ? match[1] : null;
}

function isShareUrl(url) {
  return url && url.hostname === SHARE_HOST && /^\/[A-Za-z0-9_-]{2,64}\/?$/.test(url.pathname);
}

function isPlayerUrl(url) {
  return url && url.hostname === PLAYER_HOST && url.pathname === "/player/video" &&
    /^\d{10,24}$/.test(url.searchParams.get("vid") || "");
}

function isAllowedPlayerRequest(rawUrl, type) {
  const url = secureUrl(rawUrl);
  if (!url) return false;
  if (type === "mainFrame") return isPlayerUrl(url);
  return PLAYER_DOMAINS.some((domain) => isDomain(url.hostname, domain));
}

function firstHeader(response, name) {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function getOnce(net, networkSession, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: "GET",
      url: url.href,
      session: networkSession,
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
    });
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("抖音请求超时，请重试。"));
      request.abort();
    }, REQUEST_TIMEOUT);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    function finish(value) {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      return true;
    }
    request.on("redirect", (_status, _method, destination) => {
      if (finish({ redirect: destination })) request.abort();
    });
    request.on("response", (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        finish({ redirect: firstHeader(response, "location") || "" });
        request.abort();
        return;
      }
      finish({ response, request });
    });
    request.on("error", () => fail(new Error("无法连接抖音，请检查网络。")));
    request.on("abort", () => fail(new Error("抖音请求已中止。")));
    try {
      for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
      request.end();
    } catch (_) {
      fail(new Error("无法发起抖音请求。"));
      request.abort();
    }
  });
}

function redirectedUrl(raw, current) {
  if (!raw) return null;
  try {
    return secureUrl(new URL(raw, current).href);
  } catch (_) {
    return null;
  }
}

async function resolveVideoId(net, networkSession, input) {
  let url = secureUrl(input);
  for (let hop = 0; hop < 6; hop += 1) {
    const id = videoId(url);
    if (id) return id;
    if (!isShareUrl(url)) throw new Error("抖音链接未指向公开的视频作品。");
    const result = await getOnce(net, networkSession, url);
    if (result.response) {
      result.request.abort();
      throw new Error("抖音短链无法解析，试试完整的视频链接。");
    }
    url = redirectedUrl(result.redirect, url);
  }
  throw new Error("抖音短链重定向次数过多。");
}

function readMetadata(response, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      reject(new Error("读取抖音作品信息超时。"));
      request.abort();
    }, REQUEST_TIMEOUT);
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_METADATA_BYTES) {
        clearTimeout(timer);
        reject(new Error("抖音作品信息格式异常。"));
        request.abort();
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(new Error("抖音未返回可用的公开作品信息。"));
      }
    });
    response.once("error", () => {
      clearTimeout(timer);
      reject(new Error("抖音作品信息读取失败。"));
    });
    request.once("error", () => {
      clearTimeout(timer);
      reject(new Error("抖音作品信息读取失败。"));
    });
  });
}

async function getPlayer(net, networkSession, id) {
  const api = new URL("https://open.douyin.com/api/douyin/v1/video/get_iframe_by_video");
  api.searchParams.set("video_id", id);
  const result = await getOnce(net, networkSession, api, { Accept: "application/json" });
  if (!result.response || result.response.statusCode !== 200) {
    if (result.request) result.request.abort();
    throw new Error("抖音开放平台暂时无法提供作品信息。");
  }
  const metadata = await readMetadata(result.response, result.request);
  if (!metadata || Number(metadata.err_no) !== 0) {
    if (metadata && Number(metadata.err_no) === 28003004) throw new Error("这条抖音作品不公开或已下架。");
    throw new Error("抖音开放平台暂未提供这条作品的播放器。");
  }
  const data = metadata.data || {};
  const source = /\bsrc\s*=\s*(["'])(https:\/\/[^"']+)\1/i.exec(data.iframe_code || "");
  const player = source ? secureUrl(source[2].replace(/&amp;/gi, "&")) : null;
  if (!isPlayerUrl(player) || player.searchParams.get("vid") !== id) {
    throw new Error("抖音未提供这条公开作品的播放器。");
  }
  return {
    player,
    title: typeof data.video_title === "string" && data.video_title.trim()
      ? data.video_title.trim()
      : "抖音视频 " + id,
  };
}

const READ_VIDEO_SOURCES = 'Array.from(document.querySelectorAll("video")).map(function (video) {' +
  ' return [video.currentSrc || video.getAttribute("src") || "", video.videoWidth * video.videoHeight];' +
  '})';

async function playerMedia(BrowserWindow, networkSession, player) {
  const window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      session: networkSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  contents.setAudioMuted(true);
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  if (typeof contents.setWindowOpenHandler === "function") {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  } else {
    contents.on("new-window", (event) => event.preventDefault());
  }
  let timer;
  async function read() {
    await window.loadURL(player.href);
    while (!window.isDestroyed()) {
      const entries = await contents.executeJavaScript(READ_VIDEO_SOURCES);
      const candidates = entries
        .filter((entry) => Array.isArray(entry) && typeof entry[0] === "string")
        .map(([src, area]) => ({ url: secureUrl(src), area: Number(area) || 0 }))
        .filter(({ url }) => isMediaUrl(url))
        .sort((a, b) => b.area - a.area);
      if (candidates.length) return candidates[0].url;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("播放器已关闭。");
  }
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("抖音播放器未提供可直接保存的公开视频。")), 22000);
      }),
    ]);
  } catch (_) {
    throw new Error("抖音播放器未提供可直接保存的公开视频。");
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}

async function mediaResponse(net, networkSession, initialUrl, player) {
  let url = initialUrl;
  for (let hop = 0; hop < 6; hop += 1) {
    if (!isMediaUrl(url)) throw new Error("抖音播放器返回了无法确认的媒体地址。");
    const result = await getOnce(net, networkSession, url, {
      Referer: player.origin + "/",
      Accept: "video/mp4,video/*;q=0.9,application/octet-stream;q=0.8",
    });
    if (!result.response) {
      url = redirectedUrl(result.redirect, url);
      continue;
    }
    const { response, request } = result;
    const type = (firstHeader(response, "content-type") || "").split(";")[0].trim().toLowerCase();
    if (response.statusCode !== 200 ||
        !(type.startsWith("video/") || ["application/octet-stream", "application/mp4"].includes(type))) {
      request.abort();
      throw new Error("抖音媒体服务器未返回完整视频。");
    }
    return { response, request };
  }
  throw new Error("抖音视频重定向次数过多。");
}

function safeFilename(title, id) {
  const stem = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, ""))
    .slice(0, 104).join("").replace(/[. ]+$/g, "") || "抖音视频";
  return stem + " [" + id + "]";
}

async function publishFile(temporary, folder, stem) {
  for (let index = 0; index < 1000; index += 1) {
    const output = path.join(folder, stem + (index ? " (" + (index + 1) + ")" : "") + ".mp4");
    try {
      // The exclusive copy also works in folders where hard links are not supported.
      await fs.promises.copyFile(temporary, output, fs.constants.COPYFILE_EXCL);
      return output;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("保存目录已有过多同名抖音视频。");
}

async function saveMedia(net, networkSession, media, player, folder, id, title, report) {
  const temporary = path.join(folder, ".rushb-douyin-" + randomBytes(12).toString("hex") + ".part");
  const { response, request } = await mediaResponse(net, networkSession, media, player);
  const startedAt = Date.now();
  let lastTime = startedAt;
  let lastBytes = 0;
  let idleTimer;
  let bytesReceived = 0;
  let signature = Buffer.alloc(0);
  const totalBytes = Number(firstHeader(response, "content-length")) || 0;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      transfer.destroy(new Error("抖音视频下载超时。"));
      request.abort();
    }, 25000);
  };
  const transfer = new Transform({
    transform(chunk, _encoding, callback) {
      bytesReceived += chunk.length;
      if (signature.length < 12) signature = Buffer.concat([signature, chunk.subarray(0, 12 - signature.length)]);
      if (signature.length === 12 && signature.toString("ascii", 4, 8) !== "ftyp") {
        callback(new Error("抖音返回的内容不是有效的 MP4 视频。"));
        return;
      }
      resetIdle();
      const now = Date.now();
      if (now - lastTime >= 400) {
        report({
          title, stage: "downloading", bytesReceived, totalBytes,
          progress: totalBytes ? Math.min(99, bytesReceived * 100 / totalBytes) : 0,
          bytesPerSecond: (bytesReceived - lastBytes) * 1000 / (now - lastTime),
        });
        lastTime = now;
        lastBytes = bytesReceived;
      }
      callback(null, chunk);
    },
  });
  const overallTimer = setTimeout(() => {
    transfer.destroy(new Error("抖音视频下载超过时间限制。"));
    request.abort();
  }, 45 * 60 * 1000);
  try {
    resetIdle();
    report({ title, stage: "downloading", progress: 0, bytesReceived: 0, totalBytes, bytesPerSecond: 0 });
    await pump(response, transfer, fs.createWriteStream(temporary, { flags: "wx" }));
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    if (signature.length < 12 || (totalBytes && totalBytes !== bytesReceived)) {
      throw new Error("抖音视频下载不完整。");
    }
    const output = await publishFile(temporary, folder, safeFilename(title, id));
    report({
      title, stage: "completed", progress: 100, bytesReceived,
      totalBytes: totalBytes || bytesReceived,
      bytesPerSecond: bytesReceived * 1000 / Math.max(1, Date.now() - startedAt),
    });
    return output;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    request.abort();
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

module.exports = function createDouyinDownloader({ BrowserWindow, session, net }) {
  let networkSession;
  function getSession() {
    if (networkSession) return networkSession;
    networkSession = session.fromPartition("rushb-douyin-" + randomBytes(12).toString("hex"), { cache: false });
    networkSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    if (typeof networkSession.setPermissionCheckHandler === "function") {
      networkSession.setPermissionCheckHandler(() => false);
    }
    networkSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, done) => {
      done({ cancel: !isAllowedPlayerRequest(details.url, details.resourceType) });
    });
    networkSession.on("will-download", (event) => event.preventDefault());
    return networkSession;
  }

  return async function downloadDouyin({ url, folder, onUpdate }) {
    const report = (info) => {
      if (typeof onUpdate !== "function") return;
      try { onUpdate(info); } catch (_) {}
    };
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("抖音视频的保存目录无效。");
    await fs.promises.mkdir(folder, { recursive: true });
    const downloadSession = getSession();
    report({ stage: "resolving", progress: 0, bytesReceived: 0, totalBytes: 0, bytesPerSecond: 0 });
    const id = await resolveVideoId(net, downloadSession, url);
    const { player, title } = await getPlayer(net, downloadSession, id);
    report({ title, stage: "resolving", progress: 0, bytesReceived: 0, totalBytes: 0, bytesPerSecond: 0 });
    const media = await playerMedia(BrowserWindow, downloadSession, player);
    const output = await saveMedia(net, downloadSession, media, player, folder, id, title, report);
    return { id, title, path: output };
  };
};
