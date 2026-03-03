import WebSocket from "ws";

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
const wsBase = base.replace(/^http/, "ws");
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

function waitForType(ws, type, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    ws.on("message", (d) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.type === type) {
          clearTimeout(timeout);
          resolve(msg);
        }
      } catch {
        // ignore parse failures in test harness
      }
    });
  });
}

async function main() {
  const suffix = Date.now();

  const r1 = await api("POST", "/api/auth/register", {
    username: `wscheck_a_${suffix}`,
    displayName: "WS Check A",
    email: `wscheck_a_${suffix}@example.com`,
    password: "Password123!",
  });
  const r2 = await api("POST", "/api/auth/register", {
    username: `wscheck_b_${suffix}`,
    displayName: "WS Check B",
    email: `wscheck_b_${suffix}@example.com`,
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
    { name: "ws-check-room", description: "ws check", type: "group", memberIds: [user2Id] },
    t1
  );
  if (roomResp.status !== 201) {
    throw new Error(`Room create failed: ${JSON.stringify(roomResp)}`);
  }
  const roomId = roomResp.data.room.id;

  const events2 = [];
  const ws1 = new WebSocket(`${wsBase}/ws?token=${t1}`);
  const ws2 = new WebSocket(`${wsBase}/ws?token=${t2}`);
  ws2.on("message", (d) => {
    try {
      events2.push(JSON.parse(d.toString()));
    } catch {
      // ignore
    }
  });

  await Promise.all([waitForType(ws1, "connected"), waitForType(ws2, "connected")]);

  ws1.send(JSON.stringify({ type: "typing:start", payload: { roomId } }));
  await new Promise((r) => setTimeout(r, 500));

  const sendResp = await api("POST", `/api/rooms/${roomId}/messages`, { content: "ws regression message" }, t1);
  if (sendResp.status !== 201) {
    throw new Error(`Send message failed: ${JSON.stringify(sendResp)}`);
  }

  await new Promise((r) => setTimeout(r, 1200));

  ws1.close();
  ws2.close();

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

  if (!gotTypingStart || !gotMessageNew) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("ws-regression failed:", err.message);
  process.exit(1);
});
