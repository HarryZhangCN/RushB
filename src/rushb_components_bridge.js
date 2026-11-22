"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const createUpdater = require("./rushb-components.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function aria2IsIdle(port, binDirectory) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const configuration = await fs.promises.readFile(path.join(binDirectory, "aria2c.conf"), "utf8");
  const secret = /^\s*rpc-secret\s*=\s*([^\r\n]*)/m.exec(configuration)?.[1]?.trim();
  const payload = JSON.stringify({ jsonrpc: "2.0", id: "rushb-components", method: "aria2.getGlobalStat", params: secret ? [`token:${secret}`] : [] });
  return new Promise((resolve) => {
    const request = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/jsonrpc", agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) { finish(false); request.destroy(); }
      });
      response.on("error", () => finish(false));
      response.on("end", () => {
        try {
          const state = JSON.parse(body).result;
          finish(response.statusCode === 200 && String(state.numActive) === "0" && String(state.numWaiting) === "0");
        } catch {
          finish(false);
        }
      });
    });
    const timer = setTimeout(() => { finish(false); request.destroy(); }, 1500);
    function finish(idle) { clearTimeout(timer); resolve(idle); }
    request.on("error", () => finish(false));
    request.end(payload);
  });
}

module.exports = function registerComponentManager({ ipcMain, net, binDirectory, getMainWindow, getAria2, isYouTubeBusy }) {
  let updating = false;
  let checkPending = null;

  async function beforeReplace(id, onProgress) {
    const deadline = Date.now() + 60000;
    let notified = false;
    while (Date.now() < deadline) {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) throw new Error("RushB 窗口已关闭，本次未替换组件。");
      if (!isYouTubeBusy()) {
        const aria2 = id === "ffmpeg" ? getAria2() : null;
        if (!aria2 || (await aria2IsIdle(aria2.port, binDirectory).catch(() => false) && !isYouTubeBusy())) return;
      }
      if (!notified) {
        onProgress({ id, phase: "waiting", message: "等待下载或合并任务结束…" });
        notified = true;
      }
      await delay(1200);
    }
    throw new Error("还有下载任务在使用组件，请等任务结束后再更新。");
  }

  const updater = createUpdater({ net, binDirectory, beforeReplace });
  function checkSender(event) {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error("无效的组件管理请求。");
    const url = event.sender.getURL();
    if (!url.startsWith("app://./") || (event.senderFrame && event.senderFrame.url !== url)) {
      throw new Error("无效的组件管理请求。");
    }
  }

  ipcMain.handle("rushb:components-versions", (event) => {
    checkSender(event);
    return updater.versions();
  });
  ipcMain.handle("rushb:components-check", (event) => {
    checkSender(event);
    if (!checkPending) checkPending = updater.check().finally(() => { checkPending = null; });
    return checkPending;
  });
  ipcMain.handle("rushb:components-update", async (event, id) => {
    checkSender(event);
    if (!["yt-dlp", "deno", "ffmpeg"].includes(id)) throw new Error("当前组件不支持在线更新。");
    if (updating) throw new Error("已有组件正在更新。");
    updating = true;
    const report = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("rushb:components-progress", progress);
    };
    try {
      return await updater.update(id, report);
    } finally {
      updating = false;
    }
  });
  return { isUpdating: () => updating };
};
