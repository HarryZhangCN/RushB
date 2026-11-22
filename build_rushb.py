from __future__ import annotations

import base64
import json
import os
import re
import shutil
import struct
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
BILIDOWN_DIR = os.environ.get("BILIDOWN_DIR")
SOURCE = Path(BILIDOWN_DIR) if BILIDOWN_DIR else None
OUTPUT = Path(os.environ.get("RUSHB_OUTPUT", str(PROJECT_ROOT / "dist")))
ASAR = SOURCE / "resources" / "app.asar" if SOURCE else None

JS_SOURCE = PROJECT_ROOT / "src" / "rushb_ui.js"
CSS_SOURCE = PROJECT_ROOT / "src" / "rushb_ui.css"
ENGINE_SOURCE = PROJECT_ROOT / "src" / "rushb_engine.js"
DOUYIN_SOURCE = PROJECT_ROOT / "src" / "rushb_douyin.js"
YOUTUBE_SOURCE = PROJECT_ROOT / "src" / "rushb_youtube.js"
YOUTUBE_TOOLS = os.environ.get("RUSHB_YOUTUBE_TOOLS")
LINKS_SOURCE = PROJECT_ROOT / "src" / "rushb_links.js"
EXTENSION_SOURCE = PROJECT_ROOT / "browser-extension"
LAUNCHER_SOURCE = PROJECT_ROOT / "launcher"
BACKDROP_SOURCE = LAUNCHER_SOURCE / "Set-RushBBackdrop.ps1"
PUBLISHER_ID = "Harry张"
WINDOWS_APP_ID = "RushB.VideoDownloader"
BRANDING = PROJECT_ROOT / "branding"
APP_ICON = BRANDING / "rushb.ico"
APP_LOGO_PNG = BRANDING / "rushb-128.png"
LEGACY_RENDERER = "assets/js/app.8ec346bd.js"
COMPONENT_RESOURCES = {
    "rushb-components.js": "rushb_components.js",
    "rushb-components-bridge.js": "rushb_components_bridge.js",
    "assets/js/rushb-components-ui.js": "rushb_components_ui.js",
    "assets/css/rushb-components-ui.css": "rushb_components_ui.css",
}


INDEX_HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>RushB（B站视频下载器）</title>
  <link href="./assets/css/chunk-vendors.00d3c6de.css" rel="stylesheet">
  <link href="./assets/css/app.cfce7cff.css" rel="stylesheet">
  <link href="./assets/css/rushb-ui-dialog-fix.css" rel="stylesheet">
  <script defer src="./assets/js/chunk-vendors.6f104f4c.js"></script>
  <script defer src="./assets/js/app.8ec346bd.js"></script>
  <script defer src="./assets/js/rushb-ui-dialog-fix.js"></script>
</head>
<body>
  <div id="app"></div>
  <div id="batch-shell">
    <header class="app-header">
      <div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M12.1 1.8 5.55 9.45a1.1 1.1 0 0 0 .84 1.81h3.19l-1.2 6.43a.85.85 0 0 0 1.48.69l6.57-7.9a1.1 1.1 0 0 0-.84-1.8h-3.23l1.3-5.84a.85.85 0 0 0-1.56-1.04Z"/></svg></span><span>RushB（B站视频下载器）</span></div>
      <div class="window-actions">
        <button id="download-status-button" class="download-status" type="button" data-state="idle" aria-haspopup="dialog" aria-expanded="false" aria-controls="download-panel" aria-label="下载状态：空闲；点击打开下载任务面板" title="下载状态：空闲；点击打开下载任务面板">
          <span class="download-status-arrow" aria-hidden="true">&#8595;</span>
          <span class="download-status-dot" aria-hidden="true"></span>
        </button>
        <button id="settings-button" aria-label="设置" title="设置" aria-controls="settings-view" aria-expanded="false">&#9881;</button>
        <button id="minimize-window" aria-label="最小化">&#8212;</button>
        <button id="maximize-window" aria-label="最大化">&#9633;</button>
        <button id="close-window" aria-label="关闭">&#215;</button>
      </div>
    </header>
    <main class="workbench">
      <section class="input-card">
        <textarea id="batch-links" spellcheck="false" placeholder="粘贴 B 站、抖音或 YouTube 链接，也可粘贴分享文案"></textarea>
        <div class="input-meta">
          <span id="link-count">0 个链接</span>
        </div>
      </section>
      <button id="start-download">一键下载</button>
      <div id="batch-status" role="status" aria-live="polite"></div>
    </main>
    <main id="settings-view" class="settings-view" hidden>
      <div class="settings-intro">
        <button id="back-to-home" class="text-button back-button">&#8592; 返回下载器</button>
        <p class="eyebrow">设置</p>
        <h1>账号与下载</h1>
      </div>
      <section class="login-settings-group" aria-label="账号与登录">
        <p class="section-title login-group-title">账号与登录</p>
        <section class="settings-card account-card">
          <div class="account-heading"><span>登录状态</span><span id="account-status" class="status-pill">正在检查</span></div>
          <div id="account-identity" class="account-identity">正在读取当前 RushB 账号…</div>
          <p class="settings-hint">高画质与高音质按当前账号权限自动选择。</p>
        </section>
        <p class="section-title login-method-title">登录方式</p>
        <div class="login-methods">
          <label class="method-card">
            <input type="radio" name="login-method" value="browser">
            <span><strong>从浏览器获取</strong><small>导入 Edge / Chrome 中已登录的 B 站账号</small></span>
          </label>
          <label class="method-card">
            <input type="radio" name="login-method" value="manual">
            <span><strong>自行登录</strong><small>在 RushB 内使用 B 站扫码登录</small></span>
          </label>
        </div>
        <section id="browser-method" class="settings-card method-panel">
          <p>在默认 Edge 或 Chrome 的当前配置中登录 B 站，并在扩展管理页加载 RushB 登录桥接。</p>
          <div class="settings-actions">
            <button id="browser-import" class="settings-primary">从浏览器获取登录状态</button>
            <button id="open-extension-folder" class="text-button">打开扩展目录</button>
            <button id="browser-manual-login" class="text-button">直接扫码登录</button>
          </div>
          <div id="browser-import-status" class="method-status" role="status"></div>
        </section>
        <section id="manual-method" class="settings-card method-panel" hidden>
          <p>打开 RushB 账号页，使用 B 站客户端扫码登录；登录完成后返回此页刷新账号状态。</p>
          <button id="open-manual-login" class="settings-primary">打开扫码登录</button>
        </section>
      </section>
      <section class="settings-card download-settings">
        <div class="account-heading"><span>下载设置</span><span class="settings-value">最高可用画质 / 音质</span></div>
        <div class="save-row settings-save-row">
          <span class="save-label">保存到</span>
          <span id="settings-save-path"></span>
          <button id="settings-choose-folder" class="text-button">更改</button>
        </div>
      </section>
      <p class="section-title keyboard-section-title">快捷键与自定义</p>
      <section class="settings-card keyboard-settings" aria-label="快捷键设置">
        <div class="account-heading"><span>回车行为</span><span class="settings-value">链接输入框</span></div>
        <div class="shortcut-preset-list">
          <label class="shortcut-option">
            <input type="radio" name="enter-behavior" value="shift-enter-download" checked>
            <span><strong>回车换行</strong><small>Shift + Enter 开始下载</small></span>
          </label>
          <label class="shortcut-option">
            <input type="radio" name="enter-behavior" value="enter-download">
            <span><strong>回车下载</strong><small>Shift + Enter 换行</small></span>
          </label>
        </div>
        <label class="shortcut-toggle">
          <input id="shortcut-ctrl-enter" type="checkbox">
          <span class="shortcut-copy"><strong>Ctrl + Enter 快速下载</strong><small>开启后可随时用组合键开始下载</small></span>
          <kbd>Ctrl + Enter</kbd>
        </label>
        <div class="custom-shortcut-row">
          <div class="custom-shortcut-copy"><strong>自定义下载组合键</strong><small id="custom-shortcut-value">未设置</small></div>
          <div class="custom-shortcut-actions">
            <button id="custom-shortcut-record" class="text-button" type="button">录制组合键</button>
            <button id="custom-shortcut-clear" class="text-button" type="button" disabled>清除</button>
          </div>
        </div>
        <p id="custom-shortcut-hint" class="settings-hint custom-shortcut-hint" role="status">只在链接输入框聚焦时生效。录制时按 Esc 取消。</p>
        <div class="shortcut-reference" aria-label="常用编辑快捷键">
          <span>常用编辑</span><kbd>Ctrl + A 全选</kbd><kbd>Ctrl + C 复制</kbd><kbd>Ctrl + V 粘贴</kbd><kbd>Ctrl + X 剪切</kbd><kbd>Ctrl + Z 撤销</kbd><kbd>Ctrl + Y 重做</kbd>
        </div>
      </section>
      <p class="section-title">关于</p>
      <button id="about-button" class="settings-card about-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="about-dialog">
        <span class="about-button-copy"><strong>软件声明</strong><small>项目来源、使用规范、隐私说明与免责声明</small></span>
        <span class="about-button-chevron" aria-hidden="true">&#8250;</span>
      </button>
    </main>
    <div id="about-dialog" class="about-overlay" hidden>
      <section class="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title">
        <header class="about-dialog-header">
          <div><p class="eyebrow">RushB（B站视频下载器）</p><h2 id="about-dialog-title">软件声明</h2></div>
          <button id="about-close" class="about-close" type="button" aria-label="关闭软件声明">&#215;</button>
        </header>
        <div class="about-dialog-body" tabindex="-1">
          <p class="about-lead">非官方个人改版 <span>·</span> 更新日期：2026 年 11 月 2 日</p>
          <section class="about-section">
            <h3>项目来源</h3>
            <p>RushB 基于 B 站 UP 主 <strong>@王子周棋洛</strong> 的 Bilidown 魔改。原项目已停止维护，现由 <strong>@Harry张</strong> 进行优化更新。</p>
            <p>RushB 为非官方个人改版，与哔哩哔哩平台及原作者不存在隶属、官方合作或背书关系。原项目是否公开源代码及其许可证范围尚未核实；相关著作权和许可范围以权利人公开信息及适用许可证为准，本改版不代表获得了超出原许可的授权。</p>
          </section>
          <section class="about-section">
            <h3>功能与数据处理</h3>
            <p>RushB 在本机运行，提供链接解析和下载界面，不提供视频上传、托管或对外分享服务。解析、账号校验和下载需要连接 B 站相关服务，实际可用画质取决于视频资源、账号权限及平台接口。</p>
            <p>选择“从浏览器获取”时，扩展会将本次导入所需的 B 站登录 Cookie 经本机 127.0.0.1 一次性连接传给 RushB，再写入本机 Electron 登录会话。RushB 的登录会话存放在 Windows 用户的 RushB 数据目录（%APPDATA%\RushB），与 Bilidown 配置独立保存；本机登录数据不包含在源码仓库中。Cookie 可代表账号访问权限，请妥善保管设备和账号。</p>
          </section>
          <section class="about-section">
            <h3>内容权利与使用规范</h3>
            <p>视频、音频、字幕及其他内容的著作权和相关权益归相应权利人所有；上传者不一定是全部内容的权利人。RushB 不授予用户下载、复制、改编、传播或商业使用任何内容的权利。</p>
            <p>使用前应确认自己已取得必要授权，或有适用法律依据，并遵守 B 站现行规则。仅供个人学习、研究或欣赏等用途，并不当然意味着取得授权或适用法定例外。</p>
            <p>未经权利人许可，不得将下载内容再次上传、公开传播、销售或用于商业用途；不得利用本软件绕过付费、账号权限、技术保护措施或访问限制。</p>
          </section>
          <section class="about-section">
            <h3>免责声明</h3>
            <p>软件按现状提供，不保证解析与下载持续可用、结果完整、速度稳定或兼容所有设备。平台接口、网络环境、账号权限、系统依赖或第三方组件变化，都可能导致功能受限或失败。请在下载前核对链接和保存位置，并自行管理本地文件及备份。</p>
            <p>用户应对其账号、下载内容及后续使用行为负责。因未经授权使用内容、违反平台规则、保管不当或操作不当产生的后果，由实施相关行为的用户依法承担相应责任。法律允许的范围内，开发者不对第三方服务变化、网络中断或用户行为造成的损失承担超出法律规定的责任；本条不排除依法不得排除或限制的责任。</p>
          </section>
          <section class="about-section">
            <h3>免费与分发</h3>
            <p>RushB 面向个人免费使用，禁止以任何付费方式售卖、分发或将其打包收费。重新分发本改版时应保留来源说明，不得冒称官方，并应遵守适用许可证。</p>
          </section>
        </div>
        <footer class="about-dialog-footer">
          <button id="about-acknowledge" class="settings-primary" type="button">已阅读</button>
        </footer>
      </section>
    </div>
    <section id="download-panel" class="download-panel" role="dialog" aria-modal="false" aria-labelledby="download-panel-title" hidden>
      <header class="download-panel-header">
        <div><h2 id="download-panel-title">下载任务</h2><p id="download-panel-summary">正在读取任务…</p></div>
        <div class="download-panel-header-actions">
          <button id="download-panel-open-folder" class="download-panel-folder" type="button" title="打开保存位置">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.7 5.4a1.4 1.4 0 0 1 1.4-1.4h4l1.7 1.8h6.1a1.4 1.4 0 0 1 1.4 1.4v7.4A1.4 1.4 0 0 1 15.9 16H4.1a1.4 1.4 0 0 1-1.4-1.4V5.4Z"/><path d="M2.9 7.1h13.9"/></svg>
            <span>打开保存位置</span>
          </button>
          <button id="download-panel-close" class="download-panel-close" type="button" aria-label="关闭下载任务面板">&#215;</button>
        </div>
      </header>
      <div class="download-tabs" role="tablist" aria-label="下载任务分类">
        <button id="download-tab-active" class="download-tab is-selected" type="button" role="tab" aria-selected="true" aria-controls="download-active-list">正在进行 <span id="download-active-count">0</span></button>
        <button id="download-tab-completed" class="download-tab" type="button" role="tab" aria-selected="false" aria-controls="download-completed-list">已下载 <span id="download-completed-count">0</span></button>
        <button id="download-clear-records" class="download-clear-records" type="button" aria-label="清理已下载记录" title="清理已下载记录，不删除本地视频文件" hidden>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.2h11l-.7 9.1a1.4 1.4 0 0 1-1.4 1.3H6.6a1.4 1.4 0 0 1-1.4-1.3l-.7-9.1Z"/><path d="M3 4.5h14M7.3 4.5l.6-1.4h4.2l.6 1.4M8 8.3v5.4m4-5.4v5.4"/></svg>
          <span>清理</span>
        </button>
      </div>
      <div id="download-active-list" class="download-list" role="tabpanel" aria-labelledby="download-tab-active"></div>
      <div id="download-completed-list" class="download-list" role="tabpanel" aria-labelledby="download-tab-completed" hidden></div>
    </section>
    <div id="series-picker" class="series-picker" hidden>
      <section class="series-dialog" role="dialog" aria-modal="true" aria-labelledby="series-picker-title">
        <div class="series-dialog-heading">
          <div>
            <p class="eyebrow">系列视频</p>
            <h2 id="series-picker-title">选择要下载的视频</h2>
            <p id="series-picker-subtitle" class="series-subtitle"></p>
          </div>
          <span class="series-count"><strong id="series-selected-count">0</strong> / <span id="series-total-count">0</span> 集</span>
        </div>
        <div class="series-toolbar">
          <button id="series-toggle-all" class="text-button">全选</button>
          <button id="series-select-current" class="text-button">只选当前集</button>
        </div>
        <div id="series-episode-list" class="series-episode-list"></div>
        <div class="series-dialog-footer">
          <button id="series-skip" class="text-button">跳过此链接</button>
          <div class="series-dialog-actions">
            <button id="series-cancel" class="series-secondary">取消</button>
            <button id="series-confirm" class="series-primary">下载所选</button>
          </div>
        </div>
      </section>
    </div>
  </div>
  <button id="return-to-rushb" hidden>返回 RushB（B站视频下载器）</button>
</body>
</html>
'''


BRIDGE_MAIN = r'''function bilidownReplyAccount(sender,channel){const request=r.net.request({method:"GET",url:"https://api.bilibili.com/x/web-interface/nav",session:r.session.defaultSession,useSessionCookies:!0});request.setHeader("User-Agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36");request.setHeader("Referer","https://www.bilibili.com");let body="";request.on("response",response=>{response.on("data",chunk=>body+=chunk.toString());response.on("end",()=>{try{const result=JSON.parse(body),data=result.data||{};sender.send(channel,{ok:0===result.code,isLogin:!!data.isLogin,uname:data.uname||"",mid:data.mid||"",vip:!!(data.vipStatus||data.vip_type),error:0===result.code?"":result.message||"账号状态读取失败"})}catch(error){sender.send(channel,{ok:!1,isLogin:!1,error:error.message})}})});request.on("error",error=>sender.send(channel,{ok:!1,isLogin:!1,error:error.message}));request.end()}const bilidownCookieNames=new Set(["SESSDATA","bili_jct","DedeUserID","DedeUserID__ckMd5","sid","buvid3","buvid4","buvid_fp","buvid_fp_plain","b_nut","CURRENT_FNVAL","CURRENT_QUALITY","CURRENT_PID","_uuid"]);r.ipcMain.on("getBiliAccount",event=>bilidownReplyAccount(event.sender,"biliAccountStatus")),r.ipcMain.on("importBiliCookies",async(event,cookies)=>{try{if(!Array.isArray(cookies)||cookies.length>80)throw new Error("浏览器返回的 Cookie 数据无效");const selected=cookies.filter(cookie=>cookie&&bilidownCookieNames.has(cookie.name)&&typeof cookie.value==="string"&&cookie.value&&/^\.?(?:[a-z0-9-]+\.)*bilibili\.com$/i.test(String(cookie.domain||"")));if(!selected.some(cookie=>cookie.name==="SESSDATA"))throw new Error("未找到 SESSDATA。请先在浏览器登录 B 站后重试");const session=r.session.defaultSession,existing=await session.cookies.get({});for(const cookie of existing){if(bilidownCookieNames.has(cookie.name)&&/(^|\.)bilibili\.com$/i.test(String(cookie.domain||""))){const domain=String(cookie.domain).replace(/^\./,"");await session.cookies.remove("https://"+domain+(cookie.path||"/"),cookie.name)}}for(const cookie of selected){const domain=String(cookie.domain).replace(/^\./,"");const options={url:"https://"+domain+(cookie.path||"/"),name:cookie.name,value:cookie.value,domain:cookie.domain,path:cookie.path||"/",secure:!!cookie.secure,httpOnly:!!cookie.httpOnly,sameSite:["no_restriction","lax","strict","unspecified"].includes(cookie.sameSite)?cookie.sameSite:"unspecified"};if(Number.isFinite(cookie.expirationDate))options.expirationDate=cookie.expirationDate;await session.cookies.set(options)}if(session.cookies.flushStore)await session.cookies.flushStore();bilidownReplyAccount({send:(channel,status)=>event.sender.send("biliCookiesImported",Object.assign({count:selected.length},status))},"biliCookiesImported")}catch(error){event.sender.send("biliCookiesImported",{ok:!1,isLogin:!1,error:error.message})}}),'''

BACKDROP_READY = r'''E.once("ready-to-show",()=>{const fs=require("fs"),d=c.dirname(process.execPath),l=c.join(d,"backdrop-startup.log"),g=m=>{try{fs.appendFileSync(l,new Date().toISOString()+" "+m+"\r\n")}catch(t){}};E.show(),E.focus();try{const h=E.getNativeWindowHandle().toString("hex"),s=c.join(d,"Set-RushBBackdrop.ps1"),p=c.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"),w=require("child_process").spawn(p,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",s,h],{windowsHide:!0,stdio:"ignore"});g("Electron="+(process.versions.electron||"unknown")+"; applying documented DWM Desktop Acrylic; HWND="+h);w.on("error",t=>g("DWM helper spawn error: "+t.message));w.on("close",t=>g("DWM helper exited: "+t))}catch(t){g("DWM helper launch exception: "+t.stack)}})'''


BILI_ACCOUNT_STATUS = r'''function bilidownReplyAccount(sender,channel){
  const request=r.net.request({
    method:"GET",url:"https://api.bilibili.com/x/web-interface/nav",
    session:r.session.defaultSession,useSessionCookies:true,redirect:"error"
  });
  let finished=false;
  const reply=status=>{
    if(finished)return;
    finished=true;
    clearTimeout(timer);
    if(!sender.isDestroyed||!sender.isDestroyed())sender.send(channel,status);
  };
  const fail=error=>reply({ok:false,error});
  const timer=setTimeout(()=>{
    fail("B 站账号接口响应超时，请检查网络后重试。");
    request.abort();
  },10000);
  request.setHeader("User-Agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  request.setHeader("Referer","https://www.bilibili.com/");
  request.on("response",response=>{
    if(response.statusCode!==200){
      fail("B 站账号接口返回 HTTP "+response.statusCode+"，请稍后重试。");
      request.abort();
      return;
    }
    const chunks=[];
    response.on("data",chunk=>chunks.push(chunk));
    response.on("error",()=>fail("读取 B 站账号响应失败，请重试。"));
    response.on("end",()=>{
      try{
        const result=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if(result.code===-101){reply({ok:true,isLogin:false});return;}
        if(result.code!==0||typeof result.data?.isLogin!=="boolean"){
          fail("B 站账号接口暂不可用，请稍后重试。");
          return;
        }
        const data=result.data;
        reply({ok:true,isLogin:data.isLogin,uname:data.uname||"",mid:data.mid||"",vip:Number(data.vipStatus)===1});
      }catch{fail("B 站账号接口返回了无法读取的数据，请稍后重试。");}
    });
  });
  request.on("error",()=>fail("无法连接 B 站账号接口，请检查网络后重试。"));
  request.end();
}
'''


def patch_bili_account_background(background: str) -> str:
    start = background.index("function bilidownReplyAccount(sender,channel){")
    end = background.index("const bilidownCookieNames", start)
    return background[:start] + BILI_ACCOUNT_STATUS + background[end:]


def patch_bili_account_settings(html: str) -> str:
    if 'id="browser-manual-login"' in html:
        return html
    button = '<button id="open-extension-folder" class="text-button">打开扩展目录</button>'
    if html.count(button) != 1:
        raise RuntimeError("Could not find the RushB browser extension action")
    html = html.replace(
        "请先在系统默认浏览器登录 B 站并加载随程序提供的扩展；点击下方按钮后会在该浏览器打开本地导入页。",
        "在默认 Edge 或 Chrome 的当前配置中登录 B 站，并在扩展管理页加载 RushB 登录桥接。",
        1,
    )
    return html.replace(
        button,
        button + '\n            <button id="browser-manual-login" class="text-button">直接扫码登录</button>',
        1,
    )


def find_entry(tree: dict, path: str) -> dict:
    node = tree
    parts = path.split("/")
    for part in parts[:-1]:
        node = node["files"][part]
    return node["files"][parts[-1]]


def add_or_replace_entry(tree: dict, path: str, size: int, offset: int) -> None:
    node = tree
    parts = path.split("/")
    for part in parts[:-1]:
        node = node.setdefault("files", {}).setdefault(part, {"files": {}})
    node.setdefault("files", {})[parts[-1]] = {"size": size, "offset": str(offset)}


def patch_engine_background(background: str) -> str:
    if 'require("./rushb-engine.js")' in background:
        return background
    start_marker = 'async function C(e=!1){let t=c.join(__dirname,"..","bin","aria2c.conf");'
    end_marker = 'r.protocol.registerSchemesAsPrivileged('
    start = background.find(start_marker)
    end = background.find(end_marker, start)
    if start < 0 or end < 0:
        raise RuntimeError("Could not find the original aria2 startup function")
    replacement = '''const rushbEngine=require("./rushb-engine.js")({app:r.app,portfinder:d,binDirectory:c.resolve(__dirname,"..","bin"),onPort:port=>{g=port;if(E&&!E.isDestroyed())E.webContents.send("Aria2Port",port)},onChild:child=>{y=child},onUnavailable:()=>{if(E&&!E.isDestroyed())E.webContents.send("aria2-exit")}});async function C(restart=false){const ready=await rushbEngine.ensure();if(restart&&E&&!E.isDestroyed())E.webContents.send("aria2-restart-status",ready,ready?null:{error:"下载引擎启动失败，请查看 RushB 用户数据目录中的 logs/engine.log"});return ready}'''
    return background[:start] + replacement + background[end:]


DOUYIN_MAIN = r'''const rushbDouyinDownload=require("./rushb-douyin.js")({BrowserWindow:r.BrowserWindow,session:r.session,net:r.net});let rushbDouyinBusy=false;r.ipcMain.handle("rushb:douyin-download",async(event,payload)=>{if(!E||E.isDestroyed()||event.sender!==E.webContents)throw new Error("无效的下载请求来源");if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Error("无效的下载请求");const{id,url,folder}=payload;if(typeof id!=="string"||!id.trim()||id.length>128||/[\x00-\x1f\x7f]/.test(id))throw new Error("无效的下载任务编号");if(typeof url!=="string"||!url.trim()||url.length>8192||/[\x00-\x1f\x7f]/.test(url))throw new Error("无效的视频链接");if(typeof folder!=="string"||!folder.trim()||folder.length>32767||folder.includes("\0")||!c.isAbsolute(folder))throw new Error("无效的保存位置");if(rushbDouyinBusy)throw new Error("已有抖音任务正在下载，请稍后重试");rushbDouyinBusy=true;try{const result=await rushbDouyinDownload({url,folder,onUpdate:progress=>{if(!event.sender.isDestroyed())event.sender.send("rushb:douyin-progress",id,progress)}});if(!result||typeof result.title!=="string"||typeof result.path!=="string")throw new Error("下载引擎未返回完整的文件信息");return{id,title:result.title,path:result.path}}finally{rushbDouyinBusy=false}});'''


def patch_douyin_background(background: str) -> str:
    # Keep all existing entry, account, acrylic and aria2 patches intact.
    if 'r.ipcMain.handle("rushb:douyin-download"' in background:
        return background
    marker = 'r.ipcMain.on("clearCookie",'
    if marker not in background:
        raise RuntimeError("Could not find the Douyin IPC insertion point")
    return background.replace(marker, "void 0;" + DOUYIN_MAIN + marker, 1)


YOUTUBE_MAIN = r'''const rushbYouTubeDownload=require("./rushb-youtube.js")({toolsDirectory:c.resolve(__dirname,"..","bin","youtube"),ffmpegLocation:c.resolve(__dirname,"..","bin","ffmpeg.exe")});let rushbYouTubeBusy=false;r.ipcMain.handle("rushb:youtube-download",async(event,payload)=>{if(!E||E.isDestroyed()||event.sender!==E.webContents)throw new Error("无效的下载请求来源");if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Error("无效的下载请求");const{id,url,folder}=payload;if(typeof id!=="string"||!id.trim()||id.length>128||/[\x00-\x1f\x7f]/.test(id))throw new Error("无效的下载任务编号");if(typeof url!=="string"||!url.trim()||url.length>8192||/[\x00-\x1f\x7f]/.test(url))throw new Error("无效的视频链接");if(typeof folder!=="string"||!folder.trim()||folder.length>32767||folder.includes("\0")||!c.isAbsolute(folder))throw new Error("无效的保存位置");if(rushbYouTubeBusy)throw new Error("已有 YouTube 任务正在下载，请稍后重试");rushbYouTubeBusy=true;try{const result=await rushbYouTubeDownload({url,folder,onUpdate:progress=>{if(!event.sender.isDestroyed())event.sender.send("rushb:youtube-progress",id,progress)}});if(!result||typeof result.title!=="string"||typeof result.path!=="string")throw new Error("下载引擎未返回完整的文件信息");return{id,title:result.title,path:result.path}}finally{rushbYouTubeBusy=false}});'''


def patch_youtube_background(background: str) -> str:
    # Add YouTube IPC without changing existing Bilibili or Douyin handlers.
    if 'r.ipcMain.handle("rushb:youtube-download"' in background:
        return background
    marker = 'r.ipcMain.on("clearCookie",'
    if marker not in background:
        raise RuntimeError("Could not find the YouTube IPC insertion point")
    # The original IPC handlers can be joined by commas; end that expression.
    return background.replace(marker, "void 0;" + YOUTUBE_MAIN + marker, 1)


def patch_package_publisher(raw: bytes) -> bytes:
    package = json.loads(raw)
    upstream_author = package.get("author")
    if upstream_author and upstream_author != PUBLISHER_ID:
        contributors = package.setdefault("contributors", [])
        if upstream_author not in contributors:
            contributors.append(upstream_author)
    package["author"] = PUBLISHER_ID
    package["publisher"] = PUBLISHER_ID
    package["name"] = "rushb"
    package["productName"] = "RushB"
    return (json.dumps(package, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def patch_windows_app_id(background: str) -> str:
    # Set the taskbar identity before the main window is created.
    setting = f'if(process.platform==="win32")r.app.setAppUserModelId({json.dumps(WINDOWS_APP_ID)});'
    if setting in background:
        return background
    anchor = 'const m=r.app.requestSingleInstanceLock();'
    if background.count(anchor) != 1:
        raise RuntimeError("Could not find the RushB shell identity insertion point")
    return background.replace(anchor, setting + anchor, 1)


def patch_publisher_label(html: str) -> str:
    label = f'发布者 <strong>{PUBLISHER_ID}</strong>'
    if label in html:
        return html
    pattern = r'(<p class="about-lead">非官方个人改版)(?=\s|<)'
    result, count = re.subn(pattern, rf'\1 <span>·</span> {label}', html, count=1)
    if count != 1:
        raise RuntimeError("Could not find the RushB software statement author label")
    return result


COMPONENTS_MAIN = '''const rushbComponents = require("./rushb-components-bridge.js")({
  ipcMain: r.ipcMain,
  net: r.net,
  binDirectory: c.resolve(__dirname, "..", "bin"),
  getMainWindow: () => E,
  getAria2: () => y && !y.killed && y.exitCode === null ? {port: g} : null,
  isYouTubeBusy: () => rushbYouTubeBusy
});'''


def patch_components_background(background: str) -> str:
    if 'require("./rushb-components-bridge.js")' in background:
        return background
    ipc_marker = 'r.ipcMain.on("clearCookie",'
    youtube_marker = 'if(rushbYouTubeBusy)throw new Error('
    if ipc_marker not in background or youtube_marker not in background:
        raise RuntimeError("Could not find the download component hooks")
    guard = 'if(rushbComponents.isUpdating())throw new Error("下载组件正在更新，请稍后重试。");'
    background = background.replace(youtube_marker, guard + youtube_marker, 1)
    return background.replace(ipc_marker, "void 0;" + COMPONENTS_MAIN + ipc_marker, 1)


def patch_components_settings(html: str) -> str:
    if 'id="components-settings"' in html:
        return html
    settings = re.search(r'<main id="settings-view"(?:\s[^>]*)?>.*?(?=</main>)', html, re.DOTALL)
    if not settings or html.count("</head>") != 1:
        raise RuntimeError("Could not find the RushB settings layout")
    section = (PROJECT_ROOT / "src" / "components-section.html").read_text(encoding="utf-8")
    insert = settings.end()
    html = html[:insert].rstrip() + "\n" + section.rstrip() + "\n    " + html[insert:]
    assets = ('  <link href="./assets/css/rushb-components-ui.css" rel="stylesheet">\n'
              '  <script defer src="./assets/js/rushb-components-ui.js"></script>\n')
    return html.replace("</head>", assets + "</head>", 1)


def component_resources() -> dict[str, bytes]:
    return {name: (PROJECT_ROOT / "src" / source).read_bytes() for name, source in COMPONENT_RESOURCES.items()}


def patch_favicon(html: str) -> str:
    if 'id="rushb-favicon"' in html:
        return html
    if html.count("</head>") != 1:
        raise RuntimeError("Could not find the RushB page header")
    return html.replace("</head>", '  <link id="rushb-favicon" rel="icon" href="./logo.ico">\n</head>', 1)


def patch_legacy_logo(raw: bytes) -> bytes:
    """Keep the supplied renderer while replacing the upstream app logo in its store."""
    text = raw.decode("utf-8")
    location = re.search(r'logo:Object\.freeze\(([A-Za-z_$][\w$]*)\)', text)
    if not location:
        raise RuntimeError("Could not find the original app logo declaration")
    variable = re.escape(location.group(1))
    expression = rf'(?<![\w$])({variable}=")data:image/(?:png|webp);base64,[A-Za-z0-9+/=]+(?=")'
    payload = base64.b64encode(APP_LOGO_PNG.read_bytes()).decode("ascii")
    result, count = re.subn(expression, lambda match: match.group(1) + "data:image/png;base64," + payload, text)
    if count != 1:
        raise RuntimeError("Could not identify exactly one original app logo")
    return result.encode("utf-8")


def patch_asar() -> None:
    archive = ASAR.read_bytes()
    json_size = struct.unpack_from("<I", archive, 12)[0]
    tree = json.loads(archive[16 : 16 + json_size])
    body_start = (16 + json_size + 3) & ~3
    original_body = archive[body_start:]

    background = original_body[
        int(find_entry(tree, "background.js")["offset"])
        : int(find_entry(tree, "background.js")["offset"])
        + int(find_entry(tree, "background.js")["size"])
    ].decode("utf-8")
    lock_marker = 'd=n(148),m=r.app.requestSingleInstanceLock();'
    if lock_marker not in background:
        raise RuntimeError("Could not find the single-instance profile hook")
    background = background.replace(
        lock_marker,
        'd=n(148);r.app.setPath("userData",c.join(r.app.getPath("appData"),"RushB"));const m=r.app.requestSingleInstanceLock();',
        1,
    )
    protocol_call = 'r.app.setAsDefaultProtocolClient("bilidown",process.execPath,t);'
    if protocol_call in background:
        background = background.replace(protocol_call, "void 0;", 1)
    background = background.replace('r.app.setName("Bilidown")', 'r.app.setName("RushB")', 1)
    background = patch_windows_app_id(background)
    background = background.replace('v.setToolTip("Bilidown")', 'v.setToolTip("RushB（B站视频下载器）")', 1)
    window_marker = 'center:!0,frame:!1,icon:c.join(__dirname,"logo.ico")'
    if window_marker not in background:
        raise RuntimeError("Could not find the RushB window options")
    background = background.replace(
        window_marker,
        'center:!0,frame:!1,transparent:!0,backgroundColor:"#00000000",icon:c.join(__dirname,"logo.ico")',
        1,
    )
    ready_marker = 'E.once("ready-to-show",()=>{E.show(),E.focus()})'
    if ready_marker not in background:
        raise RuntimeError("Could not find the RushB window ready handler")
    background = background.replace(
        ready_marker,
        BACKDROP_READY,
        1,
    )
    load_url_marker = 'await E.loadURL(\"app://./index.html\")'
    if load_url_marker not in background:
        raise RuntimeError("Could not find the app entry URL")
    background = background.replace(load_url_marker, 'await E.loadURL(\"app://./index-dialog-fix.html\")', 1)
    ipc_marker = 'r.ipcMain.on("clearCookie",'
    if ipc_marker not in background:
        raise RuntimeError("Could not find the RushB IPC insertion point")
    background = background.replace(ipc_marker, "void 0;" + BRIDGE_MAIN + ipc_marker, 1)
    background = patch_bili_account_background(background)
    background = patch_components_background(patch_youtube_background(patch_douyin_background(patch_engine_background(background))))
    appended = bytearray()

    def append_file(path: str, data: bytes) -> None:
        offset = len(original_body) + len(appended)
        add_or_replace_entry(tree, path, len(data), offset)
        appended.extend(data)

    package = find_entry(tree, "package.json")
    package_start = int(package["offset"])
    append_file("package.json", patch_package_publisher(original_body[package_start:package_start + package["size"]]))
    append_file("index-dialog-fix.html", patch_favicon(patch_components_settings(patch_publisher_label(INDEX_HTML))).encode("utf-8"))
    original_renderer = find_entry(tree, LEGACY_RENDERER)
    renderer_start = int(original_renderer["offset"])
    append_file(LEGACY_RENDERER, patch_legacy_logo(original_body[renderer_start:renderer_start + original_renderer["size"]]))
    append_file("logo.ico", APP_ICON.read_bytes())
    append_file("background.js", background.encode("utf-8"))
    append_file("rushb-engine.js", ENGINE_SOURCE.read_bytes())
    append_file("rushb-douyin.js", DOUYIN_SOURCE.read_bytes())
    append_file("rushb-youtube.js", YOUTUBE_SOURCE.read_bytes())
    append_file("rushb-links.js", LINKS_SOURCE.read_bytes())
    append_file("assets/js/rushb-ui-dialog-fix.js", JS_SOURCE.read_bytes())
    append_file("assets/css/rushb-ui-dialog-fix.css", CSS_SOURCE.read_bytes())
    for name, data in component_resources().items():
        append_file(name, data)

    header = json.dumps(tree, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header_size = len(header)
    padded_header_size = (header_size + 3) & ~3
    inner_pickle_size = padded_header_size + 4
    outer_header_size = inner_pickle_size + 4
    pickle_header = struct.pack("<IIII", 4, outer_header_size, inner_pickle_size, header_size)
    header_padding = b"\0" * (padded_header_size - header_size)
    packed = pickle_header + header + header_padding + original_body + appended
    destination = OUTPUT / "resources" / "app.asar"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(packed)


def copy_runtime() -> None:
    if (OUTPUT / "RushB.exe").exists():
        return
    if OUTPUT.exists() and any(OUTPUT.iterdir()):
        raise FileExistsError(f"Output folder already contains files: {OUTPUT}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    skip = {
        "Bilidown Setup 1.2.7.exe",
        "Uninstall Bilidown.exe",
        "uninstallerIcon.ico",
    }
    for source_file in SOURCE.iterdir():
        if source_file.name in skip or source_file.name == "resources":
            continue
        target = OUTPUT / source_file.name
        if source_file.is_dir():
            shutil.copytree(source_file, target)
        else:
            shutil.copy2(source_file, target)
    shutil.copytree(SOURCE / "resources", OUTPUT / "resources")
    (OUTPUT / "Bilidown.exe").rename(OUTPUT / "RushB.exe")


def copy_youtube_tools() -> None:
    # Optional, fully offline input. An unset variable leaves installed tools alone.
    if not YOUTUBE_TOOLS:
        return
    source = Path(YOUTUBE_TOOLS).expanduser().resolve()
    required = [source / "yt-dlp.exe", source / "deno.exe"]
    missing = [tool.name for tool in required if not tool.is_file()]
    if missing:
        raise RuntimeError("RUSHB_YOUTUBE_TOOLS is missing: " + ", ".join(missing))
    notices = [
        file for file in source.iterdir()
        if file.is_file() and file.name.upper().startswith(
            ("LICENSE", "LICENCE", "NOTICE", "THIRD_PARTY", "THIRD-PARTY", "COPYING")
        )
    ]
    destination = OUTPUT / "resources" / "bin" / "youtube"
    destination.mkdir(parents=True, exist_ok=True)
    for file in required + notices:
        target = destination / file.name
        if file.resolve() != target.resolve():
            shutil.copy2(file, target)


def write_readme() -> None:
    readme = """# RushB（B站视频下载器）

RushB 提供批量链接下载、系列视频选择、最高可用音视频画质自动选择、账号登录管理，以及下载任务与记录管理。
支持 B 站、抖音和 YouTube；YouTube 本地工具放在 `resources/bin/youtube/`（`yt-dlp.exe`、`deno.exe`），构建时可通过 `RUSHB_YOUTUBE_TOOLS` 指定已有工具目录，未指定时保留现有工具，也可稍后手动放入。

## 使用

1. 双击 `启动RushB.bat`。RushB 使用独立的 %APPDATA%\RushB 用户数据目录，与 Bilidown 登录状态和设置分开保存。
2. 每行粘贴一个 B 站 BV 号、av 号或视频页链接。普通多 P 视频默认下载全部分 P；合集 / 系列会先弹出集数选择窗口，默认只勾选当前集，可多选或全选。带 `?p=` 的链接默认定位到指定集。
3. 点击“一键下载”，所选任务会交给内置 aria2 和 ffmpeg 处理；弹窗中的“跳过此链接”可略过当前系列链接。
4. 点击标题栏的小圆图标，可查看下载中、等待中、暂停任务的进度和速度、切换已下载记录、清理下载记录，并在面板顶部打开保存位置；清理记录不会删除本地视频文件。
5. 右上角“设置”可查看账号状态、设置保存目录与最高可用画质 / 音质，并选择浏览器导入或 B 站扫码登录。
6. 在“设置 → 软件声明”中查看项目来源、内容使用规范、登录数据处理方式和免责声明。
7. 在设置底部的“下载组件”查看已装版本，检查并更新 yt-dlp、Deno 和 FFmpeg。aria2 由 RushB 安装包提供。

## 浏览器登录

首次导入时，在系统默认浏览器登录 B 站，打开 `edge://extensions/` 或 `chrome://extensions/`，开启“开发人员模式”并加载 `RushB浏览器登录桥接` 文件夹。然后回到 RushB 设置，点击“从浏览器获取登录状态”。扩展只读取 B 站域名下的登录相关 Cookie，通过本机随机一次性令牌传入 RushB。也可在设置里选择“自行登录”并扫码。

## 构建

需要本机已安装 Bilidown 1.2.7。设置环境变量 `BILIDOWN_DIR` 指向其安装目录，然后运行：

```powershell
python build_rushb.py
```

默认产物写入 `dist/`；可通过 `RUSHB_OUTPUT` 指定输出目录。构建过程会复制本机 Bilidown 运行时并替换界面资源。

## 来源说明

RushB 的发布者 ID 为 **Harry张**。

RushB 基于 B 站 UP 主 **@王子周棋洛** 的 Bilidown 魔改，原项目已停止维护，现由 **@Harry张** 进行优化更新。
原项目的公开源码状态及许可证范围尚未核实；本说明不代表原作者背书或对原项目代码授予额外许可。

## 源码

- `src/rushb_ui.js`、`src/rushb_ui.css`：RushB 界面与批量下载逻辑
- `browser-extension/`：Edge / Chrome 浏览器登录桥接扩展
- `launcher/`：Windows 启动器和调用 DWM Desktop Acrylic、标题栏颜色与窗口圆角的脚本
- `build_rushb.py`：从本机 Bilidown 安装构建 RushB

该源码仓库不包含 Bilidown 原始安装包或编译后的 Electron 运行时。
"""
    (OUTPUT / "使用说明.md").write_text(readme, encoding="utf-8")


def main() -> None:
    if SOURCE is None:
        raise SystemExit("Set BILIDOWN_DIR to the Bilidown 1.2.7 installation folder before building.")
    if not ASAR.is_file():
        raise SystemExit(f"Could not find Bilidown app.asar: {ASAR}")
    from patch_rushb_exe import patch_publisher
    from patch_rushb_icon import patch_icon

    copy_runtime()
    patch_publisher(OUTPUT / "RushB.exe", PUBLISHER_ID)
    patch_icon(OUTPUT / "RushB.exe", APP_ICON)
    copy_youtube_tools()
    patch_asar()
    shutil.copy2(APP_ICON, OUTPUT / "resources" / "rushb-lightning.ico")
    write_readme()
    shutil.copy2(JS_SOURCE, OUTPUT / "rushb-ui.js")
    shutil.copy2(CSS_SOURCE, OUTPUT / "rushb-ui.css")
    shutil.copy2(LAUNCHER_SOURCE / "Start-RushB.bat", OUTPUT / "启动RushB.bat")
    shutil.copy2(LAUNCHER_SOURCE / "Start-RushB.ps1", OUTPUT / "启动RushB.ps1")
    shutil.copy2(BACKDROP_SOURCE, OUTPUT / "Set-RushBBackdrop.ps1")
    target_extension = OUTPUT / "RushB浏览器登录桥接"
    if target_extension.exists():
        shutil.rmtree(target_extension)
    shutil.copytree(EXTENSION_SOURCE, target_extension)
    print(OUTPUT)


if __name__ == "__main__":
    main()
