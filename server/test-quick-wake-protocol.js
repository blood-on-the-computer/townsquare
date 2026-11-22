"use strict";
const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const net = require("net");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clients = [];
let child;
let passed = 0;
function connect(url) {
  if (url.includes("/ws/") && !url.includes("?"))
    url += "?auth=test-" + url.split("/").pop();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.messages = [];
    clients.push(socket);
    socket.on("message", (data) => socket.messages.push(JSON.parse(data)));
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
function send(socket, command, payload) {
  socket.send(JSON.stringify([command, payload]));
}
async function frame(socket, command, predicate = () => true) {
  for (let i = 0; i < 100; i++) {
    const index = socket.messages.findIndex(
      ([cmd, payload]) => cmd === command && predicate(payload),
    );
    if (index >= 0) return socket.messages.splice(index, 1)[0][1];
    await wait(20);
  }
  throw Error(`Timed out waiting for ${command}`);
}
function ok(name, condition) {
  assert.ok(condition, name);
  passed++;
  console.log("PASS", name);
}
(async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const n = s.address().port;
      s.close(() => resolve(n));
    });
  });
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: require("path").join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), RATE_LIMIT: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(Error("Local server did not start: " + output)),
      5000,
    );
    child.stdout.on("data", (d) => {
      output += d;
      if (output.includes("listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(Error("Server exited " + code));
    });
  });
  const base = `ws://127.0.0.1:${port}/ws/1234`;
  const host = await connect(`${base}/st/host?auth=test-secret`);
  await frame(host, "allowHost");
  const p1 = await connect(`${base}/p1`);
  const other = await connect(`${base}/other`);
  // 回归：玩家上线后，说书人必须通过 quickWakePresence 收到包含该玩家的在线集合，
  // 否则前端 onlinePlayerIds 恒为空 → 发送对象始终显示离线。
  const presence = await frame(
    host,
    "quickWakePresence",
    (p) => Array.isArray(p.playerIds) && p.playerIds.includes("p1"),
  );
  ok(
    "玩家上线后说书人即时收到 presence（含在线玩家）",
    presence.hostOnline === true &&
      presence.playerIds.includes("p1") &&
      presence.playerIds.includes("other"),
  );
  send(other, "quickWakeSeats", ["other"]);
  await frame(other, "quickWakeError");
  send(host, "quickWakeSeats", []);
  send(host, "quickWakeSend", {
    id: "unseated",
    roomId: "1234",
    targetPlayerId: "p1",
    content: "不应发送",
  });
  const unseated = await frame(host, "quickWakeError");
  ok(
    "空座及离座目标不可发送，玩家不能伪造座位名单",
    unseated.code === "unseated",
  );
  const impersonator = await connect(`${base}/p1?auth=not-the-player-secret`);
  const denied = await frame(impersonator, "allowJoin");
  ok("已公开的稳定ID不能被其他浏览器冒用重连", denied === false);
  const payload = {
    id: "test-one",
    roomId: "1234",
    targetPlayerId: "p1",
    senderPlayerId: "forged-st",
    targetName: "A",
    content: "0 是有效消息",
    phase: { kind: "night", night: 3, label: "第3夜" },
  };
  send(host, "quickWakeSeats", ["p1"]);
  send(host, "quickWakeSend", payload);
  const incoming = await frame(p1, "quickWakeIncoming");
  ok(
    "定向接收及内容快照",
    incoming.content === payload.content && incoming.targetPlayerId === "p1",
  );
  ok("发送者稳定ID来自已认证连接", incoming.senderPlayerId === "st");
  await frame(host, "quickWakeAccepted");
  await wait(80);
  ok(
    "中继接受不等同玩家已送达，旁观者未收到",
    !host.messages.some(
      ([cmd, p]) => cmd === "quickWakeStatus" && p.status === "delivered",
    ) && !other.messages.some(([cmd]) => cmd === "quickWakeIncoming"),
  );
  send(other, "quickWakeReceipt", { wakeId: payload.id, roomId: "1234" });
  await frame(other, "quickWakeError");
  send(other, "quickWakeReply", {
    id: "forged-reply",
    wakeId: payload.id,
    roomId: "1234",
    playerId: "p1",
    content: "是",
  });
  await frame(other, "quickWakeError");
  ok("第三方不能伪造送达或回复", true);
  for (const command of [
    "quickWakeIncoming",
    "quickWakeStatus",
    "quickWakeReplyAck",
    "quickWakeSync",
  ]) {
    send(other, "direct", { p1: [command, { id: "forged" }] });
    await frame(other, "quickWakeError");
    send(other, command, { id: "forged" });
    await frame(other, "quickWakeError");
  }
  await wait(60);
  ok(
    "所有保留命令禁止direct及广播注入",
    !p1.messages.some(([, p]) => p && p.id === "forged"),
  );
  send(p1, "quickWakeReceipt", { wakeId: payload.id, roomId: "1234" });
  await frame(
    host,
    "quickWakeStatus",
    (p) => p.id === payload.id && p.status === "delivered",
  );
  ok("实际玩家回执才变为已送达", true);
  p1.close();
  await wait(80);
  const p1Again = await connect(`${base}/p1`);
  await frame(p1Again, "quickWakeIncoming", (p) => p.id === payload.id);
  send(host, "quickWakeSend", payload);
  await frame(host, "quickWakeAccepted");
  await wait(80);
  ok(
    "重连恢复待回复，沿用原ID重试不二次投递",
    !p1Again.messages.some(([cmd]) => cmd === "quickWakeIncoming"),
  );
  const reply = {
    id: "reply-one",
    wakeId: payload.id,
    roomId: "1234",
    content: "了解",
    phase: { kind: "day", night: 3, label: "第3个白天" },
  };
  send(p1Again, "quickWakeReply", reply);
  const ack = await frame(p1Again, "quickWakeReplyAck");
  const status = await frame(
    host,
    "quickWakeStatus",
    (p) => p.status === "replied",
  );
  ok(
    "回复正确关联消息和目标身份",
    ack.wakeId === payload.id && status.reply.playerId === "p1",
  );
  ok("回复保留独立发送阶段快照", status.reply.phase.label === "第3个白天");
  send(p1Again, "quickWakeReply", reply);
  await frame(p1Again, "quickWakeReplyAck");
  ok("相同回复ID重试幂等", true);
  const newHost = await connect(`${base}/st/host?auth=test-secret`);
  await frame(newHost, "allowHost");
  send(host, "quickWakeSend", { ...payload, id: "old-host-send" });
  await frame(host, "quickWakeError");
  ok("已替换的旧说书人连接不能发消息", true);
  const replacement = await connect(
    `${base}/different-st/host?auth=test-secret`,
  );
  await frame(replacement, "allowHost");
  const isolated = await frame(replacement, "quickWakeSync");
  ok("新说书人身份不会自动取得旧身份历史", isolated.length === 0);
  host.close();
  newHost.close();
  replacement.close();
  await wait(100);
  const intruder = await connect(`${base}/intruder/host?auth=wrong-secret`);
  await frame(intruder, "alertPopup");
  ok(
    "说书人断线后仍需原凭证才能接管",
    !intruder.messages.some(([cmd, p]) => cmd === "allowHost" && p === true),
  );
  send(other, "request", { checkAllowHost: ["other", null] });
  const allow = await frame(other, "allowHost");
  ok("普通玩家不能经checkAllowHost劫持断线说书人", allow === false);
  console.log(`\n${passed} isolated WebSocket protocol checks passed`);
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    clients.forEach((socket) => socket.terminate());
    if (child) child.kill();
  });
