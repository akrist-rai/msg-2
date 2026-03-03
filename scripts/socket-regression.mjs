import { io } from "socket.io-client";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
      ? process.argv[++i]
      : "true";
    args.set(key, value);
  }
}

const base = (args.get("base") || process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const verbose = args.get("verbose") === "true";

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function waitForEvent(socket, event, timeoutMs = 8000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    const handler = (payload) => {
      try {
        if (!predicate(payload)) return;
        clearTimeout(timeout);
        socket.off(event, handler);
        resolve(payload);
      } catch {
        // ignore
      }
    };
    socket.on(event, handler);
  });
}

async function main() {
  const suffix = Date.now();

  const r1 = await api("POST", "/api/auth/register", {
    username: `socketcheck_a_${suffix}`,
    displayName: "Socket Check A",
    email: `socketcheck_a_${suffix}@example.com`,
    password: "Password123!",
  });
  const r2 = await api("POST", "/api/auth/register", {
    username: `socketcheck_b_${suffix}`,
    displayName: "Socket Check B",
    email: `socketcheck_b_${suffix}@example.com`,
    password: "Password123!",
  });

  if (r1.status !== 201 || r2.status !== 201) {
    throw new Error(`Register failed: ${JSON.stringify({ r1, r2 })}`);
  }

  const t1 = r1.data.accessToken;
  const t2 = r2.data.accessToken;
  const user2Id = r2.data.user.id;

  const roomResp = await api(
    "POST",
    "/api/rooms",
    { name: "socketio-check-room", description: "socket check", type: "group", memberIds: [user2Id] },
    t1
  );
  if (roomResp.status !== 201) {
    throw new Error(`Room create failed: ${JSON.stringify(roomResp)}`);
  }
  const roomId = roomResp.data.room.id;

  const events2 = [];

  const s1 = io(base, { path: "/socket.io", auth: { token: t1 }, transports: ["websocket", "polling"] });
  const s2 = io(base, { path: "/socket.io", auth: { token: t2 }, transports: ["websocket", "polling"] });

  s2.on("typing:start", (p) => events2.push({ type: "typing:start", payload: p }));
  s2.on("typing:stop", (p) => events2.push({ type: "typing:stop", payload: p }));
  s2.on("message:new", (p) => events2.push({ type: "message:new", payload: p }));

  await Promise.all([waitForEvent(s1, "connected"), waitForEvent(s2, "connected")]);

  s1.emit("typing:start", { roomId });
  await new Promise((r) => setTimeout(r, 500));

  const sendResp = await api("POST", `/api/rooms/${roomId}/messages`, { content: "socket regression message" }, t1);
  if (sendResp.status !== 201) {
    throw new Error(`Send message failed: ${JSON.stringify(sendResp)}`);
  }

  await new Promise((r) => setTimeout(r, 1200));

  s1.disconnect();
  s2.disconnect();

  const gotTypingStart = events2.some((e) => e.type === "typing:start" && e.payload?.roomId === roomId);
  const gotMessageNew = events2.some((e) => e.type === "message:new" && e.payload?.roomId === roomId);
  const typingStops = events2.filter((e) => e.type === "typing:stop").length;

  if (verbose) {
    console.log("events2:", events2.map((e) => e.type));
  }

  console.log(
    JSON.stringify(
      {
        base,
        roomId,
        sendStatus: sendResp.status,
        gotTypingStart,
        gotMessageNew,
        typingStopCount: typingStops,
      },
      null,
      2
    )
  );

  if (!gotTypingStart || !gotMessageNew) process.exit(2);
}

main().catch((err) => {
  console.error("socket regression failed:", err.message);
  process.exit(1);
});
