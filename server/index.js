/**
 * TownSquare 自建后端
 * ---------------------------------------------------------------
 * 为 limpy01/townsquare 前端实现官方私有后端 (api.botcgrimoire.top + ws.botcgrimoire.top) 的等价服务。
 *
 * 组成：
 *   1) HTTP API
 *        - GET  /dynamic/init       动态配置 (version / floatingNotice)
 *        - POST /upload/avatar      头像上传 (base64 -> 存盘 -> 返回 url)
 *        - GET  /avatars/<file>     头像静态资源
 *        - GET  /healthz            健康检查
 *   2) WebSocket 两个命名空间 (同端口，按路径前缀区分)
 *        - /ws/<channel>/<playerId>[/host]?auth=<browserSecret>   游戏房间中转
 *        - /lobby/<playerId>                                 大厅房间列表
 *   3) 静态托管：构建后的前端 dist/ (可选，存在才托管)
 *
 * 协议要点（与前端 src/store/socket.js 对齐）：
 *   - 所有帧是 JSON 数组 [command, params, feedback?]
 *   - 房间内两种角色：host=说书人（权威，带 ?auth=stSecret 鉴权）、其余为玩家/观众
 *   - "direct" 帧： { <targetPlayerId|"host">: [command, params] } —— 服务端按 key 拆包投递
 *   - "request" 帧： { <command>: [playerId, params] } —— 目前用于 checkAllowHost / checkAllowJoin / deleteMessage
 *   - "uploadFile" 帧： { <command>: [playerId, params] } —— 头像走这里时把图片存盘并回 "avatarReceived"
 *   - quickWake*：独立定向唤醒协议，禁止经 direct/普通广播注入
 *   - 玩家连接也携带浏览器 secret；稳定 ID 首次加入后绑定该凭证，重连必须匹配
 *   - ping / pong / bye 玩家计数与延迟
 *
 * 设计原则：本服务是**无状态中继 + 轻量状态协调**，不做游戏逻辑（游戏状态全部在前端 host）。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server || WebSocket.WebSocketServer;

// ------------------------------------------------------------------ 配置
const PORT = parseInt(process.env.PORT || "3000", 10);
const WS_HEARTBEAT_MS = 30 * 1000; // 30s 心跳
const RATE_LIMIT_PER_SEC = parseInt(process.env.RATE_LIMIT || "30", 10);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // base64 解码后上限 2MB
const CHANNEL_MIN = 1;
const CHANNEL_MAX = 10000;

const ROOT = path.resolve(__dirname, "..");
const AVATAR_DIR = process.env.AVATAR_DIR || path.join(ROOT, "server", "avatars");
const DIST_DIR = path.join(ROOT, "dist");

if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// ------------------------------------------------------------------ 内存状态
/**
 * rooms[channel] = {
 *   host: { ws, playerId, auth, connectedAt } | null,
 *   players: Map<playerId, { ws, ping, connectedAt }>,
 *   createdAt,
 *   everHadHost,
 *   meta: {                      // 大厅展示用的房间元数据（说书人上报）
 *     name: "房间名",            // 为空则前端用房间号兜底
 *     stName: "说书人昵称",
 *     edition: "tb",            // 剧本 id
 *     maxPlayers: 12,           // 最大人数（建房时填的玩家人数）
 *     playerCount: 12,          // 座位数（= maxPlayers）
 *   },
 * }
 * 重启即失——与前端"本地 + 说书人为权威"的模型一致；如需持久化可外挂 SQLite。
 */
const rooms = new Map();
/** lobbyClients: Set<{ ws, playerId, roomsSnapshot }> */
const lobbyClients = new Set();

// 房间宽限期（毫秒）：说书人断开后，房间保留这么久等待重连，避免瞬间消失。
const ROOM_GRACE_MS = parseInt(process.env.ROOM_GRACE_MS || "60000", 10);
/** roomCleanupTimers: Map<channel, timeoutId> */
const roomCleanupTimers = new Map();

function scheduleRoomCleanup(channel) {
  const existing = roomCleanupTimers.get(channel);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    roomCleanupTimers.delete(channel);
    const room = rooms.get(channel);
    if (room && !room.host && room.players.size === 0) {
      rooms.delete(channel);
      notifyLobbyRemove(channel);
      log("room closed", channel);
    }
  }, ROOM_GRACE_MS);
  if (t.unref) t.unref();
  roomCleanupTimers.set(channel, t);
}

function cancelRoomCleanup(channel) {
  const existing = roomCleanupTimers.get(channel);
  if (existing) {
    clearTimeout(existing);
    roomCleanupTimers.delete(channel);
  }
}

/**
 * 立即解散房间：踢出所有玩家并通知，删除房间对象，广播大厅移除。
 * 用于说书人主动"解散房间"（与宽限期回收不同，不需要等待重连）。
 */
function dissolveRoom(channel) {
  const room = rooms.get(channel);
  if (!room) return;
  cancelRoomCleanup(channel);
  // 通知所有玩家：用 1000(正常关闭) + reason 关闭。
  // 客户端 onclose 里 code!==1000 会被当作“网络中断”并在 3 秒后自动重连，
  // 若用 4005 之类非 1000 的码，玩家会重连进一个已不存在的幽灵房间、且看不到提示。
  // code=1000 才会走客户端的“正常离开”分支：清理状态、回到首页，并弹出 err.reason。
  room.players.forEach((p) => {
    try {
      p.ws.close(1000, "房间已被说书人解散。");
    } catch {}
  });
  // 说书人自己：同样用 1000 关闭（reason 留空，避免重现“房间已被解散”的弹窗给自己）。
  if (room.host) {
    try {
      room.host.ws.close(1000);
    } catch {}
  }
  rooms.delete(channel);
  roomCleanupTimers.delete(channel);
  notifyLobbyRemove(channel);
  log("room dissolved", channel);
}

// ------------------------------------------------------------------ 工具
const log = (...a) => console.log("[ts]", new Date().toISOString(), ...a);

/** 把 [command, params, feedback] 序列化成帧 */
function frame(command, params, feedback) {
  return JSON.stringify(feedback === undefined ? [command, params] : [command, params, feedback]);
}

/** 安全发送 */
function send(ws, command, params, feedback) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    try {
      ws.send(frame(command, params, feedback));
    } catch (e) {
      log("send error", e.message);
    }
  }
}

/** 给房间内所有人（除 except 外）广播 */
function broadcastRoom(room, command, params, except = null) {
  const data = frame(command, params);
  if (room.host && room.host.ws !== except) trySafeSend(room.host.ws, data);
  room.players.forEach((p) => {
    if (p.ws !== except) trySafeSend(p.ws, data);
  });
}

const QUICK_WAKE_COMMANDS = new Set([
  "quickWakeSend",
  "quickWakeReply",
  "quickWakeReceipt",
  "quickWakeSyncRequest",
]);

function isQuickWakeCommand(command) {
  return QUICK_WAKE_COMMANDS.has(command) ||
    (typeof command === "string" && command.startsWith("quickWake"));
}

function ensureQuickWakeState(room) {
  if (!room.quickWake) {
    room.quickWake = {
      records: new Map(),
      order: [],
    };
  }
  return room.quickWake;
}

function quickWakeStatus(record) {
  if (record.reply) return "replied";
  if (record.deliveredAt) return "delivered";
  return "accepted";
}

function publicQuickWake(record) {
  return {
    id: record.id,
    roomId: record.roomId,
    senderPlayerId: record.senderPlayerId,
    senderName: record.senderName,
    targetPlayerId: record.targetPlayerId,
    targetSeat: record.targetSeat,
    targetName: record.targetName,
    phase: record.phase,
    content: record.content,
    createdAt: record.createdAt,
    deliveredAt: record.deliveredAt || null,
    repliedAt: record.repliedAt || null,
    reply: record.reply || null,
    status: quickWakeStatus(record),
  };
}

function sendQuickWakeError(ws, id, code, message) {
  send(ws, "quickWakeError", {
    id: id || "",
    code,
    message,
  });
}

function storeQuickWakeRecord(room, record) {
  const state = ensureQuickWakeState(room);
  state.records.set(record.id, record);
  if (!state.order.includes(record.id)) state.order.push(record.id);
  // 已回复记录可以回收，未回复记录不可淘汰，否则刷新后的玩家将无法回复。
  while (state.order.length > 500) {
    const index = state.order.findIndex(id => state.records.get(id).reply);
    if (index < 0) break;
    const [oldId] = state.order.splice(index, 1);
    state.records.delete(oldId);
  }
}

function sendPendingQuickWakes(ws, room, playerId) {
  const state = ensureQuickWakeState(room);
  state.order.forEach(id => {
    const record = state.records.get(id);
    if (!record || record.targetPlayerId !== playerId || record.reply) return;
    record.targetWs = ws;
    send(ws, "quickWakeIncoming", publicQuickWake(record));
  });
}

function sendQuickWakeSnapshot(ws, room) {
  const state = ensureQuickWakeState(room);
  const messages = state.order
    .map(id => state.records.get(id))
    .filter(record => record && record.senderPlayerId === ws._room.playerId)
    .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
    .map(publicQuickWake);
  send(ws, "quickWakeSync", messages);
}

function notifyQuickWakePresence(room) {
  // 仅把「连接仍然存活」的玩家算作在线，避免半开/已断未清理的连接残留在
  // players 里导致对面看到幽灵在线；同时确保 presence 反映真实的当前在线集合。
  // 注意：must filter by ws.readyState === 1 (OPEN)，否则 reconnecting 的玩家会短暂
  // 出现在列表里，使 host 误发到已断开的连接。
  const presence = {
    hostOnline: !!(room.host && room.host.ws && room.host.ws.readyState === 1),
    playerIds: Array.from(room.players.entries())
      .filter(([, p]) => p && p.ws && p.ws.readyState === 1)
      .map(([id]) => id),
  };
  if (room.host) send(room.host.ws, "quickWakePresence", presence);
  room.players.forEach(player => send(player.ws, "quickWakePresence", presence));
}

function trySafeSend(ws, data) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(data);
    } catch (e) {
      log("broadcast error", e.message);
    }
  }
}

function parseChannel(pathname) {
  // pathname 形如 /ws/3/abc.html 或 /ws/3/abc/host
  const parts = pathname.split("/").filter(Boolean); // ["ws","3","abc","host"]
  return { ns: parts[0], channel: parts[1], playerId: parts[2], isHost: parts[3] === "host" };
}

function validChannel(ch) {
  const n = Number(ch);
  return Number.isInteger(n) && n >= CHANNEL_MIN && n <= CHANNEL_MAX;
}

/** 房间人数（玩家 + 说书人，用于 lobby 展示） */
function roomPlayerCount(room) {
  let n = room.players.size;
  if (room.host) n += 1;
  return n;
}

// ------------------------------------------------------------------ 大厅广播
/** 房间在"大厅"里是否可见：必须有过说书人，且不在宽限期清理流程里 */
function roomVisible(room) {
  return !!(room && room.everHadHost);
}

/** 生成一个房间的大厅展示项（供 setRooms / addRoom 下发） */
function roomLobbyItem(channel, room) {
  const m = room.meta || {};
  return {
    channel: String(channel),
    players: roomPlayerCount(room),
    name: m.name || "",
    stName: m.stName || "",
    edition: m.edition || "tb",
    editionName: m.editionName || "",
    editionLogo: m.editionLogo || "",
    maxPlayers: m.maxPlayers || room.playerCount || 0,
  };
}

function lobbySnapshot() {
  const list = [];
  rooms.forEach((room, channel) => {
    if (!roomVisible(room)) return;
    list.push(roomLobbyItem(channel, room));
  });
  return list;
}

function notifyLobbyAdd(channel) {
  const room = rooms.get(channel);
  if (!room) return;
  const data = frame("addRoom", roomLobbyItem(channel, room));
  lobbyClients.forEach((c) => trySafeSend(c.ws, data));
}
/** 房间元数据（名字/剧本/人数等）变化时，向大厅广播最新该房间信息 */
function notifyLobbyUpdate(channel) {
  const room = rooms.get(channel);
  if (!room || !roomVisible(room)) return;
  const data = frame("updateRoom", roomLobbyItem(channel, room));
  lobbyClients.forEach((c) => trySafeSend(c.ws, data));
}
function notifyLobbyRemove(channel) {
  const data = frame("removeRoom", String(channel));
  lobbyClients.forEach((c) => trySafeSend(c.ws, data));
}

// ------------------------------------------------------------------ HTTP 服务
const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" })); // 头像 base64 可能较大

// 动态配置
// 版本号统一读 package.json，避免前后端版本号不一致导致「并非最新版本」误报。
let APP_VERSION = "0.0.0";
try {
  APP_VERSION = require(path.join(__dirname, "..", "package.json")).version || APP_VERSION;
} catch (e) {
  APP_VERSION = process.env.APP_VERSION || "0.0.0";
}

app.get("/dynamic/init", (req, res) => {
  res.json({
    status: "success",
    payload: {
      version: APP_VERSION,
      floatingNotice: process.env.FLOATING_NOTICE || "",
    },
  });
});

// 旧注释里曾用 /api/init，一并兼容
app.get("/api/init", (req, res) => {
  res.json({
    status: "success",
    payload: { version: APP_VERSION, floatingNotice: process.env.FLOATING_NOTICE || "" },
  });
});

// 头像上传
app.post("/upload/avatar", (req, res) => {
  try {
    const { playerId, uploadContent } = req.body || {};
    if (!playerId || typeof playerId !== "string") {
      return res.status(400).json({ status: "error", message: "missing playerId" });
    }
    if (!uploadContent || typeof uploadContent !== "string" || !uploadContent.startsWith("data:image/")) {
      return res.status(400).json({ status: "error", message: "invalid uploadContent" });
    }
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(uploadContent);
    if (!m) return res.status(400).json({ status: "error", message: "not base64 image" });
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({ status: "error", message: "image too large" });
    }
    // 文件名使用 playerId（前端 _avatarReceived 会以 link.split('.')[0] 与 playerId 比对）
    const safeId = playerId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "anon";
    const fileName = `${safeId}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, fileName), buf);
    // 带上版本参数，避免浏览器继续用旧头像缓存（同一玩家重复上传会覆盖同名文件）
    const avatarUrl = `/avatars/${fileName}?v=${Date.now()}`;
    log("avatar saved", fileName, buf.length, "bytes");
    return res.json({ status: "success", avatarUrl });
  } catch (e) {
    log("upload/avatar error", e.stack || e.message);
    return res.status(500).json({ status: "error", message: "server error" });
  }
});

// 剧本图代理下载
// 7uuu.me 的剧本图没有 CORS 头，浏览器里 fetch 拿不到 blob，无法触发「另存为」。
// 这里做一个受限的反向代理：只允许剧本图所在域名，避免变成任意 URL 代理。
const IMAGE_PROXY_HOSTS = [
  "7uuu.me",
  "www.7uuu.me",
  // 剧本 JSON 里 _meta.logo 可能指向的图床
  "patchwiki.biligame.com",
  "i.postimg.cc",
  "i0.hdslb.com",
  // 鱼皮剧本库（ran.dogyupi.com）的剧本 logo 图床
  "youke1.picui.cn",
  "pic.code-nav.cn",
];
// 按源站给出合适的 Referer，绕开图床的防盗链
const IMAGE_PROXY_REFERER = {
  "7uuu.me": "https://7uuu.me/script_lib/",
  "www.7uuu.me": "https://7uuu.me/script_lib/",
  "patchwiki.biligame.com": "https://wiki.biligame.com/jbzlbwgwjcygf/",
  "i.postimg.cc": "https://7uuu.me/",
  "i0.hdslb.com": "https://www.bilibili.com/",
  "youke1.picui.cn": "https://ran.dogyupi.com/",
  "pic.code-nav.cn": "https://ran.dogyupi.com/",
};
const IMAGE_PROXY_MAX_BYTES = 20 * 1024 * 1024;
// 内存缓存：列表缩略图一次会请求几十张，缓存后翻页/重开弹窗就不再打上游
const IMAGE_PROXY_CACHE_TTL = 24 * 60 * 60 * 1000;
const IMAGE_PROXY_CACHE_MAX = 400;
const imageProxyCache = new Map(); // url -> { buf, type, at }

app.get("/api/fetch-image", async (req, res) => {
  try {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    let target;
    try {
      target = new URL(raw);
    } catch (e) {
      return res.status(400).json({ status: "error", message: "invalid url" });
    }
    if (target.protocol !== "https:" || !IMAGE_PROXY_HOSTS.includes(target.hostname)) {
      return res.status(403).json({ status: "error", message: "host not allowed" });
    }
    const cacheKey = target.href;
    const cached = imageProxyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < IMAGE_PROXY_CACHE_TTL) {
      res.setHeader("Content-Type", cached.type);
      res.setHeader("Content-Length", String(cached.buf.length));
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Cache", "HIT");
      return res.end(cached.buf);
    }
    const upstream = await fetch(target.href, {
      headers: {
        referer: IMAGE_PROXY_REFERER[target.hostname] || "https://7uuu.me/script_lib/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!upstream.ok) {
      return res.status(502).json({ status: "error", message: `upstream ${upstream.status}` });
    }
    const type = upstream.headers.get("content-type") || "application/octet-stream";
    if (!/^image\//i.test(type)) {
      return res.status(415).json({ status: "error", message: "not an image" });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > IMAGE_PROXY_MAX_BYTES) {
      return res.status(413).json({ status: "error", message: "image too large" });
    }
    if (imageProxyCache.size >= IMAGE_PROXY_CACHE_MAX) {
      const oldest = imageProxyCache.keys().next().value;
      if (oldest !== undefined) imageProxyCache.delete(oldest);
    }
    imageProxyCache.set(cacheKey, { buf, type, at: Date.now() });
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Cache", "MISS");
    return res.end(buf);
  } catch (e) {
    log("fetch-image error", e.stack || e.message);
    return res.status(500).json({ status: "error", message: "server error" });
  }
});

// BWIKI 角色图标索引
// 「角色图标强制加载」：前端需要「文件名 → 图床直链」映射，改用钟楼剧本博物馆 WIKI 的角色照片。
// wiki 的 api.php 有反爬（缺 UA/Referer 会返回 567），浏览器无法自定义这两个头，所以由服务端代拉。
// 结果在内存里缓存（默认 24 小时），按需刷新。
const WIKI_API = "https://wiki.biligame.com/jbzlbwgwjcygf/api.php";
const WIKI_HEADERS = {
  referer: "https://wiki.biligame.com/jbzlbwgwjcygf/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
};
const WIKI_CACHE_TTL = 24 * 60 * 60 * 1000;
let wikiIconCache = null; // { map, at }

async function buildWikiIconMap() {
  const map = {};
  let cont = "";
  for (let i = 0; i < 40; i++) {
    const u = new URL(WIKI_API);
    u.searchParams.set("action", "query");
    u.searchParams.set("list", "allimages");
    u.searchParams.set("ailimit", "500");
    u.searchParams.set("aiprop", "url");
    u.searchParams.set("format", "json");
    if (cont) u.searchParams.set("aicontinue", cont);
    const r = await fetch(u.href, { headers: WIKI_HEADERS });
    if (!r.ok) throw new Error("wiki api " + r.status);
    const t = await r.json();
    const list = (t.query && t.query.allimages) || [];
    for (const f of list) {
      const m = /^(.*)\.(png|jpg|jpeg|gif|webp)$/i.exec(f.name || "");
      if (!m) continue;
      const base = m[1];
      const ext = m[2].toLowerCase();
      // 同名文件优先 png（角色图标通常是 png）
      if (!map[base] || (ext === "png" && !/\.png$/i.test(map[base] || ""))) {
        map[base] = f.url;
      }
    }
    cont = t.continue && t.continue.aicontinue;
    if (!cont) break;
  }
  return map;
}

app.get("/api/wiki-icons", async (req, res) => {
  try {
    const expired = !wikiIconCache || Date.now() - wikiIconCache.at > WIKI_CACHE_TTL;
    if (expired || req.query.refresh === "1") {
      const map = await buildWikiIconMap();
      wikiIconCache = { map, at: Date.now() };
      log("wiki icons refreshed", Object.keys(map).length);
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json({
      status: "success",
      count: Object.keys(wikiIconCache.map).length,
      map: wikiIconCache.map,
    });
  } catch (e) {
    log("wiki-icons error", e.stack || e.message);
    return res.status(502).json({ status: "error", message: "wiki fetch failed" });
  }
});

// 鱼皮剧本库（ran.dogyupi.com）接口代理
// 对方 API（apiran.dogyupi.com）没有 CORS 响应头，浏览器里直接 fetch 会被拦，
// 这里做一个只读转发：只允许 /api/ 下的路径，避免变成任意 URL 代理。
const DOGYUPI_BASE = "https://apiran.dogyupi.com";
const DOGYUPI_CACHE_TTL = 3 * 60 * 1000;
const DOGYUPI_CACHE_MAX = 120;
const dogyupiCache = new Map(); // href -> { body, at }

app.get("/api/dogyupi/*", async (req, res) => {
  try {
    const sub = req.params[0] || "";
    if (!/^api\//.test(sub)) {
      return res.status(403).json({ status: "error", message: "path not allowed" });
    }
    const qs = req.originalUrl.split("?")[1] || "";
    const href = DOGYUPI_BASE + "/" + sub + (qs ? "?" + qs : "");
    const cached = dogyupiCache.get(href);
    if (cached && Date.now() - cached.at < DOGYUPI_CACHE_TTL) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      return res.end(cached.body);
    }
    const upstream = await fetch(href, {
      headers: {
        accept: "application/json",
        referer: "https://ran.dogyupi.com/scripts",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!upstream.ok) {
      return res.status(502).json({ status: "error", message: `upstream ${upstream.status}` });
    }
    const body = await upstream.text();
    if (dogyupiCache.size >= DOGYUPI_CACHE_MAX) dogyupiCache.clear();
    dogyupiCache.set(href, { body, at: Date.now() });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.end(body);
  } catch (e) {
    log("dogyupi proxy error", e.stack || e.message);
    return res.status(502).json({ status: "error", message: "proxy failed" });
  }
});

// 头像静态资源
app.use("/avatars", express.static(AVATAR_DIR, { maxAge: 0, etag: true, lastModified: true }));

// 健康检查
app.get("/healthz", (req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

// 托管前端构建产物（若存在 dist/）
if (fs.existsSync(DIST_DIR)) {
  // index.html 绝不缓存：它总是要指向最新的带 hash 的 JS/CSS 包。
  // 否则用户浏览器可能一直用旧的 index.html → 加载旧 bundle（例如早期 1 秒超时的版本
  // 会导致"加入房间显示房间不存在"）。带 hash 的静态资源可以长缓存，但 HTML 必须每次校验。
  app.get("/", (req, res, next) => {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.sendFile(path.join(DIST_DIR, "index.html"), (err) => err && next(err));
  });
  // 其余静态资源：带 hash 的 js/css 长缓存；index.html 由上面的路由处理
  app.use(
    express.static(DIST_DIR, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    })
  );
  // SPA 兜底（本项目无路由，但保留以免刷新 404）
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/ws") || req.path.startsWith("/lobby")) return next();
    if (req.path.startsWith("/js/") || req.path.startsWith("/css/")) return next();
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
  log("serving static dist from", DIST_DIR);
} else {
  app.get("/", (req, res) => {
    res.type("text/plain").send(
      "TownSquare backend running.\n" +
        "HTTP: /dynamic/init, /upload/avatar, /avatars/*, /healthz\n" +
        "WS:   /ws/<channel>/<playerId>[/host?auth=...]  and  /lobby/<playerId>\n" +
        "（未发现 dist/，仅提供后端 API）"
    );
  });
}

const server = http.createServer(app);

// ------------------------------------------------------------------ WebSocket
// 单个 WebSocketServer(noServer) 处理全部路径，按 pathname 分派。
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://local").pathname;
  } catch {
    socket.destroy();
    return;
  }
  const parts = pathname.split("/").filter(Boolean);
  const ns = parts[0];

  if (ns !== "ws" && ns !== "lobby") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // 房间号合法性（仅 /ws）
  if (ns === "ws" && !validChannel(parts[1])) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._ts = { ns, req, pathname };
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const { ns, pathname } = ws._ts;
  ws.isAlive = true;
  ws._rtt = 0;
  ws.rateBucket = { count: 0, resetAt: Date.now() + 1000 };
  // 连上立刻做一次协议层 ping，尽快拿到第一份 RTT（不用等 30 秒心跳）
  try {
    ws._pingSentAt = Date.now();
    ws.ping();
  } catch {}

  ws.on("pong", () => {
    ws.isAlive = true;
    // 计算 WebSocket 协议层 RTT（服务端与这条连接之间的往返时延），供 app 层延迟显示用
    if (ws._pingSentAt) {
      const rtt = Date.now() - ws._pingSentAt;
      if (rtt >= 0 && rtt < 30000) ws._rtt = rtt;
      ws._pingSentAt = 0;
    }
  });

  if (ns === "lobby") {
    handleLobbyConnection(ws, pathname);
  } else {
    handleRoomConnection(ws, pathname, req);
  }

  ws.on("message", (raw) => {
    // 限流
    const now = Date.now();
    if (now > ws.rateBucket.resetAt) ws.rateBucket = { count: 0, resetAt: now + 1000 };
    ws.rateBucket.count += 1;
    if (ws.rateBucket.count > RATE_LIMIT_PER_SEC) return; // 丢弃超限帧

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [command, params, feedback] = msg;

    if (ns === "lobby") {
      // 大厅目前不需要处理客户端帧（前端只收）
      return;
    }
    routeRoomMessage(ws, command, params, feedback);
  });

  ws.on("close", () => onWsClose(ws));
  ws.on("error", (e) => log("ws error", e.message));
});

// 心跳巡检
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      return;
    }
    ws.isAlive = false;
    try {
      ws._pingSentAt = Date.now();
      ws.ping();
    } catch {}
  });
}, WS_HEARTBEAT_MS);

// ------------------------------------------------------------------ 大厅连接
function handleLobbyConnection(ws, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["lobby", playerId]
  const playerId = parts[1] || crypto.randomBytes(6).toString("hex");
  const client = { ws, playerId };
  lobbyClients.add(client);
  ws._lobbyClient = client;
  // 连上即下发当前房间列表
  send(ws, "setRooms", lobbySnapshot());
  log("lobby connect", playerId, "clients:", lobbyClients.size);
}

// ------------------------------------------------------------------ 房间连接
function handleRoomConnection(ws, pathname, req) {
  const { channel, playerId, isHost } = parseChannel(pathname);
  const url = new URL(req.url, "http://local");
  const auth = url.searchParams.get("auth") || "";

  let room = rooms.get(channel);
  const isNewRoom = !room;
  // 房间对象此刻若还不存在（host 首次连入），下面会创建；但对"玩家加入发现房间不存在"的
  // 检测必须放在创建之前，否则会误创建幽灵房。因此仅当 isHost 时才允许创建，见下。

  ws._room = { channel, playerId, isHost, auth };

  if (isHost) {
    if (!auth) {
      send(ws, "alertPopup", "说书人连接缺少身份密钥。");
      try {
        ws.close(4009, "missing host auth");
      } catch {}
      return;
    }
    // 说书人建房：只有 host 才真正创建房间对象（玩家连入不存在的房不会建幽灵房）
    if (!room) {
      room = {
        host: null,
        hostIdentity: null,
        players: new Map(),
        createdAt: Date.now(),
        everHadHost: false,
        standbyHosts: [], // 同一说书人身份重复打开的说书人网页（只提示，不代关）
        meta: {},
        quickWake: { records: new Map(), order: [] },
        lastGs: null, // 缓存说书人最近一次广播的 gs（含座位表），供新加入者补发
      };
      rooms.set(channel, room);
    }
    cancelRoomCleanup(channel);
    // 说书人接管：若已有 host 且 auth 不同则拒绝（防重复 host）
    if (room.host && room.host.auth !== auth) {
      send(ws, "alertPopup", "该房间已有说书人，无法接管。");
      try {
        ws.close(4009, "host already exists");
      } catch {}
      return;
    }
    if (
      !room.host &&
      room.hostIdentity &&
      (room.hostIdentity.playerId !== playerId ||
        room.hostIdentity.auth !== auth)
    ) {
      send(ws, "alertPopup", "该房间已有说书人，无法接管。");
      try {
        ws.close(4009, "host identity mismatch");
      } catch {}
      return;
    }
    // 同一说书人（同浏览器多标签共享同一个 stSecret）又开了一个说书人网页：
    // 只提示用户自己关闭一个，绝不替用户关闭；先到的页面保持权威，后来的作为待命，
    // 待命页面的游戏指令一律丢弃（见 routeRoomMessage），不会和权威页面打架。
    if (
      room.host &&
      room.host.ws !== ws &&
      room.host.auth === auth &&
      room.host.ws &&
      room.host.ws.readyState === 1
    ) {
      if (!Array.isArray(room.standbyHosts)) room.standbyHosts = [];
      room.standbyHosts = room.standbyHosts.filter((s) => s.ws && s.ws.readyState === 1 && s.ws !== ws);
      room.standbyHosts.push({ ws, playerId, auth, connectedAt: Date.now() });
      ws._standbyHost = true;
      const dupMsg = "检测到多个说书人网页，请关闭一个。";
      send(ws, "alertPopup", dupMsg);
      send(room.host.ws, "alertPopup", dupMsg);
      send(ws, "allowHost", true);
      sendQuickWakeSnapshot(ws, room);
      log("duplicate host -> standby channel", channel, "playerId", playerId);
      return;
    }
    room.hostAuth = auth;
    room.host = { ws, playerId, auth, connectedAt: Date.now() };
    room.hostIdentity = { playerId, auth };
    room.everHadHost = true;
    room.hostLeftAt = null;
    if (!room.meta) room.meta = {};
    log("host connect channel", channel, "playerId", playerId);
    // 客户端会主动 _request checkAllowHost；此处直接回允许（重复 host 已在上面拦截）
    send(ws, "allowHost", true);
    sendQuickWakeSnapshot(ws, room);
    notifyQuickWakePresence(room);
    // host 不会重复加入 players；若此 playerId 之前以玩家身份在房间，移除
    if (room.players.has(playerId)) {
      const old = room.players.get(playerId);
      room.players.delete(playerId);
      if (old.ws !== ws) {
        try {
          old.ws.close(4001, "promoted to host");
        } catch {}
      }
    }
    if (isNewRoom) notifyLobbyAdd(channel);
    else notifyLobbyUpdate(channel);
  } else {
    // 玩家/观众：房间必须已存在（有说书人建过）。不存在则直接拒绝，不建幽灵房。
    if (!room || !room.everHadHost) {
      log("player join nonexistent channel", channel, "playerId", playerId);
      send(ws, "allowJoin", false);
      // 稍后关闭，避免悬挂连接（先让它收到 allowJoin=false）
      setTimeout(() => {
        try {
          ws.close(4004, "room not found");
        } catch {}
      }, 100);
      return;
    }
    // A public stable player ID is not a credential. Bind it to the browser's
    // random session secret on first join, and require that secret on reconnect.
    if (!room.playerIdentities) room.playerIdentities = new Map();
    const expectedAuth = room.playerIdentities.get(playerId);
    if (!auth || (expectedAuth && expectedAuth !== auth)) {
      send(ws, "allowJoin", false);
      ws.close(4003, "invalid player credentials");
      return;
    }
    room.playerIdentities.set(playerId, auth);
    cancelRoomCleanup(channel);
    // 同 playerId 重复连接则踢掉旧连接
    if (room.players.has(playerId)) {
      const old = room.players.get(playerId);
      if (old.ws !== ws) {
        try {
          old.ws.close(4000, "duplicate playerId");
        } catch {}
      }
    }
    room.players.set(playerId, { ws, ping: 0, connectedAt: Date.now() });
    log("player connect channel", channel, "playerId", playerId, "players:", room.players.size);
    // 玩家上线后立即广播 presence，让说书人端的「快捷短语对象在线状态」实时更新。
    // （此前只在 host 连接 / 玩家 bye / socket 断开时才通知，导致玩家上线时
    //   host 的 onlinePlayerIds 仍是旧的空集合 → 发送对象始终显示离线。）
    notifyQuickWakePresence(room);
    // 客户端会 _request checkAllowJoin；此处按房间是否存在(曾有过host)回答
    send(ws, "allowJoin", true);
    // 关键修复：若说书人此前已广播过 gs（含座位表），立即补发给刚加入的玩家，
    // 避免依赖"客户端主动向 host 请求 getGamestate 且 host 恰好在线并回应"这一时序，
    // 否则新加入者可能看不到任何座位。缓存的 gs 是普通负荷（非 lightweight），座位信息完整。
    if (room.lastGs) {
      send(ws, "gs", room.lastGs);
    }
    notifyLobbyUpdate(channel);
  }
}

/**
 * 处理房间内客户端消息。核心：转发、direct 拆包、request 处理、ping/bye 计数。
 */
function routeRoomMessage(ws, command, params, feedback) {
  const meta = ws._room;
  if (!meta) return;
  const room = rooms.get(meta.channel);
  if (!room) return;

  // 待命说书人（同一说书人身份重复打开的网页）：不参与任何房间写入或广播，
  // 只放行 ping（延迟统计）与 request（checkAllowHost 心跳），其余游戏指令全部丢弃。
  if (ws._standbyHost && command !== "ping" && command !== "request") return;

  switch (command) {
    case "quickWakeSeats": {
      if (!meta.isHost || !room.host || room.host.ws !== ws) {
        sendQuickWakeError(ws, "", "forbidden", "只有当前说书人可以更新座位身份。");
        return;
      }
      if (Array.isArray(params)) room.quickWakeSeated = new Set(params.filter(id => typeof id === "string" && id && id !== "host" && id !== meta.playerId));
      // 座位名单更新后同步刷新 presence，保证在线集合与座位表一致性。
      notifyQuickWakePresence(room);
      return;
    }
    case "quickWakeSend": {
      handleQuickWakeSend(ws, room, meta, params);
      return;
    }

    case "quickWakeReply": {
      handleQuickWakeReply(ws, room, meta, params);
      return;
    }

    case "quickWakeReceipt": {
      handleQuickWakeReceipt(ws, room, meta, params);
      return;
    }

    case "quickWakeSyncRequest": {
      if (!meta.isHost || !room.host || room.host.ws !== ws) {
        sendQuickWakeError(ws, "", "forbidden", "只有当前说书人可以同步快捷唤醒历史。");
        return;
      }
      sendQuickWakeSnapshot(ws, room);
      return;
    }

    // ---- 中转：原样广播给房间其他人（含 host）----
    case "direct": {
      // params: { <targetId|"host">: [command, params] }
      if (!params || typeof params !== "object") return;
      Object.keys(params).forEach((targetId) => {
        const sub = params[targetId];
        if (!Array.isArray(sub)) return;
        const [subCmd, subParams] = sub;
        if (isQuickWakeCommand(subCmd)) {
          sendQuickWakeError(
            ws,
            subParams && (subParams.id || subParams.wakeId),
            "forbidden",
            "快捷唤醒必须使用受校验的专用消息通道。"
          );
          return;
        }
        if (targetId === "host") {
          if (room.host && room.host.ws !== ws) {
            send(room.host.ws, subCmd, subParams, feedback);
          }
        } else {
          const target = room.players.get(targetId);
          if (target && target.ws !== ws) {
            send(target.ws, subCmd, subParams, feedback);
          }
        }
      });
      // 回一个 feedback 帧给发送方自己：前端收到后会把自己这条消息也追加到本地
      // 聊天记录里（私聊时"自己发的消息"才能显示出来），并清掉发送队列。
      if (feedback !== undefined && feedback !== false) {
        send(ws, "feedback", feedback);
      }
      return;
    }

    case "request": {
      // params: { <subCommand>: [playerId, subParams] }
      if (!params || typeof params !== "object") return;
      Object.keys(params).forEach((subCommand) => {
        const [playerId, subParams] = params[subCommand] || [];
        handleRequest(ws, room, meta, subCommand, playerId, subParams, feedback);
      });
      return;
    }

    case "uploadFile": {
      // params: { <command>: [playerId, base64] } —— 头像走 socket 上传
      if (!params || typeof params !== "object") return;
      Object.keys(params).forEach((subCommand) => {
        const [playerId, dataUrl] = params[subCommand] || [];
        handleSocketUpload(ws, playerId, subCommand, dataUrl, feedback);
      });
      return;
    }

    case "roomMeta": {
      // 说书人上报房间元数据：{ name, stName, edition, maxPlayers }
      // 只允许 host 更新，且只接受白名单字段（防注入/防越权）。
      if (!meta || !meta.isHost) return;
      if (!params || typeof params !== "object") return;
      const clean = {};
      if (typeof params.name === "string") clean.name = params.name.slice(0, 60);
      if (typeof params.stName === "string") clean.stName = params.stName.slice(0, 40);
      if (typeof params.edition === "string") clean.edition = params.edition.slice(0, 32);
      if (typeof params.editionName === "string") clean.editionName = params.editionName.slice(0, 60);
      // 剧本封面（剧本 JSON 里的 _meta.logo），供大厅展示。只接受 http(s) 绝对地址。
      if (typeof params.editionLogo === "string" && /^https?:\/\//i.test(params.editionLogo)) {
        clean.editionLogo = params.editionLogo.slice(0, 512);
      }
      if (Number.isFinite(params.maxPlayers)) clean.maxPlayers = Math.max(0, Math.min(20, Math.floor(params.maxPlayers)));
      room.meta = Object.assign({}, room.meta, clean);
      // 房间若已在大厅可见，广播更新；否则（首次）按新增处理
      if (room.everHadHost) notifyLobbyUpdate(meta.channel);
      return;
    }

    case "ping": {
      // params: [playerIdOrCount, "latency"]
      // 客户端每 3 秒发一次 ping（第二项是字面量 "latency"），服务端负责把「其他节点」
      // 各自的往返时延填成真实数字再转发，前端才能显示「与说书人的延迟 / 与玩家的延迟」。
      const [who, latency] = Array.isArray(params) ? params : [];
      const p = room.players.get(who);
      if (p) p.ping = Date.now();
      // 回 pong（前端 _handlePong 只置 _isAlive=true）
      send(ws, "pong", latency || 0);
      const isSenderHost = room.host && room.host.ws === ws;
      if (isSenderHost) {
        // 说书人发起的 ping：转发给每个玩家，让玩家得到「与说书人的延迟」。
        // 玩家侧 _handlePing 走 else if(latency) 分支，第一项必须是 0/空。
        room.players.forEach((pl, pid) => {
          const rtt = pl.ws && pl.ws._rtt ? pl.ws._rtt : 0;
          send(pl.ws, "ping", [0, rtt]);
        });
      } else if (p) {
        // 玩家发起的 ping：把该玩家测得的延迟转发给说书人，让说书人统计各玩家延迟。
        const rtt = ws._rtt ? ws._rtt : 0;
        if (room.host && room.host.ws) {
          send(room.host.ws, "ping", [who, rtt]);
        }
      }
      return;
    }

    case "bye": {
      // 玩家主动离开
      const playerId = params;
      if (playerId !== meta.playerId) return;
      room.players.delete(playerId);
      notifyQuickWakePresence(room);
      // 通知 host 更新人数
      if (room.host) send(room.host.ws, "bye", playerId);
      notifyLobbyUpdate(meta.channel);
      return;
    }

    case "dissolveRoom": {
      // 说书人主动解散房间 → 立刻从大厅移除并踢出所有玩家（不等宽限期）
      if (!meta.isHost) return;
      dissolveRoom(meta.channel);
      return;
    }

    case "reviewRevealed": {
      // 复盘视角：仅说书人可广播「谁被点开揭示」，转发全房间并缓存供重连补发
      if (!meta.isHost) return;
      room.reviewRevealed = Array.isArray(params) ? params.slice(0, 20) : [];
      broadcastRoom(room, "reviewRevealed", room.reviewRevealed, ws);
      return;
    }

    case "blindDraw": {
      // 盲抽角色：仅说书人可开启/关闭盲抽，转发全房间并缓存供重连补发。
      // 隐私：角色内容（roles）只留在说书人本地，绝不能随广播下发，否则玩家可反推他人身份。
      // 只广播 active + 槽位数量 count（=roles.length），以及已有的 taken 记录。
      if (!meta.isHost) return;
      const active = !!(params && params.active);
      const count = active ? (Number(params && params.count) || 0) : 0;
      room.blindDraw = {
        active,
        count,
        taken: active && Array.isArray(params && params.taken) ? params.taken : []
      };
      broadcastRoom(room, "blindDraw", { active, count, taken: room.blindDraw.taken }, ws);
      return;
    }

    case "blindDrawTaken": {
      // 盲抽角色：某个槽位被抽走 → 转发「槽位 -> 抽取者」给全房间（不含抽到什么角色），缓存供重连补发
      if (!meta.isHost) return;
      room.blindDrawTaken = Array.isArray(params) ? params : [];
      if (room.blindDraw) room.blindDraw.taken = room.blindDrawTaken;
      broadcastRoom(room, "blindDrawTaken", room.blindDrawTaken, ws);
      return;
    }

    default: {
      if (isQuickWakeCommand(command)) {
        sendQuickWakeError(ws, params && (params.id || params.wakeId), "forbidden", "快捷唤醒消息不可广播。");
        return;
      }
      // 其余所有游戏广播命令（gs/player/nomination/vote/lock/swap/move/remove/
      // chat/addGroupChat/fabled/isNight/votingSpeed/... ）一律原样转发给房间内
      // 除发送者外的所有连接（host 发出的给所有玩家，玩家发出的给 host 及其他玩家）。
      // 若说书人广播的是完整 gs（含座位表），缓存一份，供后续新加入者补发（见 handleRoomConnection）。
      if (command === "gs" && meta.isHost && params && Array.isArray(params.gamestate) && !params.isLightweight) {
        room.lastGs = params;
      }
      broadcastRoom(room, command, params, ws);
      return;
    }
  }
}

function cleanQuickWakeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function cleanQuickWakePhase(phase) {
  if (!phase || typeof phase !== "object") {
    return { kind: "night", night: 1, label: "第1夜" };
  }
  const kind = phase.kind === "day" ? "day" : "night";
  const n = Number.isFinite(Number(phase.night)) && Number(phase.night) >= 1
    ? Math.floor(Number(phase.night))
    : 1;
  return {
    kind,
    night: n,
    label: cleanQuickWakeText(phase.label, 40) || (kind === "night" ? `第${n}夜` : `第${n}个白天`),
  };
}

function handleQuickWakeSend(ws, room, meta, params) {
  if (!meta.isHost || !room.host || room.host.ws !== ws) {
    sendQuickWakeError(ws, params && params.id, "forbidden", "只有当前说书人可以发送快捷唤醒。");
    return;
  }
  if (!params || typeof params !== "object") {
    sendQuickWakeError(ws, "", "invalid", "快捷唤醒消息格式无效。");
    return;
  }
  const id = cleanQuickWakeText(params.id, 100);
  const roomId = String(params.roomId || "");
  const targetPlayerId = cleanQuickWakeText(params.targetPlayerId, 100);
  const content = cleanQuickWakeText(params.content, 4000);
  if (!id || !targetPlayerId || !content || roomId !== String(meta.channel)) {
    sendQuickWakeError(ws, id, "invalid", "消息为空或收件人/房间信息不完整。");
    return;
  }

  const state = ensureQuickWakeState(room);
  const existing = state.records.get(id);
  if (existing) {
    if (
      existing.senderPlayerId !== meta.playerId ||
      existing.targetPlayerId !== targetPlayerId ||
      existing.content !== content ||
      existing.roomId !== roomId
    ) {
      sendQuickWakeError(ws, id, "conflict", "消息 ID 已被另一条消息使用。");
      return;
    }
    const target = room.players.get(targetPlayerId);
    if (target && room.quickWakeSeated && room.quickWakeSeated.has(targetPlayerId) && target.ws !== existing.targetWs && !existing.reply) {
      existing.targetWs = target.ws;
      send(target.ws, "quickWakeIncoming", publicQuickWake(existing));
    }
    send(ws, "quickWakeAccepted", { id });
    if (quickWakeStatus(existing) !== "accepted") {
      send(ws, "quickWakeStatus", publicQuickWake(existing));
    }
    return;
  }

  if (!room.quickWakeSeated || !room.quickWakeSeated.has(targetPlayerId)) {
    sendQuickWakeError(ws, id, "unseated", "目标玩家已离座或座位为空，消息未发送。");
    return;
  }
  const target = room.players.get(targetPlayerId);
  if (!target || !target.ws || target.ws.readyState !== 1) {
    sendQuickWakeError(ws, id, "offline", "目标玩家当前未连接，消息未发送。");
    return;
  }

  if (state.order.length >= 1000) {
    sendQuickWakeError(ws, id, "capacity", "待回复消息过多，请先处理现有消息。");
    return;
  }
  const record = {
    id,
    roomId,
    senderPlayerId: meta.playerId,
    senderName: cleanQuickWakeText(params.senderName, 80) || "说书人",
    targetPlayerId,
    targetSeat: Number.isFinite(Number(params.targetSeat))
      ? Math.max(1, Math.floor(Number(params.targetSeat)))
      : 0,
    targetName: cleanQuickWakeText(params.targetName, 80),
    phase: cleanQuickWakePhase(params.phase),
    content,
    createdAt: cleanQuickWakeText(params.createdAt, 80) || new Date().toISOString(),
    deliveredAt: null,
    repliedAt: null,
    reply: null,
    targetWs: target.ws,
  };

  storeQuickWakeRecord(room, record);
  send(target.ws, "quickWakeIncoming", publicQuickWake(record));
  // 这是服务端已接收的确认，不代表玩家客户端已经收到；送达状态由
  // quickWakeReceipt 回执确认。
  send(ws, "quickWakeAccepted", { id });
}

function handleQuickWakeReceipt(ws, room, meta, params) {
  if (meta.isHost || !room.players.get(meta.playerId) || room.players.get(meta.playerId).ws !== ws) {
    sendQuickWakeError(ws, params && params.wakeId, "forbidden", "说书人不能伪造玩家送达回执。");
    return;
  }
  const wakeId = cleanQuickWakeText(params && params.wakeId, 100);
  if (!wakeId) return;
  const state = ensureQuickWakeState(room);
  const record = state.records.get(wakeId);
  if (!record || record.targetPlayerId !== meta.playerId) {
    sendQuickWakeError(ws, wakeId, "forbidden", "不能确认不属于你的快捷唤醒。");
    return;
  }
  if (String(params.roomId || "") !== String(meta.channel)) {
    sendQuickWakeError(ws, wakeId, "invalid", "房间信息不匹配。");
    return;
  }
  if (!record.deliveredAt) record.deliveredAt = new Date().toISOString();
  record.targetWs = ws;
  if (room.host && room.host.ws) {
    send(room.host.ws, "quickWakeStatus", publicQuickWake(record));
  }
}

function handleQuickWakeReply(ws, room, meta, params) {
  if (meta.isHost || !room.players.get(meta.playerId) || room.players.get(meta.playerId).ws !== ws) {
    sendQuickWakeError(ws, params && params.id, "forbidden", "说书人不能代替玩家回复。");
    return;
  }
  if (!params || typeof params !== "object") {
    sendQuickWakeError(ws, "", "invalid", "回复格式无效。");
    return;
  }
  const replyId = cleanQuickWakeText(params.id, 100);
  const wakeId = cleanQuickWakeText(params.wakeId, 100);
  const content = cleanQuickWakeText(params.content, 1000);
  if (!replyId || !wakeId || !content) {
    sendQuickWakeError(ws, replyId || wakeId, "invalid", "回复不能为空。");
    return;
  }
  if (String(params.roomId || "") !== String(meta.channel)) {
    sendQuickWakeError(ws, replyId, "invalid", "房间信息不匹配。");
    return;
  }

  const state = ensureQuickWakeState(room);
  const record = state.records.get(wakeId);
  if (!record || record.targetPlayerId !== meta.playerId) {
    sendQuickWakeError(ws, replyId, "forbidden", "不能回复不属于你的快捷唤醒。");
    return;
  }

  if (record.reply) {
    if (record.reply.id !== replyId) {
      sendQuickWakeError(ws, replyId, "alreadyReplied", "这条快捷唤醒已经回复过了。");
      return;
    }
    send(ws, "quickWakeReplyAck", record.reply);
    if (room.host && room.host.ws) {
      send(room.host.ws, "quickWakeStatus", publicQuickWake(record));
    }
    return;
  }

  record.reply = {
    id: replyId,
    wakeId,
    roomId: String(meta.channel),
    playerId: meta.playerId,
    senderName: cleanQuickWakeText(params.senderName, 80) || record.targetName,
    phase: cleanQuickWakePhase(params.phase || record.phase),
    content,
    createdAt: cleanQuickWakeText(params.createdAt, 80) || new Date().toISOString(),
  };
  record.repliedAt = record.reply.createdAt;
  record.targetWs = ws;

  send(ws, "quickWakeReplyAck", record.reply);
  if (room.host && room.host.ws) {
    send(room.host.ws, "quickWakeStatus", publicQuickWake(record));
  }
}

// request 子命令处理
function handleRequest(ws, room, meta, subCommand, playerId, subParams, feedback) {
  switch (subCommand) {
    case "checkAllowHost":
      if (!meta.isHost) {
        send(ws, "allowHost", false);
        break;
      }
      // 同一 stSecret 的第二个说书人网页（待命）：允许加入，只由前端提示，不强制关闭
      if (room.host && room.host.ws !== ws && room.host.auth === meta.auth) {
        if (!Array.isArray(room.standbyHosts)) room.standbyHosts = [];
        if (!room.standbyHosts.some((s) => s.ws === ws)) {
          room.standbyHosts = room.standbyHosts.filter((s) => s.ws && s.ws.readyState === 1);
          room.standbyHosts.push({ ws, playerId: meta.playerId, auth: meta.auth, connectedAt: Date.now() });
        }
        ws._standbyHost = true;
        send(ws, "allowHost", true);
        break;
      }
      // 说书人请求开房：若已有其它 host 则拒绝
      if (
        (room.host && room.host.ws !== ws) ||
        (room.hostIdentity &&
          (room.hostIdentity.playerId !== meta.playerId ||
            room.hostIdentity.auth !== meta.auth))
      ) {
        send(ws, "allowHost", false);
      } else {
        if (!room.host) {
          room.host = { ws, playerId, auth: meta.auth, connectedAt: Date.now() };
          room.hostIdentity = { playerId, auth: meta.auth };
          room.everHadHost = true;
          cancelRoomCleanup(meta.channel);
        }
        send(ws, "allowHost", true);
      }
      break;
    case "checkAllowJoin":
      // 只要该房间曾经/现在有说书人（含说书人重连宽限期）就允许加入。
      // 单纯由玩家自己刚连上而新建的空房间不算，避免误判为存在。
      send(ws, "allowJoin", !!(room.everHadHost || room.host));
      break;
    case "deleteMessage": {
      // 前端在收到一条 chat 后，会发 request deleteMessage：[playerId, ["direct", 原始消息id]]。
      // 设计约定：服务端要把这个「原始消息id」作为 feedback 回给房间（真正要的是回给发信人），
      // 发信人收到 feedback 后 _deleteFromQueue(原始id) 才会把「自己发的这条」也落到本地聊天记录里。
      // 否则发送方永远看不到自己发出的消息。
      const origId = Array.isArray(subParams) ? subParams[1] : undefined;
      if (origId !== undefined && origId !== null) {
        broadcastRoom(room, "feedback", origId, null);
      }
      // 同时按需给请求方回执（保持通用 request 语义）
      if (feedback !== undefined && feedback !== false) {
        send(ws, "feedback", feedback);
      }
      break;
    }
    default:
      // 未知 request：忽略
      break;
  }
}

// socket 上传头像
function handleSocketUpload(ws, playerId, subCommand, dataUrl, feedback) {
  if (subCommand !== "uploadAvatar") return;
  try {
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl || "");
    if (!m) return;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_AVATAR_BYTES) return;
    const safeId = String(playerId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "anon";
    const fileName = `${safeId}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, fileName), buf);
    // 回 avatarReceived，link 需以 playerId 开头（前端 link.split('.')[0] === playerId）
    send(ws, "avatarReceived", `/avatars/${fileName}`, feedback);
  } catch (e) {
    log("socket upload error", e.message);
  }
}

// 连接关闭清理
function onWsClose(ws) {
  const meta = ws._room;
  if (meta) {
    const room = rooms.get(meta.channel);
    if (room) {
      if (meta.isHost && room.host && room.host.ws === ws) {
        room.host = null;
        room.hostLeftAt = Date.now();
        log("host leave channel", meta.channel);
        // 若还有同身份的待命说书人网页（未被用户关掉），自动升为权威，避免房间悬空。
        // 注意：这只是"接管"，不是替用户关闭任何页面。
        if (Array.isArray(room.standbyHosts)) {
          room.standbyHosts = room.standbyHosts.filter((s) => s.ws && s.ws.readyState === 1);
          const next = room.standbyHosts.shift();
          if (next) {
            next.ws._standbyHost = false;
            room.host = { ws: next.ws, playerId: next.playerId, auth: next.auth, connectedAt: Date.now() };
            room.hostIdentity = { playerId: next.playerId, auth: next.auth };
            room.everHadHost = true;
            cancelRoomCleanup(meta.channel);
            send(next.ws, "allowHost", true);
            log("standby host promoted channel", meta.channel, "playerId", next.playerId);
          }
        }
        // 说书人暂时离开（可能是网络抖动/隧道断连重连）：保留房间一段宽限期，
        // 避免瞬间删除房间导致其它玩家加入时报"房间不存在"。
      } else if (ws._standbyHost) {
        if (Array.isArray(room.standbyHosts)) {
          room.standbyHosts = room.standbyHosts.filter((s) => s.ws !== ws);
        }
        log("standby host leave channel", meta.channel);
      } else if (!meta.isHost) {
        const p = room.players.get(meta.playerId);
        if (p && p.ws === ws) {
          room.players.delete(meta.playerId);
          if (room.host) send(room.host.ws, "bye", meta.playerId);
          log("player leave channel", meta.channel, meta.playerId, "players:", room.players.size);
          notifyLobbyUpdate(meta.channel);
        }
      }
      notifyQuickWakePresence(room);
      // 空房间回收：说书人离开时给一个宽限期（等待其重连），宽限期内保留房间，
      // 避免玩家加入时误报"房间不存在"。玩家全走且host也走时同样走宽限。
      if (!room.host && room.players.size === 0) {
        scheduleRoomCleanup(meta.channel);
      }
    }
  }
  const lc = ws._lobbyClient;
  if (lc) {
    lobbyClients.delete(lc);
    log("lobby disconnect", lc.playerId, "clients:", lobbyClients.size);
  }
}

// ------------------------------------------------------------------ 启动
server.listen(PORT, () => {
  log(`HTTP + WS listening on http://0.0.0.0:${PORT}`);
  log(`  game ws : ws://<host>:${PORT}/ws/<channel>/<playerId>[/host?auth=...]`);
  log(`  lobby ws: ws://<host>:${PORT}/lobby/<playerId>`);
  log(`  avatars : ${AVATAR_DIR}`);
});

// 优雅退出
function shutdown(signal) {
  log(`${signal} received, shutting down`);
  clearInterval(heartbeat);
  wss.clients.forEach((c) => {
    try {
      c.close(1001, "server shutdown");
    } catch {}
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
