"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { pipeline, Transform } = require("stream");
const { promisify } = require("util");

const fsp = fs.promises;
const pipe = promisify(pipeline);
const run = promisify(execFile);
const MAX_METADATA = 128 * 1024;
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const GYAN_HOSTS = new Set(["www.gyan.dev"]);
const DENO_HOSTS = new Set(["dl.deno.land"]);
const GYAN_RELEASES = "https://www.gyan.dev/ffmpeg/builds";
const STABLE_VERSION = /^v?\d{1,4}(?:\.\d{1,4}){1,3}$/;
const COMPONENTS = [
  { id: "yt-dlp", name: "yt-dlp", file: "youtube/yt-dlp.exe", repo: "yt-dlp/yt-dlp", asset: () => "yt-dlp.exe", args: ["--ignore-config", "--no-plugin-dirs", "--version"], version: /^\s*(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)(?:\s|$)/ },
  { id: "deno", name: "Deno", file: "youtube/deno.exe", repo: "denoland/deno", asset: () => "deno-x86_64-pc-windows-msvc.zip", member: () => "deno.exe", args: ["--version"], version: /^deno\s+(\d+\.\d+\.\d+)(?:\s|$)/i },
  { id: "ffmpeg", name: "FFmpeg", file: "ffmpeg.exe", repo: "GyanD/codexffmpeg", asset: version => `ffmpeg-${version}-essentials_build.zip`, member: version => `ffmpeg-${version}-essentials_build/bin/ffmpeg.exe`, args: ["-version"], version: /^ffmpeg version\s+n?(\d+\.\d+(?:\.\d+)?)(?:[-\s]|$)/i },
  { id: "aria2", name: "aria2", file: "aria2c.exe", args: ["--version"], version: /^aria2 version\s+(\d+\.\d+\.\d+)(?:\s|$)/i },
];

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

async function readVersion(component, executable) {
  const result = await run(executable, component.args, { windowsHide: true, timeout: 6000, maxBuffer: 256 * 1024 });
  const match = component.version.exec(result.stdout || result.stderr || "");
  if (!match) throw new Error("无法识别组件版本。");
  return match[1];
}

function validateUrl(value, hosts) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !hosts.has(url.hostname)) {
    throw new Error("更新来源地址未通过校验。");
  }
  return url.href;
}

function requestOnce(net, url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: "GET", redirect: "manual", useSessionCookies: false });
    request.setHeader("User-Agent", "RushB-component-updater");
    request.setHeader("Accept", "*/*");
    const timer = setTimeout(() => {
      reject(new Error("连接更新服务超时。"));
      request.abort();
    }, 15000);
    request.once("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接更新服务。"));
    });
    request.once("redirect", (_code, _method, location) => {
      clearTimeout(timer);
      resolve({ location });
      request.abort();
    });
    request.once("response", response => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        reject(new Error(`更新服务返回 HTTP ${response.statusCode}。`));
        request.abort();
        return;
      }
      resolve({ request, response });
    });
    request.end();
  });
}

async function openResponse(net, address, hosts) {
  let url = validateUrl(address, hosts);
  for (let hop = 0; hop < 5; hop += 1) {
    const result = await requestOnce(net, url);
    if (!result.location) return result;
    url = validateUrl(new URL(result.location, url).href, hosts);
  }
  throw new Error("更新地址重定向次数过多。");
}

async function readMetadata(net, url, hosts) {
  const { request, response } = await openResponse(net, url, hosts);
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => response.destroy(new Error("读取发布信息超时。")), 15000);
  try {
    for await (const chunk of response) {
      length += chunk.length;
      if (length > MAX_METADATA) throw new Error("发布信息超出大小限制。");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    clearTimeout(timer);
    if (!response.complete && !response.readableEnded) request.abort();
  }
}

async function githubLatestTag(net, repo) {
  const endpoint = `https://github.com/${repo}/releases/latest`;
  const result = await requestOnce(net, endpoint);
  if (!result.location) {
    result.request.abort();
    throw new Error("发布页未返回最新稳定版地址。");
  }
  const target = new URL(validateUrl(new URL(result.location, endpoint).href, DOWNLOAD_HOSTS));
  const prefix = `/${repo}/releases/tag/`;
  if (target.hostname !== "github.com" || !target.pathname.startsWith(prefix)) {
    throw new Error("发布页返回的版本地址未通过校验。");
  }
  return target.pathname.slice(prefix.length);
}

function digestFor(component, text, filename) {
  if (component.id === "yt-dlp") {
    for (const line of text.split(/\r?\n/)) {
      const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line);
      if (match && match[2] === filename) return match[1].toLowerCase();
    }
    return "";
  }
  const bare = /^([0-9a-f]{64})(?:\s+\*?\S+)?$/i.exec(text);
  const windows = /^Hash[ \t]*:[ \t]*([0-9a-f]{64})[ \t]*$/im.exec(text.replace(/\r/g, ""));
  return (bare?.[1] || windows?.[1] || "").toLowerCase();
}

async function releaseFor(net, component) {
  let tag;
  if (component.id === "deno") {
    tag = await readMetadata(net, "https://dl.deno.land/release-latest.txt", DENO_HOSTS);
  } else if (component.id === "ffmpeg") {
    tag = await readMetadata(net, `${GYAN_RELEASES}/release-version`, GYAN_HOSTS);
  } else {
    tag = await githubLatestTag(net, component.repo);
  }
  if (!STABLE_VERSION.test(tag)) throw new Error("发布信息没有有效的稳定版本。");
  const version = tag.replace(/^v/, "");
  const filename = component.asset(version);
  const ffmpeg = component.id === "ffmpeg";
  const base = ffmpeg ? `${GYAN_RELEASES}/packages` : `https://github.com/${component.repo}/releases/download/${tag}`;
  const hosts = ffmpeg ? GYAN_HOSTS : DOWNLOAD_HOSTS;
  const checksum = component.id === "yt-dlp" ? "SHA2-256SUMS" : `${filename}${ffmpeg ? ".sha256" : ".sha256sum"}`;
  const hash = digestFor(component, await readMetadata(net, `${base}/${checksum}`, hosts), filename);
  if (!hash) throw new Error("发布页没有提供文件的 SHA-256，无法校验更新。");
  return { version, filename, url: `${base}/${filename}`, hosts, hash };
}

async function download(net, release, target, report) {
  const { request, response } = await openResponse(net, release.url, release.hosts);
  const size = Number(response.headers["content-length"]) || 0;
  if (size > MAX_DOWNLOAD) {
    request.abort();
    throw new Error("更新文件过大。");
  }
  const hash = crypto.createHash("sha256");
  let received = 0;
  let lastProgress = 0;
  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => response.destroy(new Error("更新文件下载超时。")), 25000);
  };
  const overall = setTimeout(() => response.destroy(new Error("更新文件下载超时。")), 10 * 60 * 1000);
  resetIdle();
  try {
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      resetIdle();
      received += chunk.length;
      if (received > MAX_DOWNLOAD || (size > 0 && received > size)) {
        callback(new Error("更新文件超过大小限制。"));
        return;
      }
      hash.update(chunk);
      const now = Date.now();
      if (now - lastProgress >= 500) {
        lastProgress = now;
        const amount = size > 0 ? `${Math.floor(received * 100 / size)}%` : `${(received / (1024 * 1024)).toFixed(1)} MB`;
        report("downloading", `正在下载 ${amount}`);
      }
      callback(null, chunk);
    } });
    await pipe(response, progress, fs.createWriteStream(target, { flags: "wx" }));
    if ((size > 0 && received !== size) || hash.digest("hex") !== release.hash) throw new Error("更新文件未通过 SHA-256 校验。");
  } finally {
    clearTimeout(idle);
    clearTimeout(overall);
    if (!response.complete && !response.readableEnded) request.abort();
  }
}

async function extractMember(archive, member, target) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const tar = path.join(systemRoot, "System32", "tar.exe");
  const { stdout } = await run(tar, ["-tf", archive], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const entries = stdout.split(/\r?\n/).filter(entry => entry === member || entry === "./" + member);
  if (entries.length !== 1) throw new Error("更新包中找不到唯一的组件文件。");
  const child = spawn(tar, ["-xOf", archive, "--", entries[0]], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("无法读取更新包中的组件文件。")));
  });
  let extracted = 0;
  const lengthLimit = new Transform({ transform(chunk, _encoding, callback) {
    extracted += chunk.length;
    if (extracted > MAX_DOWNLOAD) callback(new Error("解包后的组件文件过大。"));
    else callback(null, chunk);
  } });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    await Promise.all([exited, pipe(child.stdout, lengthLimit, fs.createWriteStream(target, { flags: "wx" }))]);
    if (!extracted) throw new Error("更新包中的组件文件为空。");
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = function createRushBComponentUpdater({ net, binDirectory, beforeReplace }) {
  let currentUpdate = null;

  async function getLocal(component) {
    const executable = path.join(binDirectory, component.file);
    try {
      await fsp.access(executable, fs.constants.F_OK);
    } catch (error) {
      return { id: component.id, name: component.name, version: null, status: error.code === "ENOENT" ? "missing" : "unavailable" };
    }
    try {
      return { id: component.id, name: component.name, version: await readVersion(component, executable), status: "installed" };
    } catch {
      return { id: component.id, name: component.name, version: null, status: "unavailable", message: "无法读取已装版本。" };
    }
  }

  async function checkOne(component) {
    const local = await getLocal(component);
    if (!component.repo) return { ...local, status: "manual", message: "由 RushB 安装包管理。" };
    if (process.platform !== "win32" || process.arch !== "x64") return { ...local, status: "manual", message: "内置更新适用于 Windows x64。" };
    if (local.status === "unavailable") return local;
    try {
      const release = await releaseFor(net, component);
      const status = !local.version || compareVersions(local.version, release.version) < 0 ? "available" : "current";
      return { ...local, latest: release.version, status };
    } catch (error) {
      return { ...local, status: "error", message: error.message || "检查更新失败。" };
    }
  }

  async function update(id, onProgress) {
    const component = COMPONENTS.find(item => item.id === id && item.repo);
    if (!component || process.platform !== "win32" || process.arch !== "x64") throw new Error("此组件不支持内置更新。");
    if (currentUpdate) throw new Error("已有组件正在更新。");
    const report = (phase, message) => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ id, phase, message }); } catch { /* window closed */ }
    };
    currentUpdate = id;
    let staging;
    let stagingParent;
    try {
      report("checking", "正在检查版本");
      const local = await getLocal(component);
      if (local.status === "unavailable") throw new Error("无法确认已装版本，未替换组件。");
      const release = await releaseFor(net, component);
      if (local.version && compareVersions(local.version, release.version) >= 0) return { ...local, latest: release.version, status: "current" };

      const destination = path.resolve(binDirectory, component.file);
      const parent = path.dirname(destination);
      await fsp.mkdir(parent, { recursive: true });
      stagingParent = parent;
      staging = await fsp.mkdtemp(path.join(parent, ".rushb-component-"));
      const candidate = path.join(staging, path.basename(destination));
      const asset = component.member ? path.join(staging, "release.zip") : candidate;
      report("downloading", "正在下载更新文件");
      await download(net, release, asset, report);
      report("verifying", "正在校验文件和版本");
      if (component.member) await extractMember(asset, component.member(release.version), candidate);
      const candidateVersion = await readVersion(component, candidate);
      if (compareVersions(candidateVersion, release.version) !== 0) throw new Error("组件文件的版本与发布信息不一致。");

      if (beforeReplace) await beforeReplace(id, event => {
        if (event && typeof event === "object") report(event.phase, event.message);
        else report("waiting", String(event || "等待下载任务结束"));
      });
      const current = await getLocal(component);
      if (current.status === "unavailable") throw new Error("无法确认已装版本，未替换组件。");
      if (current.version && compareVersions(current.version, candidateVersion) >= 0) return { ...current, latest: release.version, status: "current" };
      report("installing", "正在替换组件");
      if (current.version) {
        const backup = path.join(staging, "rollback.copy");
        await fsp.copyFile(destination, backup, fs.constants.COPYFILE_EXCL);
        await fsp.rename(backup, destination + ".previous");
      }
      await fsp.rename(candidate, destination);
      return { id, name: component.name, version: candidateVersion, latest: release.version, status: "current", message: "更新完成。" };
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY") {
        throw new Error("组件正在使用或安装目录不可写，原版本已保留。");
      }
      throw new Error(error.message || "组件更新失败，原版本已保留。");
    } finally {
      if (staging && path.dirname(path.resolve(staging)) === stagingParent && path.basename(staging).startsWith(".rushb-component-")) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      currentUpdate = null;
    }
  }

  return {
    versions: () => Promise.all(COMPONENTS.map(getLocal)),
    check: () => Promise.all(COMPONENTS.map(checkOne)),
    update,
  };
};
