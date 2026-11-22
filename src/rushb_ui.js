(() => {
  "use strict";

  const { remote, ipcRenderer } = window.require("electron");
  const http = window.require("http");
  const crypto = window.require("crypto");
  const path = window.require("path");
  const { parseLinks } = window.require(path.join(remote.app.getAppPath(), "rushb-links.js"));
  const shell = document.getElementById("batch-shell");
  const input = document.getElementById("batch-links");
  const countLabel = document.getElementById("link-count");
  const statusLabel = document.getElementById("batch-status");
  const startButton = document.getElementById("start-download");
  const downloadStatusButton = document.getElementById("download-status-button");
  const downloadPanel = document.getElementById("download-panel");
  const downloadPanelOpenFolderButton = document.getElementById("download-panel-open-folder");
  const downloadPanelSummary = document.getElementById("download-panel-summary");
  const downloadActiveList = document.getElementById("download-active-list");
  const downloadCompletedList = document.getElementById("download-completed-list");
  const downloadActiveCount = document.getElementById("download-active-count");
  const downloadCompletedCount = document.getElementById("download-completed-count");
  const downloadTabActive = document.getElementById("download-tab-active");
  const downloadTabCompleted = document.getElementById("download-tab-completed");
  const downloadClearRecordsButton = document.getElementById("download-clear-records");
  const settingsView = document.getElementById("settings-view");
  const settingsButton = document.getElementById("settings-button");
  const aboutButton = document.getElementById("about-button");
  const aboutDialog = document.getElementById("about-dialog");
  const aboutCloseButton = document.getElementById("about-close");
  const aboutAcknowledgeButton = document.getElementById("about-acknowledge");
  const returnToLiteButton = document.getElementById("return-to-rushb");
  const accountStatus = document.getElementById("account-status");
  const accountIdentity = document.getElementById("account-identity");
  const browserStatus = document.getElementById("browser-import-status");
  const browserImportButton = document.getElementById("browser-import");
  const enterBehaviorInputs = [...document.querySelectorAll('input[name="enter-behavior"]')];
  const ctrlEnterShortcutInput = document.getElementById("shortcut-ctrl-enter");
  const customShortcutValue = document.getElementById("custom-shortcut-value");
  const customShortcutHint = document.getElementById("custom-shortcut-hint");
  const customShortcutRecordButton = document.getElementById("custom-shortcut-record");
  const customShortcutClearButton = document.getElementById("custom-shortcut-clear");
  const seriesPicker = document.getElementById("series-picker");
  const seriesList = document.getElementById("series-episode-list");
  const seriesSelectedCount = document.getElementById("series-selected-count");
  const seriesTotalCount = document.getElementById("series-total-count");
  const seriesToggleAll = document.getElementById("series-toggle-all");
  const seriesSelectCurrent = document.getElementById("series-select-current");
  const seriesConfirm = document.getElementById("series-confirm");
  let seriesSelectionResolver = null;
  const windowControls = remote.getCurrentWindow();
  let busy = false;
  let currentDownloadVm = null;
  let downloadStatusTimer = null;
  let sawDownloadWork = false;
  let previousActiveCount = 0;
  const externalTasks = new Map();
  const externalPlatforms = {
    douyin: { name: "抖音", historyKey: "rushb.douyin.downloadHistory", queue: [], running: false },
    youtube: { name: "YouTube", historyKey: "rushb.youtube.downloadHistory", queue: [], running: false },
  };
  let nextExternalTaskId = 0;
  let downloadPanelTab = "active";
  let downloadPanelOpen = false;
  let downloadStatusMessage = "空闲";
  let downloadedRecords = [];
  let downloadedRecordsError = "";
  let downloadedRecordsLoading = false;
  let downloadedRecordsClearing = false;
  let browserImport = null;
  let accountStatusPending = false;
  let savePath = localStorage.getItem("defaultDownPath") || remote.app.getPath("desktop");
  let enterBehavior = localStorage.getItem("rushb.shortcuts.enterBehavior") === "enter-download" ? "enter-download" : "shift-enter-download";
  let ctrlEnterDownloadEnabled = localStorage.getItem("rushb.shortcuts.ctrlEnterDownload") === "true";
  let customDownloadShortcut = null;
  let shortcutCaptureActive = false;
  try {
    const storedShortcut = JSON.parse(localStorage.getItem("rushb.shortcuts.customDownload") || "null");
    if (storedShortcut && typeof storedShortcut.code === "string" && typeof storedShortcut.key === "string") {
      customDownloadShortcut = {
        code: storedShortcut.code,
        key: storedShortcut.key,
        ctrl: storedShortcut.ctrl === true,
        alt: storedShortcut.alt === true,
        shift: storedShortcut.shift === true,
        meta: storedShortcut.meta === true,
      };
    }
  } catch {}
  const extensionPath = path.join(path.dirname(remote.app.getPath("exe")), "RushB浏览器登录桥接");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function showStatus(message, kind = "normal") {
    statusLabel.textContent = message;
    statusLabel.dataset.kind = kind;
  }

  function updateDownloadButtonLabel() {
    const action = downloadPanelOpen ? "再次点击关闭下载任务面板" : "点击打开下载任务面板";
    downloadStatusButton.title = `下载状态：${downloadStatusMessage}；${action}`;
    downloadStatusButton.setAttribute("aria-label", `下载状态：${downloadStatusMessage}；${action}`);
  }

  function setDownloadStatus(state, message) {
    downloadStatusButton.dataset.state = state;
    downloadStatusMessage = message;
    updateDownloadButtonLabel();
  }

  function refreshDownloadStatus() {
    const liveDownloadVm = downloadViewModel();
    if (liveDownloadVm) currentDownloadVm = liveDownloadVm;
    const tasks = activeDownloadTasks(liveDownloadVm || currentDownloadVm);
    const activeCount = tasks.filter((task) => taskState(task).kind === "active").length;
    const pausedCount = tasks.filter((task) => taskState(task).kind === "paused").length;
    const failedCount = tasks.filter((task) => taskState(task).kind === "error").length;
    const waitingCount = tasks.filter((task) => taskState(task).kind === "queued").length;
    if (previousActiveCount > tasks.length) void refreshDownloadedRecords();
    previousActiveCount = tasks.length;

    if (tasks.length > 0) sawDownloadWork = true;
    if (activeCount > 0) {
      setDownloadStatus("active", waitingCount ? `下载中 ${activeCount} 项，另有 ${waitingCount} 项等待` : `下载中 ${activeCount} 项`);
    } else if (busy) {
      setDownloadStatus("processing", "正在解析或启动任务");
    } else if (waitingCount > 0) {
      setDownloadStatus("queued", `队列中 ${waitingCount} 项`);
    } else if (pausedCount > 0) {
      setDownloadStatus("paused", `已暂停 ${pausedCount} 项`);
    } else if (failedCount > 0) {
      setDownloadStatus("error", `${failedCount} 项异常待处理`);
    } else if (statusLabel.dataset.kind === "error") {
      setDownloadStatus("error", "任务启动失败");
    } else if (sawDownloadWork) {
      setDownloadStatus("complete", "任务已完成");
    } else {
      setDownloadStatus("idle", "空闲");
    }
    if (!downloadPanel.hidden) renderActiveDownloadTasks();
  }

  function activeDownloadTasks(model = downloadViewModel() || currentDownloadVm) {
    const tasks = [
      ...(model?.downloading || []),
      ...(model?.download || []),
      ...externalTasks.values(),
    ];
    const seen = new Set();
    return tasks.filter((task) => {
      const key = String(task.gid || (task.bv && task.cid ? `${task.bv}:${task.cid}` : task.cid || task.title || ""));
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => Number(Boolean(right.isDownloading)) - Number(Boolean(left.isDownloading)));
  }

  function taskState(task) {
    if (task.tip || task.status === "error" || task.status === "failed") return { label: "异常", kind: "error" };
    if (task.paused || task.status === "paused") return { label: "已暂停", kind: "paused" };
    if (task.stage === "resolving") return { label: "解析中", kind: "active" };
    if (task.stage === "merging") return { label: "合并中", kind: "active" };
    if (task.isDownloading || task.status === "downloading" || task.status === "active") return { label: "下载中", kind: "active" };
    return { label: "等待中", kind: "queued" };
  }

  function taskProgress(task) {
    const total = Number(task.totalLength || 0);
    const completed = Number(task.completedLength || 0);
    if (total > 0) return Math.max(0, Math.min(100, Math.round(completed / total * 100)));
    const value = Number.parseFloat(String(task.progress || "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value <= 1 && !String(task.progress).includes("%") ? value * 100 : value));
  }

  function createDownloadRow(title, subtitle, state, progress, errorText = "", actionButton = null) {
    const row = document.createElement("article");
    row.className = "download-row";
    const heading = document.createElement("div");
    heading.className = "download-row-heading";
    const titleNode = document.createElement("strong");
    titleNode.className = "download-row-title";
    titleNode.textContent = title || "B 站视频";
    const stateNode = document.createElement("span");
    stateNode.className = `download-row-state is-${state.kind}`;
    stateNode.textContent = state.label;
    const trailing = document.createElement("div");
    trailing.className = "download-row-trailing";
    trailing.append(stateNode);
    if (actionButton) trailing.append(actionButton);
    heading.append(titleNode, trailing);
    row.append(heading);

    if (subtitle) {
      const subtitleNode = document.createElement("p");
      subtitleNode.className = "download-row-subtitle";
      subtitleNode.textContent = subtitle;
      row.append(subtitleNode);
    }

    if (progress) {
      const progressTrack = document.createElement("div");
      progressTrack.className = "download-progress-track";
      const progressFill = document.createElement("span");
      progressFill.style.width = `${progress.value}%`;
      progressTrack.append(progressFill);
      row.append(progressTrack);
      const progressInfo = document.createElement("div");
      progressInfo.className = "download-progress-info";
      const sizeText = document.createElement("span");
      sizeText.textContent = progress.size || `${progress.value}%`;
      progressInfo.append(sizeText);
      if (progress.speed) {
        const speedText = document.createElement("span");
        speedText.textContent = progress.speed;
        progressInfo.append(speedText);
      }
      row.append(progressInfo);
    }

    if (errorText) {
      const error = document.createElement("p");
      error.className = "download-row-error";
      error.textContent = errorText;
      row.append(error);
    }
    return row;
  }

  function renderEmptyList(list, message) {
    const empty = document.createElement("div");
    empty.className = "download-list-empty";
    empty.textContent = message;
    list.replaceChildren(empty);
  }

  function renderActiveDownloadTasks() {
    const tasks = activeDownloadTasks();
    const downloading = tasks.filter((task) => taskState(task).kind === "active").length;
    const waiting = tasks.filter((task) => taskState(task).kind === "queued").length;
    const paused = tasks.filter((task) => taskState(task).kind === "paused").length;
    const failed = tasks.filter((task) => taskState(task).kind === "error").length;
    downloadActiveCount.textContent = String(tasks.length);
    downloadPanelSummary.textContent = tasks.length
      ? [downloading && `下载中 ${downloading}`, waiting && `等待 ${waiting}`, paused && `暂停 ${paused}`, failed && `异常 ${failed}`].filter(Boolean).join(" · ")
      : busy ? "正在解析视频链接…" : "当前没有进行中的任务";
    if (!tasks.length) {
      renderEmptyList(downloadActiveList, busy ? "解析完成后会在这里显示下载进度。" : "开始下载后，进度和速度会显示在这里。被暂停或等待中的任务也会列出。");
      return;
    }
    const fragment = document.createDocumentFragment();
    tasks.forEach((task) => {
      const state = taskState(task);
      const size = String(task.progressMB || "").replace(/^--\/--$/, "");
      const speed = String(task.speed || "").replace(/^0\s*(?:B|bytes)?\/s$/i, "");
      fragment.append(createDownloadRow(
        task.title || task.fenpTitle || task.hejiTitle || task.bv,
        [task.upname, task.fenpTitle && task.title !== task.fenpTitle ? task.fenpTitle : ""].filter(Boolean).join(" · "),
        state,
        { value: taskProgress(task), size: size || (state.kind === "queued" ? "等待下载" : "准备中"), speed },
        task.tip || ""
      ));
    });
    downloadActiveList.replaceChildren(fragment);
  }

  async function readBilibiliRecords() {
    if (typeof indexedDB.databases !== "function") throw new Error("当前运行环境不支持读取下载记录");
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === "downloadDatabase")) return [];
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("downloadDatabase");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("打开下载记录失败"));
    });
    if (!database.objectStoreNames.contains("downloaded")) {
      database.close();
      return [];
    }
    return new Promise((resolve, reject) => {
      const request = database.transaction("downloaded", "readonly").objectStore("downloaded").getAll();
      request.onsuccess = () => {
        const records = request.result || [];
        database.close();
        resolve(records);
      };
      request.onerror = () => {
        database.close();
        reject(request.error || new Error("读取下载记录失败"));
      };
    });
  }

  function readExternalRecords(historyKey) {
    try {
      const records = JSON.parse(localStorage.getItem(historyKey) || "[]");
      return Array.isArray(records) ? records.filter((record) => record && typeof record.path === "string") : [];
    } catch {
      return [];
    }
  }

  function recordTimestamp(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
    return Date.parse(value || "") || 0;
  }

  async function refreshDownloadedRecords() {
    if (downloadedRecordsLoading || downloadedRecordsClearing) return;
    downloadedRecordsLoading = true;
    downloadedRecordsError = "";
    renderDownloadedRecords();
    try {
      const bilibili = await readBilibiliRecords();
      const external = Object.values(externalPlatforms).flatMap(({ historyKey }) => readExternalRecords(historyKey));
      downloadedRecords = [...bilibili, ...external]
        .sort((left, right) => recordTimestamp(right.downDate) - recordTimestamp(left.downDate));
    } catch (error) {
      downloadedRecordsError = error?.message || "读取下载记录失败。";
    } finally {
      downloadedRecordsLoading = false;
      renderDownloadedRecords();
    }
  }

  async function clearDownloadedRecords() {
    if (downloadedRecordsLoading || downloadedRecordsClearing || downloadedRecordsError || !downloadedRecords.length) return;
    downloadedRecordsClearing = true;
    renderDownloadedRecords();
    let database;
    try {
      const databases = await indexedDB.databases();
      if (databases.some((entry) => entry.name === "downloadDatabase")) database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("downloadDatabase");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("打开下载记录失败"));
      });
      if (database?.objectStoreNames.contains("downloaded")) await new Promise((resolve, reject) => {
        const transaction = database.transaction("downloaded", "readwrite");
        const request = transaction.objectStore("downloaded").clear();
        request.onerror = () => reject(request.error || new Error("清理下载记录失败"));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("清理下载记录失败"));
        transaction.onabort = () => reject(transaction.error || new Error("清理下载记录已取消"));
      });
      for (const { historyKey } of Object.values(externalPlatforms)) localStorage.removeItem(historyKey);
      downloadedRecords = [];
      downloadedRecordsError = "";
    } catch (error) {
      downloadedRecordsError = error?.message || "清理下载记录失败。";
    } finally {
      database?.close();
      downloadedRecordsClearing = false;
      renderDownloadedRecords();
      if (!downloadedRecordsError) void refreshDownloadedRecords();
    }
  }

  function renderDownloadedRecords() {
    downloadCompletedCount.textContent = String(downloadedRecords.length);
    downloadClearRecordsButton.disabled = downloadedRecordsLoading || downloadedRecordsClearing || Boolean(downloadedRecordsError) || !downloadedRecords.length;
    if (downloadedRecordsLoading) return renderEmptyList(downloadCompletedList, "正在读取已下载记录…");
    if (downloadedRecordsError) return renderEmptyList(downloadCompletedList, downloadedRecordsError);
    if (!downloadedRecords.length) return renderEmptyList(downloadCompletedList, "暂无下载记录；清理记录不会删除本地视频文件。");
    const fragment = document.createDocumentFragment();
    downloadedRecords.forEach((record) => {
      let dateValue = Number(record.downDate || 0);
      if (dateValue > 0 && dateValue < 100000000000) dateValue *= 1000;
      const date = record.downDate ? new Date(Number.isFinite(dateValue) && dateValue > 0 ? dateValue : record.downDate) : null;
      const dateText = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : String(record.downDate || "已完成");
      const folderButton = document.createElement("button");
      folderButton.type = "button";
      folderButton.className = "download-row-folder";
      folderButton.setAttribute("aria-label", `打开视频所在文件夹：${record.title || record.bv || "B 站视频"}`);
      folderButton.title = "打开视频所在文件夹";
      folderButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M2.5 5.4c0-.8.65-1.45 1.45-1.45h3.6l1.45 1.6h6.55c.8 0 1.45.65 1.45 1.45v.8H2.5V5.4Zm0 3.55h14.5l-1.55 6.15H4.05L2.5 8.95Z"/><path d="M11.9 3.35h4v4m0-4-4.65 4.65"/></svg>';
      folderButton.addEventListener("click", async () => {
        const folder = String(record.path || "").trim();
        if (!folder) {
          downloadPanelSummary.textContent = "这条下载记录没有保存文件夹路径。";
          return;
        }
        try {
          const error = await remote.shell.openPath(folder);
          if (error) throw new Error(error);
          downloadPanelSummary.textContent = "已打开视频所在文件夹。";
        } catch (error) {
          const message = error?.message || "无法打开文件夹。";
          folderButton.title = `打开失败：${message}`;
          downloadPanelSummary.textContent = `无法打开视频所在文件夹：${message}`;
        }
      });
      fragment.append(createDownloadRow(
        record.title || record.bv || "B 站视频",
        [record.upname, record.type, dateText].filter(Boolean).join(" · "),
        { label: "已下载", kind: "complete" },
        null,
        "",
        folderButton
      ));
    });
    downloadCompletedList.replaceChildren(fragment);
  }

  function selectDownloadPanelTab(tab) {
    downloadPanelTab = tab;
    const completed = tab === "completed";
    downloadTabActive.classList.toggle("is-selected", !completed);
    downloadTabCompleted.classList.toggle("is-selected", completed);
    downloadTabActive.setAttribute("aria-selected", String(!completed));
    downloadTabCompleted.setAttribute("aria-selected", String(completed));
    downloadActiveList.hidden = completed;
    downloadCompletedList.hidden = !completed;
    downloadClearRecordsButton.hidden = !completed;
    if (completed) refreshDownloadedRecords();
    else renderActiveDownloadTasks();
  }

  function setDownloadPanelOpen(open) {
    downloadPanelOpen = Boolean(open);
    downloadPanel.hidden = !downloadPanelOpen;
    downloadStatusButton.setAttribute("aria-expanded", String(downloadPanelOpen));
    updateDownloadButtonLabel();
    if (downloadPanelOpen) {
      void refreshDownloadedRecords();
      if (downloadPanelTab !== "completed") renderActiveDownloadTasks();
    }
  }

  function startDownloadStatusMonitor() {
    if (downloadStatusTimer) return;
    refreshDownloadStatus();
    downloadStatusTimer = setInterval(refreshDownloadStatus, 900);
  }

  function updatePathLabel() {
    const settingsPath = document.getElementById("settings-save-path");
    settingsPath.textContent = savePath;
    settingsPath.title = savePath;
  }

  function setAccountStatus(result) {
    if (!result?.ok) {
      accountStatus.textContent = "未能读取";
      accountStatus.dataset.kind = "warning";
      accountIdentity.textContent = result?.error || "请检查网络连接后重试。";
      return;
    }
    if (result.isLogin) {
      accountStatus.textContent = "已登录";
      accountStatus.dataset.kind = "success";
      const badges = [result.uname || "B 站账号", result.mid ? `UID ${result.mid}` : "", result.vip ? "大会员" : "普通账号"];
      accountIdentity.textContent = badges.filter(Boolean).join(" · ");
    } else {
      accountStatus.textContent = "未登录";
      accountStatus.dataset.kind = "warning";
      accountIdentity.textContent = "当前 RushB 没有可用的 B 站登录状态。";
    }
  }

  function refreshAccountStatus() {
    if (accountStatusPending) return;
    accountStatusPending = true;
    accountStatus.textContent = "正在检查";
    accountStatus.dataset.kind = "normal";
    accountIdentity.textContent = "正在读取当前 RushB 账号…";
    let timer;
    const onStatus = (_event, result) => {
      clearTimeout(timer);
      accountStatusPending = false;
      setAccountStatus(result);
    };
    ipcRenderer.once("biliAccountStatus", onStatus);
    timer = setTimeout(() => {
      ipcRenderer.removeListener("biliAccountStatus", onStatus);
      accountStatusPending = false;
      setAccountStatus({ ok: false, error: "读取账号状态超时，请检查网络后重试。" });
    }, 15000);
    ipcRenderer.send("getBiliAccount");
  }

  function setLoginMethod(method) {
    localStorage.setItem("loginMethod", method);
    document.querySelectorAll('input[name="login-method"]').forEach((radio) => {
      radio.checked = radio.value === method;
    });
    document.getElementById("browser-method").hidden = method !== "browser";
    document.getElementById("manual-method").hidden = method !== "manual";
  }

  function formatShortcut(shortcut) {
    const parts = [];
    if (shortcut.ctrl) parts.push("Ctrl");
    if (shortcut.alt) parts.push("Alt");
    if (shortcut.shift) parts.push("Shift");
    if (shortcut.meta) parts.push("⌘");
    parts.push(shortcut.key === " " ? "Space" : shortcut.key);
    return parts.join(" + ");
  }

  function renderShortcutSettings() {
    enterBehaviorInputs.forEach((radio) => {
      radio.checked = radio.value === enterBehavior;
    });
    ctrlEnterShortcutInput.checked = ctrlEnterDownloadEnabled;
    customShortcutValue.textContent = customDownloadShortcut ? formatShortcut(customDownloadShortcut) : "未设置";
    customShortcutClearButton.disabled = !customDownloadShortcut || shortcutCaptureActive;
    customShortcutRecordButton.textContent = shortcutCaptureActive ? "按下组合键…" : "录制组合键";
    customShortcutHint.textContent = shortcutCaptureActive
      ? "请按下 Ctrl、Alt 或 ⌘ 组合键；按 Esc 取消录制。"
      : "只在链接输入框聚焦时生效。录制时按 Esc 取消。";
  }

  function shortcutFromEvent(event) {
    return {
      code: event.code,
      key: event.key.length === 1 ? event.key.toUpperCase() : event.key,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    };
  }

  function isReservedShortcut(shortcut) {
    if (["Escape", "Tab", "Enter", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(shortcut.key)) return true;
    const primaryModifier = shortcut.ctrl || shortcut.meta;
    if (primaryModifier && !shortcut.alt && !shortcut.shift && ["A", "C", "V", "X", "Z", "Y"].includes(shortcut.key)) return true;
    return shortcut.code === "F4" && shortcut.alt;
  }

  function matchesShortcut(event, shortcut) {
    return event.code === shortcut.code
      && event.ctrlKey === shortcut.ctrl
      && event.altKey === shortcut.alt
      && event.shiftKey === shortcut.shift
      && event.metaKey === shortcut.meta;
  }

  function captureShortcutKeydown(event) {
    if (!shortcutCaptureActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      shortcutCaptureActive = false;
      renderShortcutSettings();
      return;
    }
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    const shortcut = shortcutFromEvent(event);
    if (!(shortcut.ctrl || shortcut.alt || shortcut.meta)) {
      customShortcutHint.textContent = "請使用 Ctrl、Alt 或 ⌘ 作为组合键前缀。";
      return;
    }
    if (isReservedShortcut(shortcut)) {
      customShortcutHint.textContent = "这是常用编辑或系统快捷键，请换一个组合键。";
      return;
    }
    customDownloadShortcut = shortcut;
    localStorage.setItem("rushb.shortcuts.customDownload", JSON.stringify(shortcut));
    shortcutCaptureActive = false;
    renderShortcutSettings();
  }

  function showSettings() {
    document.querySelector(".workbench").hidden = true;
    settingsView.hidden = false;
    settingsButton.setAttribute("aria-expanded", "true");
    updatePathLabel();
    refreshAccountStatus();
  }

  function showHome() {
    settingsView.hidden = true;
    document.querySelector(".workbench").hidden = false;
    settingsButton.setAttribute("aria-expanded", "false");
  }

  function toggleSettings() {
    if (settingsView.hidden) showSettings();
    else showHome();
  }

  function openAboutDialog() {
    aboutDialog.hidden = false;
    aboutButton.setAttribute("aria-expanded", "true");
    aboutCloseButton.focus();
  }

  function closeAboutDialog() {
    aboutDialog.hidden = true;
    aboutButton.setAttribute("aria-expanded", "false");
    aboutButton.focus();
  }

  function stopBrowserImport(attempt, message = "") {
    if (browserImport !== attempt) return;
    browserImport = null;
    clearTimeout(attempt.timer);
    attempt.server.close();
    browserImportButton.disabled = false;
    if (message) browserStatus.textContent = message;
  }

  const browserImportPage = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>RushB 账号导入</title><style>
body{margin:0;background:#191619;color:#f5edf2;font:15px 'Segoe UI','Microsoft YaHei',sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:500px;margin:18px;padding:28px;background:#241e23;border:1px solid #493943;border-radius:16px}
h1{font-size:22px;margin:0 0 12px}p{color:#d5c5ce;line-height:1.7;margin:0}
</style><main><h1>RushB 账号导入</h1><p id="bridge-status" role="status">正在等待浏览器扩展响应…</p></main>
<script>
  const status = document.getElementById("bridge-status");
  const waiting = status.textContent;
  setTimeout(() => {
    if (status.textContent === waiting) {
      status.textContent = "暂未收到 RushB 扩展的响应。请在当前 Edge 或 Chrome 的扩展管理页确认登录桥接已加载，或返回 RushB 直接扫码登录。";
    }
  }, 9000);
</script></html>`;

  function startBrowserImport() {
    if (browserImport) stopBrowserImport(browserImport);
    browserStatus.textContent = "正在启动本地连接…";
    const attempt = { token: crypto.randomBytes(32).toString("hex"), server: null, timer: null, started: false };
    browserImport = attempt;

    attempt.server = http.createServer((request, response) => {
      if (browserImport !== attempt || request.socket.remoteAddress !== "127.0.0.1") {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const localUrl = new URL(request.url, "http://127.0.0.1");
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, X-RushB-Token",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Max-Age": "600",
        }).end();
        return;
      }
      if (request.method === "GET" && localUrl.pathname === "/import" && localUrl.searchParams.get("token") === attempt.token) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        response.end(browserImportPage);
        return;
      }
      if (request.method !== "POST" || localUrl.pathname !== "/cookies" || request.headers["x-rushb-token"] !== attempt.token || attempt.started) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      attempt.started = true;
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) request.destroy();
      });
      request.on("end", () => {
        if (browserImport !== attempt) {
          response.writeHead(410).end();
          return;
        }
        let cookies;
        try {
          const payload = JSON.parse(body);
          cookies = payload?.cookies;
          if (!Array.isArray(cookies) || cookies.length > 80) throw new Error("浏览器返回的登录数据无效。");
        } catch {
          response.writeHead(400).end();
          stopBrowserImport(attempt, "浏览器返回的登录数据无效，请重试或直接扫码登录。");
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ accepted: true }));
        stopBrowserImport(attempt);
        verifyBrowserLogin(cookies);
      });
    });

    attempt.server.on("error", () => stopBrowserImport(attempt, "本地连接启动失败，请重试或直接扫码登录。"));
    attempt.server.listen(0, "127.0.0.1", async () => {
      if (browserImport !== attempt) return;
      const { port } = attempt.server.address();
      const pageUrl = `http://127.0.0.1:${port}/import?token=${attempt.token}`;
      browserStatus.textContent = "等待浏览器扩展响应…";
      attempt.timer = setTimeout(() => {
        stopBrowserImport(attempt, "浏览器未返回登录状态。请确认当前浏览器已加载登录桥接，或直接扫码登录。");
      }, 20000);
      try {
        await remote.shell.openExternal(pageUrl);
      } catch {
        stopBrowserImport(attempt, "无法打开默认浏览器。请重试或直接扫码登录。");
      }
    });
  }

  function verifyBrowserLogin(cookies) {
    browserImportButton.disabled = true;
    browserStatus.textContent = "已收到浏览器登录状态，正在验证…";
    const onImported = (_event, result) => {
      clearTimeout(timer);
      browserImportButton.disabled = false;
      if (result?.ok && result.isLogin) {
        browserStatus.textContent = "浏览器账号已导入，并通过 B 站验证。";
        setAccountStatus(result);
      } else {
        browserStatus.textContent = !cookies.length
          ? "当前浏览器没有已登录的 B 站账号，请先登录或直接扫码。"
          : result?.error || "浏览器账号未通过 B 站验证，可改用扫码登录。";
      }
    };
    ipcRenderer.once("biliCookiesImported", onImported);
    const timer = setTimeout(() => {
      ipcRenderer.removeListener("biliCookiesImported", onImported);
      browserImportButton.disabled = false;
      browserStatus.textContent = "B 站验证超时，请重试或直接扫码登录。";
    }, 16000);
    ipcRenderer.send("importBiliCookies", cookies);
  }

  async function openManualLogin() {
    if (browserImport) stopBrowserImport(browserImport, "已切换到扫码登录。");
    await openRoute("/acount");
    shell.classList.remove("is-ready");
    document.body.classList.add("account-mode");
    returnToLiteButton.hidden = false;
  }

  async function returnFromManualLogin() {
    document.body.classList.remove("account-mode");
    returnToLiteButton.hidden = true;
    shell.classList.add("is-ready");
    await openRoute("/search");
    showSettings();
  }

  function collectViewModels(root) {
    const result = [];
    const seen = new Set();
    const visit = (vm) => {
      if (!vm || seen.has(vm)) return;
      seen.add(vm);
      result.push(vm);
      for (const child of vm.$children || []) visit(child);
    };
    visit(root);
    return result;
  }

  function appRoot() {
    return document.getElementById("app")?.__vue__ || null;
  }

  function searchViewModel() {
    return collectViewModels(appRoot()).find((vm) =>
      typeof vm.search === "function" &&
      typeof vm.getVideoDetail === "function" &&
      typeof vm.parseBv === "function"
    );
  }

  function downloadViewModel() {
    return collectViewModels(appRoot()).find((vm) =>
      typeof vm.addDownTask === "function" &&
      typeof vm.connectAria2 === "function" &&
      Array.isArray(vm.downloading)
    );
  }

  async function waitFor(getValue, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = getValue();
      if (value) return value;
      await sleep(100);
    }
    throw new Error("RushB 页面尚未准备好，请稍后再试。");
  }

  function refreshAria2Connection(downloadVm, timeout) {
    return new Promise((resolve) => {
      const before = new Set(ipcRenderer.listeners("Aria2Port"));
      let addedListeners = [];
      let settled = false;
      let timer = null;
      const finish = (port, received = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ipcRenderer.removeListener("Aria2Port", onPort);
        // connectAria2 uses once(); remove only its newly installed listener if no reply arrived.
        if (!received) {
          for (const listener of addedListeners) ipcRenderer.removeListener("Aria2Port", listener);
        }
        resolve(Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 0);
      };
      const onPort = (_event, port) => finish(port, true);
      ipcRenderer.once("Aria2Port", onPort);
      timer = setTimeout(() => finish(0), Math.max(1, timeout));
      try {
        const connecting = downloadVm.connectAria2();
        addedListeners = ipcRenderer.listeners("Aria2Port").filter((listener) => listener !== onPort && !before.has(listener));
        Promise.resolve(connecting).catch(() => finish(0));
      } catch (_) {
        finish(0);
      }
    });
  }

  function checkAria2Within(downloadVm, timeout) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ready === true);
      };
      const timer = setTimeout(() => finish(false), Math.max(1, timeout));
      Promise.resolve().then(() => downloadVm.checkAvailableAria2(downloadVm)).then(finish, () => finish(false));
    });
  }

  async function ensureDownloadEngine(downloadVm) {
    const deadline = Date.now() + 20000;
    let receivedPort = false;
    let restartError = "";
    const waitUntilReady = async (until) => {
      while (Date.now() < until) {
        const port = await refreshAria2Connection(downloadVm, Math.min(1200, until - Date.now()));
        receivedPort = receivedPort || port > 0;
        if (port && await checkAria2Within(downloadVm, Math.min(1500, Math.max(1, until - Date.now())))) {
          downloadVm.aria2Available = true;
          return true;
        }
        if (Date.now() < until) await sleep(Math.min(250, until - Date.now()));
      }
      return false;
    };

    // Always refresh the main process port: an automatic restart can invalidate the old RPC object.
    if (await waitUntilReady(Math.min(deadline, Date.now() + 5000))) return;
    const hasActiveDownloads = Array.isArray(downloadVm.downloading) && downloadVm.downloading.some((task) =>
      task.isDownloading && !task.paused && task.status !== "paused"
    );
    if (hasActiveDownloads) throw new Error("无法连接下载引擎。当前仍有下载任务，已保留现有进程，请稍后重试。");

    showStatus("正在恢复下载引擎…");
    const onRestart = (_event, started, detail) => {
      if (!started) {
        const message = typeof detail === "string" ? detail : detail?.error || detail?.message;
        if (message) restartError = String(message).slice(0, 180);
      }
    };
    ipcRenderer.on("aria2-restart-status", onRestart);
    try {
      ipcRenderer.send("restart-aria2");
      // A child-process handle is not readiness; wait for a successful getVersion RPC.
      if (await waitUntilReady(deadline)) return;
    } finally {
      ipcRenderer.removeListener("aria2-restart-status", onRestart);
    }
    downloadVm.aria2Available = false;
    if (restartError) throw new Error(`下载引擎未能启动：${restartError}`);
    if (!receivedPort) throw new Error("下载引擎未能启动：主进程没有返回本机下载端口。");
    throw new Error("下载引擎未能启动：本机连接超时，已尝试重新连接和重启。请重新打开 RushB 后再试。");
  }

  async function openRoute(path) {
    const root = await waitFor(appRoot);
    try {
      await root.$router.push(path);
    } catch (_) {
      // Vue Router reports a duplicate-navigation error when the route is already active.
    }
    await sleep(120);
  }

  function chooseHighestQuality(searchVm) {
    searchVm.selectDefaultQnBySystem = function (videoMap, audioMap) {
      const videoRank = { 127: 0, 126: 1, 125: 2, 120: 3, 116: 4, 112: 5, 80: 6, 74: 7, 64: 8, 32: 9, 16: 10, 6: 11 };
      const codecRank = { av01: 0, hev1: 1, avc1: 2 };
      const videos = (videoMap || []).map((item, index) => ({ item, index }));
      videos.sort((left, right) => {
        const leftCode = String(left.item.qnCode);
        const rightCode = String(right.item.qnCode);
        const leftRank = videoRank[leftCode] ?? (100 - Number(leftCode || 0) / 1000);
        const rightRank = videoRank[rightCode] ?? (100 - Number(rightCode || 0) / 1000);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return (codecRank[left.item.codecs] ?? 9) - (codecRank[right.item.codecs] ?? 9);
      });

      const audioRank = (item) => {
        const description = String(item.qnDesc || "").toLowerCase();
        if (/hi.?res|flac|无损/.test(description)) return 0;
        if (/dolby|杜比/.test(description)) return 1;
        const ranks = { 30251: 0, 30250: 1, 30280: 2, 30232: 3, 30216: 4 };
        return ranks[String(item.qnCode)] ?? (20 - Number(item.qnCode || 0) / 100000);
      };
      const audios = (audioMap || []).map((item, index) => ({ item, index }));
      audios.sort((left, right) => audioRank(left.item) - audioRank(right.item));

      const bestVideo = videos[0];
      const bestAudio = audios[0];
      return {
        video: bestVideo ? { videoDesc: bestVideo.item.qnDesc, videoIndex: bestVideo.index } : { videoDesc: "", videoIndex: -1 },
        audio: bestAudio ? { audioDesc: bestAudio.item.qnDesc, audioIndex: bestAudio.index } : { audioDesc: "", audioIndex: -1 },
      };
    };
  }

  function episodePage(episode, index) {
    return index + 1;
  }

  function updateSeriesSelectionCount() {
    const selectedCount = seriesList.querySelectorAll('input[type="checkbox"]:checked').length;
    seriesSelectedCount.textContent = String(selectedCount);
    seriesConfirm.disabled = selectedCount === 0;
    seriesToggleAll.textContent = selectedCount === Number(seriesTotalCount.textContent) ? "取消全选" : "全选";
  }

  function closeSeriesPicker(selection) {
    if (!seriesSelectionResolver) return;
    const resolve = seriesSelectionResolver;
    seriesSelectionResolver = null;
    seriesPicker.hidden = true;
    resolve(selection);
  }

  function chooseSeriesEpisodes(searchVm) {
    const media = searchVm.mediaData || {};
    const rawEpisodes = Array.isArray(media.heji) && media.heji.length
      ? media.heji
      : (Array.isArray(searchVm.selectPages) ? searchVm.selectPages : []);
    const episodes = rawEpisodes.map((episode, index) => ({ episode, page: episodePage(episode, index), index }));
    if (!episodes.length) return Promise.resolve({ pages: [] });

    const availablePages = new Set(episodes.map((item) => item.page));
    const parsedPage = Number(searchVm.p || 0);
    const previouslySelected = Array.isArray(searchVm.selectedP)
      ? searchVm.selectedP.map(Number).filter((page) => availablePages.has(page))
      : [];
    const currentPage = availablePages.has(parsedPage)
      ? parsedPage
      : (previouslySelected[0] || episodes[0].page);
    const mediaTitle = media.title || searchVm.videoTitle || "当前视频";
    const seriesTitle = media.hejiTitle || "合集 / 系列";
    document.getElementById("series-picker-subtitle").textContent = `${seriesTitle} · ${mediaTitle}`;
    seriesList.replaceChildren();
    seriesTotalCount.textContent = String(episodes.length);

    for (const item of episodes) {
      const label = document.createElement("label");
      label.className = "series-episode";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = String(item.page);
      checkbox.checked = item.page === currentPage;
      checkbox.dataset.current = String(item.page === currentPage);
      checkbox.addEventListener("change", updateSeriesSelectionCount);
      const number = document.createElement("span");
      number.className = "series-episode-number";
      number.textContent = `第 ${item.page} 集`;
      const title = document.createElement("span");
      title.className = "series-episode-title";
      title.textContent = item.episode?.long_title || item.episode?.title || item.episode?.part || `视频 ${item.index + 1}`;
      label.append(checkbox, number, title);
      seriesList.append(label);
    }

    updateSeriesSelectionCount();
    seriesPicker.hidden = false;
    seriesConfirm.focus();
    return new Promise((resolve) => {
      seriesSelectionResolver = resolve;
    });
  }

  async function parseLink(link, tasks) {
    await openRoute("/search");
    const searchVm = await waitFor(searchViewModel);
    chooseHighestQuality(searchVm);

    const previousCommit = searchVm.commitWaitDownArr;
    searchVm.commitWaitDownArr = async function () {
      for (const task of this.waitDown || []) tasks.push(task);
      this.waitDown = [];
      this.pagesReqState = "pending";
    };

    try {
      searchVm.nativeLink = link;
      await searchVm.$nextTick();
      await searchVm.search(true);
      if (searchVm.selectPages?.length) {
        const isSeries = Array.isArray(searchVm.mediaData?.heji) && searchVm.mediaData.heji.length > 0;
        if (isSeries) {
          const choice = await chooseSeriesEpisodes(searchVm);
          if (!choice.pages?.length) return { skipped: true };
          searchVm.selectedP = choice.pages;
        } else {
          const specificPage = Number(searchVm.p || 0);
          if (specificPage > 0 && searchVm.selectPages.some((page) => Number(page.page) === specificPage)) {
            searchVm.selectedP = [specificPage];
          } else {
            searchVm.selectedP = searchVm.selectPages.map((page) => Number(page.page));
          }
        }
        await searchVm.getPagesDetails();
      }
      if (searchVm.waitDown?.length) await searchVm.commitWaitDownArr();
    } finally {
      if (typeof previousCommit === "function") searchVm.commitWaitDownArr = previousCommit;
    }
  }

  function queueExternalDownloads(platform, links, folder) {
    const engine = externalPlatforms[platform];
    let added = 0;
    for (const { url } of links) {
      const existing = [...externalTasks.values()].find((task) => task.platform === platform && task.url === url);
      if (existing && existing.status !== "error") continue;
      if (existing) externalTasks.delete(existing.gid);
      const id = `${platform}-${Date.now()}-${++nextExternalTaskId}`;
      const task = { gid: id, platform, url, folder, title: `${engine.name}视频`, upname: engine.name, status: "queued" };
      externalTasks.set(id, task);
      engine.queue.push(task);
      added += 1;
    }
    if (added) void runExternalQueue(platform, engine);
    return added;
  }

  async function runExternalQueue(platform, engine) {
    if (engine.running) return;
    engine.running = true;
    try {
      while (engine.queue.length) {
        while (platform === "youtube" && document.documentElement.dataset.componentUpdate === "true") await sleep(250);
        const task = engine.queue.shift();
        task.stage = "resolving";
        task.isDownloading = true;
        task.status = "active";
        refreshDownloadStatus();
        let result;
        try {
          result = await ipcRenderer.invoke(`rushb:${platform}-download`, { id: task.gid, url: task.url, folder: task.folder });
          if (!result || typeof result.path !== "string" || !path.isAbsolute(result.path)) {
            throw new Error("未收到已保存的视频文件。");
          }
        } catch (error) {
          task.isDownloading = false;
          task.stage = "";
          task.status = "error";
          task.tip = String(error?.message || "下载失败，请重试。").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
          if (!busy && !engine.queue.length) showStatus(`${engine.name} 下载失败：${task.tip}`, "error");
          refreshDownloadStatus();
          continue;
        }
        let historySaved = true;
        try {
          const records = readExternalRecords(engine.historyKey).filter((record) => record.filePath !== result.path);
          records.unshift({
            id: result.id,
            title: result.title || task.title,
            path: path.dirname(result.path),
            filePath: result.path,
            type: engine.name,
            downDate: Date.now(),
          });
          localStorage.setItem(engine.historyKey, JSON.stringify(records));
        } catch {
          historySaved = false;
        }
        externalTasks.delete(task.gid);
        if (!busy && !engine.queue.length) {
          const message = historySaved ? `${engine.name} 视频已保存。` : `${engine.name} 视频已保存，下载记录写入失败。`;
          showStatus(message, historySaved ? "success" : "warning");
        }
        void refreshDownloadedRecords();
        refreshDownloadStatus();
      }
    } finally {
      engine.running = false;
    }
  }

  function readableBytes(value) {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${value} B`;
  }

  for (const [platform, engine] of Object.entries(externalPlatforms)) {
    ipcRenderer.on(`rushb:${platform}-progress`, (_event, id, update) => {
      const task = externalTasks.get(id);
      if (!task || task.platform !== platform || !update) return;
      if (typeof update.title === "string" && update.title.trim()) task.title = update.title;
      task.stage = update.stage;
      task.totalLength = Number(update.totalBytes) || 0;
      task.completedLength = Number(update.bytesReceived) || 0;
      task.progress = `${Number(update.progress) || 0}%`;
      const size = task.completedLength
        ? `${readableBytes(task.completedLength)}${task.totalLength ? ` / ${readableBytes(task.totalLength)}` : ""}`
        : "";
      if (update.stage === "resolving") task.progressMB = `正在解析 ${engine.name} 视频`;
      else if (update.stage === "merging") task.progressMB = "正在合并音视频";
      else task.progressMB = size || "准备中";
      task.speed = update.bytesPerSecond > 0 ? `${readableBytes(update.bytesPerSecond)}/s` : "";
    });
  }

  async function startBatch() {
    if (busy) return;
    if (document.documentElement.dataset.componentUpdate === "true") {
      showStatus("下载组件正在更新，完成后即可下载。", "warning");
      return;
    }
    const { links, unsupported } = parseLinks(input.value);
    if (!links.length) {
      const message = unsupported ? "目前支持 B 站、抖音和 YouTube 视频链接。" : "粘贴视频链接或分享文案。";
      showStatus(message, "error");
      input.focus();
      return;
    }

    busy = true;
    refreshDownloadStatus();
    startButton.disabled = true;
    startButton.classList.add("is-busy");
    const tasks = [];
    const failed = [];
    const skipped = [];
    const taskKeys = new Set();
    const folder = savePath;
    const bilibili = links.filter((link) => link.platform === "bilibili");
    const details = [];
    if (unsupported) details.push(`忽略了 ${unsupported} 条不支持的链接`);

    try {
      for (const [platform, engine] of Object.entries(externalPlatforms)) {
        const matching = links.filter((link) => link.platform === platform);
        const added = queueExternalDownloads(platform, matching, folder);
        if (added) details.push(`已加入 ${added} 个 ${engine.name} 下载`);
        if (matching.length > added) details.push(`${matching.length - added} 个 ${engine.name} 任务已在队列中`);
      }
      for (let index = 0; index < bilibili.length; index += 1) {
        const { url } = bilibili[index];
        showStatus(`正在解析 B 站链接 ${index + 1} / ${bilibili.length}…`);
        const before = tasks.length;
        try {
          const result = await parseLink(url, tasks);
          if (result?.skipped) {
            skipped.push(url);
            continue;
          }
        } catch (error) {
          failed.push(url);
        }
        if (tasks.length === before && !failed.includes(url)) failed.push(url);
        await sleep(100);
      }

      const uniqueTasks = tasks.filter((task) => {
        const key = `${task.bv || ""}:${task.cid || ""}`;
        if (taskKeys.has(key)) return false;
        taskKeys.add(key);
        return Boolean(task.bv && task.cid);
      });

      if (failed.length) details.push(`${new Set(failed).size} 条 B 站链接解析失败`);
      if (skipped.length) details.push(`已跳过 ${skipped.length} 条系列链接`);
      if (uniqueTasks.length) {
        showStatus(`正在启动 B 站下载引擎…已解析 ${uniqueTasks.length} 个视频`);
        await openRoute("/download");
        const downloadVm = await waitFor(downloadViewModel);
        await ensureDownloadEngine(downloadVm);
        downloadVm.downDirectory = folder;
        downloadVm.download.push(...uniqueTasks);
        for (const task of uniqueTasks) await downloadVm.addDownTask(task);
        details.unshift(`已开始下载 ${uniqueTasks.length} 个 B 站视频`);
      }
      showStatus(details.length ? `${details.join("；")}。` : "没有解析到可下载的视频。", failed.length || unsupported ? "warning" : "success");
    } catch (error) {
      details.push(error?.message || "启动 B 站下载失败，请重试。");
      showStatus(details.join("；"), links.length > bilibili.length ? "warning" : "error");
    } finally {
      busy = false;
      startButton.disabled = false;
      startButton.classList.remove("is-busy");
      refreshDownloadStatus();
    }
  }

  function updateCount() {
    const { links, unsupported } = parseLinks(input.value);
    const counts = { bilibili: 0, douyin: 0, youtube: 0 };
    for (const { platform } of links) counts[platform] += 1;
    countLabel.textContent = [counts.bilibili && `B 站 ${counts.bilibili}`, counts.douyin && `抖音 ${counts.douyin}`,
      counts.youtube && `YouTube ${counts.youtube}`, unsupported && `不支持 ${unsupported}`]
      .filter(Boolean).join(" · ") || "0 个链接";
  }

  async function chooseSavePath() {
    const result = await remote.dialog.showOpenDialog(windowControls, {
      title: "选择保存位置",
      defaultPath: savePath,
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result.canceled && result.filePaths?.[0]) {
      savePath = result.filePaths[0];
      localStorage.setItem("defaultDownPath", savePath);
      updatePathLabel();
      const downloadVm = downloadViewModel();
      if (downloadVm) downloadVm.downDirectory = savePath;
    }
  }

  document.getElementById("settings-choose-folder").addEventListener("click", chooseSavePath);
  settingsButton.addEventListener("click", toggleSettings);
  document.getElementById("back-to-home").addEventListener("click", showHome);
  aboutButton.addEventListener("click", openAboutDialog);
  aboutCloseButton.addEventListener("click", closeAboutDialog);
  aboutAcknowledgeButton.addEventListener("click", closeAboutDialog);
  aboutDialog.addEventListener("click", (event) => {
    if (event.target === aboutDialog) closeAboutDialog();
  });
  document.getElementById("open-manual-login").addEventListener("click", openManualLogin);
  returnToLiteButton.addEventListener("click", returnFromManualLogin);
  document.getElementById("open-extension-folder").addEventListener("click", () => remote.shell.openPath(extensionPath));
  browserImportButton.addEventListener("click", startBrowserImport);
  document.getElementById("browser-manual-login").addEventListener("click", openManualLogin);
  downloadStatusButton.addEventListener("click", () => setDownloadPanelOpen(!downloadPanelOpen));
  document.getElementById("download-panel-close").addEventListener("click", () => setDownloadPanelOpen(false));
  downloadTabActive.addEventListener("click", () => selectDownloadPanelTab("active"));
  downloadTabCompleted.addEventListener("click", () => selectDownloadPanelTab("completed"));
  downloadClearRecordsButton.addEventListener("click", clearDownloadedRecords);
  seriesToggleAll.addEventListener("click", () => {
    const checkboxes = [...seriesList.querySelectorAll('input[type="checkbox"]')];
    const select = checkboxes.some((checkbox) => !checkbox.checked);
    checkboxes.forEach((checkbox) => { checkbox.checked = select; });
    updateSeriesSelectionCount();
  });
  seriesSelectCurrent.addEventListener("click", () => {
    const checkboxes = [...seriesList.querySelectorAll('input[type="checkbox"]')];
    checkboxes.forEach((checkbox) => { checkbox.checked = checkbox.dataset.current === "true"; });
    updateSeriesSelectionCount();
  });
  seriesConfirm.addEventListener("click", () => {
    const pages = [...seriesList.querySelectorAll('input[type="checkbox"]:checked')].map((checkbox) => Number(checkbox.value));
    closeSeriesPicker({ pages });
  });
  document.getElementById("series-skip").addEventListener("click", () => closeSeriesPicker({ pages: [] }));
  document.getElementById("series-cancel").addEventListener("click", () => closeSeriesPicker({ pages: [] }));
  seriesPicker.addEventListener("click", (event) => {
    if (event.target === seriesPicker) closeSeriesPicker({ pages: [] });
  });
  document.addEventListener("keydown", (event) => {
    if (!aboutDialog.hidden) {
      if (event.key === "Escape") {
        closeAboutDialog();
      } else if (event.key === "Tab") {
        const focusable = [...aboutDialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !aboutDialog.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !aboutDialog.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
      return;
    }
    if (!seriesPicker.hidden && event.key === "Escape") closeSeriesPicker({ pages: [] });
    else if (downloadPanelOpen && event.key === "Escape") setDownloadPanelOpen(false);
  });
  document.querySelectorAll('input[name="login-method"]').forEach((radio) => {
    radio.addEventListener("change", () => setLoginMethod(radio.value));
  });
  enterBehaviorInputs.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      enterBehavior = radio.value === "enter-download" ? "enter-download" : "shift-enter-download";
      localStorage.setItem("rushb.shortcuts.enterBehavior", enterBehavior);
    });
  });
  ctrlEnterShortcutInput.addEventListener("change", () => {
    ctrlEnterDownloadEnabled = ctrlEnterShortcutInput.checked;
    localStorage.setItem("rushb.shortcuts.ctrlEnterDownload", String(ctrlEnterDownloadEnabled));
  });
  customShortcutRecordButton.addEventListener("click", () => {
    shortcutCaptureActive = !shortcutCaptureActive;
    renderShortcutSettings();
  });
  customShortcutClearButton.addEventListener("click", () => {
    customDownloadShortcut = null;
    shortcutCaptureActive = false;
    localStorage.removeItem("rushb.shortcuts.customDownload");
    renderShortcutSettings();
  });
  document.addEventListener("keydown", captureShortcutKeydown, true);

  downloadPanelOpenFolderButton.addEventListener("click", () => remote.shell.openPath(savePath));
  startButton.addEventListener("click", startBatch);
  input.addEventListener("input", updateCount);
  input.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      input.select();
      return;
    }
    if (event.isComposing || event.keyCode === 229) return;
    if (customDownloadShortcut && matchesShortcut(event, customDownloadShortcut)) {
      event.preventDefault();
      startBatch();
      return;
    }
    const isEnter = event.key === "Enter";
    const hasPrimaryModifier = event.ctrlKey || event.metaKey;
    if (isEnter && ctrlEnterDownloadEnabled && hasPrimaryModifier && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      startBatch();
      return;
    }
    const plainEnter = isEnter && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    const shiftEnter = isEnter && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    const shouldDownload = enterBehavior === "enter-download" ? plainEnter : shiftEnter;
    if (shouldDownload) {
      event.preventDefault();
      startBatch();
    }
  });
  document.getElementById("minimize-window").addEventListener("click", () => windowControls.minimize());
  document.getElementById("maximize-window").addEventListener("click", () => {
    windowControls.isMaximized() ? windowControls.unmaximize() : windowControls.maximize();
  });
  document.getElementById("close-window").addEventListener("click", () => windowControls.close());

  updatePathLabel();
  updateCount();
  renderShortcutSettings();
  setLoginMethod(localStorage.getItem("loginMethod") === "browser" ? "browser" : "manual");
  startDownloadStatusMonitor();

  const promoteElementUiOverlays = () => {
    const visibleContainers = new Set();
    const isNotDisplayNone = (element) => {
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        if (node.hidden || window.getComputedStyle(node).display === "none") return false;
      }
      return true;
    };
    const setImportant = (element, name, value) => {
      if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== "important") {
        element.style.setProperty(name, value, "important");
      }
    };
    for (const overlay of document.querySelectorAll(".el-message-box__wrapper, .el-dialog__wrapper")) {
      if (isNotDisplayNone(overlay)) visibleContainers.add(overlay);
    }
    for (const panel of document.querySelectorAll(".processExitAlert")) {
      const overlay = panel.closest(".el-message-box__wrapper, .el-dialog__wrapper") || panel;
      if (isNotDisplayNone(overlay)) visibleContainers.add(overlay);
    }
    if (!visibleContainers.size) return;
    for (const mask of document.querySelectorAll(".v-modal")) {
      if (!isNotDisplayNone(mask)) continue;
      if (mask.parentElement !== document.body) document.body.appendChild(mask);
      setImportant(mask, "position", "fixed");
      setImportant(mask, "inset", "0");
      setImportant(mask, "z-index", "2147483645");
      setImportant(mask, "pointer-events", "auto");
    }
    for (const overlay of visibleContainers) {
      if (overlay.parentElement !== document.body) document.body.appendChild(overlay);
      setImportant(overlay, "position", "fixed");
      setImportant(overlay, "top", "0");
      setImportant(overlay, "right", "0");
      setImportant(overlay, "bottom", "0");
      setImportant(overlay, "left", "0");
      setImportant(overlay, "z-index", "2147483647");
      setImportant(overlay, "pointer-events", "auto");
      for (const child of overlay.querySelectorAll(".el-message-box, .el-dialog, [role=dialog], button, input, a")) {
        setImportant(child, "pointer-events", "auto");
      }
      if (!overlay.matches(".el-message-box__wrapper, .el-dialog__wrapper")) {
        setImportant(overlay, "top", "50%");
        setImportant(overlay, "left", "50%");
        setImportant(overlay, "right", "auto");
        setImportant(overlay, "bottom", "auto");
        setImportant(overlay, "transform", "translate(-50%, -50%)");
      }
    }
  };
  const elementUiOverlayObserver = new MutationObserver(promoteElementUiOverlays);
  elementUiOverlayObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  promoteElementUiOverlays();
  const initialize = async () => {
    try {
      await waitFor(appRoot);
      await openRoute("/search");
      shell.classList.add("is-ready");
      refreshAccountStatus();
      input.focus();
    } catch (error) {
      shell.classList.add("is-ready");
      showStatus(error?.message || "界面初始化失败。", "error");
    }
  };

  initialize();
})();
