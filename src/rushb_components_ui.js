(() => {
  "use strict";

  const panel = document.getElementById("components-settings");
  const settings = document.getElementById("settings-view");
  if (!panel || !settings) return;

  const { ipcRenderer } = window.require("electron");
  const list = document.getElementById("components-list");
  const status = document.getElementById("components-status");
  const checkButton = document.getElementById("components-check");
  const rows = new Map();
  let operation = "";
  let activeId = "";
  let versionsLoaded = false;

  function normalizeId(id) {
    return typeof id === "string" && id.toLowerCase() === "ytdlp" ? "yt-dlp" : id;
  }

  function createText(tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }

  for (const [id, name] of [["yt-dlp", "yt-dlp"], ["deno", "Deno"], ["ffmpeg", "FFmpeg"], ["aria2", "aria2"]]) {
    const row = document.createElement("li");
    row.className = "components-row";
    const info = document.createElement("div");
    info.className = "components-info";
    const version = createText("span", "components-version", "正在读取版本…");
    const detail = createText("span", "components-detail", "");
    detail.hidden = true;
    const button = createText("button", "text-button components-action", "更新");
    button.type = "button";
    button.hidden = true;
    button.addEventListener("click", () => update(id));
    info.append(createText("span", "components-name", name), version, detail);
    row.append(info, button);
    list.append(row);
    rows.set(id, { name, version, detail, button, requestId: id, data: null });
  }

  function setStatus(message, kind = "") {
    status.dataset.kind = kind;
    status.hidden = !message;
    status.textContent = message;
  }

  function errorMessage(error, fallback) {
    const value = typeof error?.message === "string" ? error.message : "";
    return value.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "").trim().slice(0, 240) || fallback;
  }

  function renderRow(row) {
    const data = row.data;
    if (!data) return;
    const version = data.version ? String(data.version) : "";
    const missing = !version && ["missing", "available"].includes(data.status);
    row.version.textContent = version ? `已装 ${version}` : missing ? "未安装" : "版本不可用";
    const latest = data.latest ? String(data.latest) : "";
    const labels = { current: "已是最新版本", available: latest ? `可更新至 ${latest}` : "有可用更新",
      unavailable: "暂时无法读取", manual: "需手动更新", error: "检查失败" };
    const fallback = data.status === "missing" && latest ? `可安装 ${latest}` : labels[data.status];
    const message = typeof data.message === "string" && data.message.trim() ? data.message : fallback;
    row.detail.textContent = message || "";
    row.detail.hidden = !message;
    row.detail.dataset.kind = data.status === "error" ? "error" : ["available", "missing"].includes(data.status) ? "available" : "";
    const canUpdate = data.status === "available" || (data.status === "missing" && latest);
    row.button.hidden = !canUpdate;
    row.button.disabled = Boolean(operation);
    const action = missing ? "安装" : "更新";
    row.button.textContent = action;
    row.button.setAttribute("aria-label", `${action} ${row.name}`);
  }

  function applyRows(items) {
    if (!Array.isArray(items)) throw new Error("无法读取组件状态。");
    for (const item of items) {
      const row = rows.get(normalizeId(item?.id));
      if (!row) continue;
      row.requestId = item.id;
      row.data = item;
      renderRow(row);
    }
  }

  function setOperation(kind, id = "") {
    operation = kind;
    activeId = id;
    checkButton.disabled = Boolean(kind);
    checkButton.textContent = kind === "check" ? "检查中…" : "检查更新";
    list.setAttribute("aria-busy", String(Boolean(kind)));
    for (const row of rows.values()) row.button.disabled = Boolean(kind);
  }

  async function loadVersions() {
    if (operation || versionsLoaded) return;
    setOperation("versions");
    try {
      applyRows(await ipcRenderer.invoke("rushb:components-versions"));
      versionsLoaded = true;
      setStatus("");
    } catch (error) {
      for (const row of rows.values()) if (!row.data) row.version.textContent = "版本不可用";
      setStatus(errorMessage(error, "无法读取已装组件版本。"), "error");
    } finally {
      setOperation("");
    }
  }

  async function check() {
    if (operation) return;
    setOperation("check");
    setStatus("正在检查组件更新…");
    try {
      const result = await ipcRenderer.invoke("rushb:components-check");
      applyRows(result);
      versionsLoaded = true;
      const actionable = [...rows.values()].filter(row => !row.button.hidden).length;
      const errors = result.filter(item => item?.status === "error").length;
      if (errors) setStatus(actionable ? `有 ${actionable} 个组件可更新或安装，部分组件检查失败。` : "部分组件检查失败，请查看各项状态。", "error");
      else setStatus(actionable ? `有 ${actionable} 个组件可更新或安装。` : "检查完成。");
    } catch (error) {
      setStatus(errorMessage(error, "检查更新失败，请重试。"), "error");
    } finally {
      setOperation("");
    }
  }

  async function update(id) {
    const row = rows.get(id);
    if (operation || !row || row.button.hidden) return;
    const restoreFocus = document.activeElement === row.button;
    document.documentElement.dataset.componentUpdate = "true";
    setOperation("update", id);
    setStatus(`正在处理 ${row.name}…`);
    try {
      const result = await ipcRenderer.invoke("rushb:components-update", row.requestId);
      if (!result || normalizeId(result.id) !== id) throw new Error("无法读取组件更新结果。");
      applyRows([result]);
      if (result.status === "error" || result.status === "unavailable" || result.status === "manual") {
        setStatus(result.message || `${row.name} 更新未完成。`, "error");
      } else {
        const version = result.version ? ` ${result.version}` : "";
        setStatus(`${row.name}${version} 已就绪。`);
      }
    } catch (error) {
      setStatus(errorMessage(error, `${row.name} 更新失败，请重试。`), "error");
    } finally {
      delete document.documentElement.dataset.componentUpdate;
      setOperation("");
      if (restoreFocus && !settings.hidden && (document.activeElement === document.body || document.activeElement === row.button)) {
        (row.button.hidden ? checkButton : row.button).focus({ preventScroll: true });
      }
    }
  }

  ipcRenderer.on("rushb:components-progress", (_event, progress) => {
    if (operation !== "update" || normalizeId(progress?.id) !== activeId) return;
    if (typeof progress.message === "string" && progress.message) setStatus(progress.message);
  });
  checkButton.addEventListener("click", check);
  new MutationObserver(() => {
    if (!settings.hidden) void loadVersions();
  }).observe(settings, { attributes: true, attributeFilter: ["hidden"] });
  if (!settings.hidden) void loadVersions();
})();
