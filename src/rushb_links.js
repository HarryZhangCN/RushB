"use strict";

const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com"]);
const BILIBILI_SHORT_HOSTS = new Set(["b23.tv", "www.b23.tv"]);
const DOUYIN_HOSTS = new Set(["douyin.com", "www.douyin.com"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^(bv[a-z0-9]{10}|av\d+)(?:\?p=(\d+))?$/i;
const BILIBILI_VIDEO_PATH = /^\/video\/(bv[a-z0-9]{10}|av\d+)\/?$/i;
const DOUYIN_VIDEO_PATH = /^\/video\/(\d+)\/?$/;
const DOUYIN_SHORT_PATH = /^\/([a-z0-9_-]+)\/?$/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_VIDEO_PATH = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/;
const YOUTUBE_SHORT_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;
const TRAILING_PUNCTUATION = /[.,;:!?\])}'”’。，、；：！？）】》〉」』…]+$/u;
const CANDIDATE = /[a-z][a-z\d+.-]*:\/\/[^\s<>"'`()，。；！？、【】（）《》〈〉「」『』“”‘’,;]*|(?<![a-z\d_/@?=#%])(?:bv[a-z\d]{10}|av\d+)(?:\?p=\d+)?(?![a-z\d_/?=#%])/gi;

function unescapeScheme(value) {
  return value.replace(/\b(https?)\\?:\\?\/\\?\//gi, "$1://");
}

function canonicalVideoId(id) {
  const prefix = /^bv/i.test(id) ? "BV" : "av";
  return prefix + id.slice(2);
}

function bilibiliPage(page) {
  if (!page || !/^\d+$/.test(page)) return "";
  const normalized = page.replace(/^0+/, "");
  return normalized ? `?p=${normalized}` : "";
}

function youtubeVideoId(hostname, pathname, searchParams) {
  if (hostname === "youtu.be") return YOUTUBE_SHORT_PATH.exec(pathname)?.[1] || null;
  if (!YOUTUBE_HOSTS.has(hostname)) return null;
  if (pathname === "/watch" || pathname === "/watch/") {
    const ids = searchParams.getAll("v");
    return ids.length === 1 && YOUTUBE_ID.test(ids[0]) ? ids[0] : null;
  }
  return YOUTUBE_VIDEO_PATH.exec(pathname)?.[1] || null;
}

function classifyLink(value) {
  const input = unescapeScheme(String(value ?? "").trim()).replace(TRAILING_PUNCTUATION, "");
  const videoId = VIDEO_ID.exec(input);
  if (videoId) {
    const id = canonicalVideoId(videoId[1]);
    const page = bilibiliPage(videoId[2]);
    return { platform: "bilibili", url: page ? `https://www.bilibili.com/video/${id}/${page}` : id };
  }

  if (!/^https?:\/\//i.test(input) || input.includes("\\")) return null;
  let parsed;
  try {
    parsed = new URL(input);
  } catch (_) {
    return null;
  }
  if (parsed.username || parsed.password || parsed.port) return null;

  const { hostname, pathname, searchParams } = parsed;
  if (BILIBILI_HOSTS.has(hostname)) {
    const video = BILIBILI_VIDEO_PATH.exec(pathname);
    const path = video ? `/video/${canonicalVideoId(video[1])}/` : pathname;
    return { platform: "bilibili", url: `https://www.bilibili.com${path}${bilibiliPage(searchParams.get("p"))}` };
  }
  if (BILIBILI_SHORT_HOSTS.has(hostname) && pathname !== "/") {
    return { platform: "bilibili", url: `https://b23.tv${pathname.replace(/\/+$/, "")}${bilibiliPage(searchParams.get("p"))}` };
  }
  if (hostname === "v.douyin.com") {
    const short = DOUYIN_SHORT_PATH.exec(pathname);
    return short ? { platform: "douyin", url: `https://v.douyin.com/${short[1]}/` } : null;
  }
  if (DOUYIN_HOSTS.has(hostname)) {
    const video = DOUYIN_VIDEO_PATH.exec(pathname);
    return video ? { platform: "douyin", url: `https://www.douyin.com/video/${video[1]}` } : null;
  }
  const youtube = youtubeVideoId(hostname, pathname, searchParams);
  if (youtube) return { platform: "youtube", url: `https://www.youtube.com/watch?v=${youtube}` };
  return null;
}

function linkKey(link) {
  if (link.platform !== "bilibili") return link.url;
  const id = VIDEO_ID.exec(link.url);
  return id ? `https://www.bilibili.com/video/${id[1]}/` : link.url;
}

function parseLinks(text) {
  const links = [];
  const seen = new Set();
  let unsupported = 0;
  for (const match of unescapeScheme(String(text ?? "")).matchAll(CANDIDATE)) {
    const link = classifyLink(match[0]);
    if (!link) {
      if (match[0].includes("://")) unsupported += 1;
      continue;
    }
    const key = linkKey(link);
    if (!seen.has(key)) {
      seen.add(key);
      links.push(link);
    }
  }
  return { links, unsupported };
}

module.exports = { parseLinks, classifyLink };
