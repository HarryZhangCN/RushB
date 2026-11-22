"use strict";

// Keep the original aria2 RPC protocol and download implementation. This module
// owns only the child process, readiness checks and bounded crash recovery.
module.exports = function createRushBEngine({ app, portfinder, binDirectory, onPort, onChild, onUnavailable }) {
  const fs = require("fs");
  const path = require("path");
  const http = require("http");
  const { spawn } = require("child_process");
  const executable = path.join(binDirectory, "aria2c.exe");
  const configuration = path.join(binDirectory, "aria2c.conf");
  let child = null;
  let port = 0;
  let pending = null;
  let quitting = false;
  let recoveryTimer = null;
  let stableTimer = null;
  let failures = 0;
  const intentionalStops = new WeakSet();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(event, details = {}) {
    try {
      const directory = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "engine.log");
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
        fs.copyFileSync(file, file + ".previous");
        fs.writeFileSync(file, "");
      }
      // Never log cookies, RPC secrets, video URLs or download filenames.
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + "\n");
    } catch (_) {}
  }

  function rpcReady(targetPort) {
    return new Promise((resolve) => {
      if (!targetPort || quitting) return resolve(false);
      let secret = "";
      try {
        const match = fs.readFileSync(configuration, "utf8").match(/^\s*rpc-secret\s*=\s*(.*?)\s*$/m);
        if (match) secret = match[1];
      } catch (_) { return resolve(false); }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: "rushb-health", method: "aria2.getVersion", params: secret ? ["token:" + secret] : [] });
      let settled = false;
      const finish = (ready) => { if (!settled) { settled = true; resolve(ready); } };
      const request = http.request({ hostname: "127.0.0.1", port: targetPort, path: "/jsonrpc", method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8192) { request.destroy(); finish(false); }
        });
        response.on("error", () => finish(false));
        response.on("end", () => {
          try { const value = JSON.parse(body); finish(response.statusCode === 200 && Boolean(value.result && value.result.version)); }
          catch (_) { finish(false); }
        });
      });
      request.setTimeout(600, () => { request.destroy(); finish(false); });
      request.on("error", () => finish(false));
      request.end(payload);
    });
  }

  function scheduleRecovery() {
    if (quitting || recoveryTimer || failures >= 3) {
      if (!quitting && failures >= 3) onUnavailable();
      return;
    }
    failures += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      ensure().then((ready) => { if (!ready) scheduleRecovery(); });
    }, failures * 500);
  }

  async function stopChild() {
    const previous = child;
    if (!previous) return;
    intentionalStops.add(previous);
    child = null;
    onChild(null);
    clearTimeout(stableTimer);
    if (previous.exitCode !== null || previous.killed) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1200);
      previous.once("close", () => { clearTimeout(timer); resolve(); });
      previous.kill();
    });
  }

  async function start() {
    if (quitting) return false;
    if (child && child.exitCode === null && !child.killed && await rpcReady(port)) {
      onPort(port);
      return true;
    }
    await stopChild();
    if (quitting) return false;
    try {
      port = await portfinder.getPortPromise({ port: 6801, stopPort: 10000 });
      if (quitting) return false;
      onPort(port);
      // spawn does not accumulate execFile's output buffer during long sessions.
      const process = spawn(executable, ["--rpc-listen-port=" + port, "--conf-path=" + configuration], { cwd: binDirectory, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      child = process;
      onChild(process);
      if (process.stderr) process.stderr.resume();
      process.on("error", (error) => log("spawn-error", { code: error.code || "UNKNOWN" }));
      process.once("close", (code, signal) => {
        const stopped = intentionalStops.has(process);
        if (child === process) { child = null; onChild(null); clearTimeout(stableTimer); }
        log("exit", { code, signal, intentional: stopped });
        if (!quitting && !stopped) scheduleRecovery();
      });
      log("starting", { pid: process.pid || null, port });
      const deadline = Date.now() + 6000;
      while (!quitting && child === process && process.exitCode === null && Date.now() < deadline) {
        if (await rpcReady(port)) {
          log("ready", { pid: process.pid, port });
          onPort(port);
          stableTimer = setTimeout(() => { failures = 0; }, 30000);
          return true;
        }
        await sleep(180);
      }
      log("readiness-failed", { port });
      await stopChild();
      return false;
    } catch (error) {
      log("start-error", { code: error.code || "UNKNOWN" });
      await stopChild();
      return false;
    }
  }

  function ensure() {
    if (quitting) return Promise.resolve(false);
    if (pending) return pending;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    pending = start().finally(() => { pending = null; });
    return pending;
  }

  app.once("before-quit", () => {
    quitting = true;
    clearTimeout(recoveryTimer);
    clearTimeout(stableTimer);
    if (child) { intentionalStops.add(child); child.kill(); }
  });
  return { ensure };
};
