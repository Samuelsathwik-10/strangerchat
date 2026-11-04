const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// Optional database (free Upstash Redis) so blocks and reports survive restarts.
const R_URL = process.env.UPSTASH_REDIS_REST_URL, R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: "POST", headers: { Authorization: "Bearer " + R_TOK }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch (e) { return null; }
}
const reqIp = (req) => String(req.headers["cf-connecting-ip"] || req.ip || "?");
const hits = new Map();
function hit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 60000)) hits.delete(k); }, 60000);

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  });
  next();
});
app.use(express.json({ limit: "10kb" }));
app.get("/", (req, res, next) => {
  fs.readFile("public/index.html", "utf8", (err, html) => {
    if (err) return next();
    res.type("html").send(html.replace(/__BASE__/g, baseUrl(req)));
  });
});
app.use(express.static("public"));

/* ---------- small endpoints ---------- */
app.get("/health", (req, res) => res.send("ok")); // ping this with UptimeRobot to keep the site awake
const PAGES = ["/", "/random-video-chat.html", "/talk-to-strangers.html", "/text-chat.html", "/omegle-alternative.html", "/safety.html", "/about.html", "/premium.html", "/free-video-chat.html", "/make-new-friends-online.html", "/faq.html"];
const baseUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
app.get("/robots.txt", (req, res) => res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${baseUrl(req)}/sitemap.xml\n`));
app.get("/sitemap.xml", (req, res) => res.type("application/xml").send(
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PAGES.map((p) => `<url><loc>${baseUrl(req)}${p}</loc></url>`).join("")}</urlset>`));
app.get("/config", (req, res) => res.json({
  contact: process.env.CONTACT_EMAIL || "",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  adsClient: process.env.ADSENSE_CLIENT || "",
  adsSlot: process.env.ADSENSE_SLOT || "",
}));

// Optional Google sign-in. Only shows a name; nothing is stored.
app.post("/auth/google", async (req, res) => {
  try {
    const id = process.env.GOOGLE_CLIENT_ID;
    if (!id) return res.sendStatus(404);
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(String((req.body && req.body.credential) || "")));
    const t = await r.json();
    if (!r.ok || t.aud !== id) return res.sendStatus(401);
    res.json({ name: t.given_name || t.name || "there" });
  } catch (e) { res.sendStatus(500); }
});

// STUN/TURN settings for the browsers.
// Best: METERED_DOMAIN (like yourname.metered.live) + METERED_SECRET_KEY -> short-lived passwords.
// Fallback: TURN_USER + TURN_PASS (fixed), or ICE_SERVERS as a full JSON array.
let tempCache = null;
async function tempTurn() {
  const d = process.env.METERED_DOMAIN, k = process.env.METERED_SECRET_KEY;
  if (!d || !k) return null;
  if (tempCache && tempCache.exp > Date.now()) return tempCache.val;
  try {
    const r = await fetch(`https://${d}/api/v1/turn/credential?secretKey=${encodeURIComponent(k)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiryInSeconds: 7200, label: "strangerchat" }),
    });
    if (!r.ok) return null;
    const c = await r.json();
    if (!c.username || !c.password) return null;
    tempCache = { exp: Date.now() + 3600000, val: { username: c.username, credential: c.password } };
    return tempCache.val;
  } catch (e) { return null; }
}
app.get("/ice", async (req, res) => {
  if (!hit("ice:" + reqIp(req), 30, 60000)) return res.sendStatus(429);
  let servers = [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    if (process.env.ICE_SERVERS) servers = JSON.parse(process.env.ICE_SERVERS);
    else {
      const t = await tempTurn();
      const user = t ? t.username : process.env.TURN_USER, pass = t ? t.credential : process.env.TURN_PASS;
      if (user) {
        const h = process.env.TURN_HOST || "global.relay.metered.ca";
        servers.push({ urls: [`turn:${h}:80`, `turn:${h}:443`, `turns:${h}:443?transport=tcp`], username: user, credential: pass });
      }
    }
  } catch (e) { console.error("ICE_SERVERS is not valid JSON"); }
  res.set("Cache-Control", "no-store").json(servers);
});

/* ---------- moderation ---------- */
const DAY = 24 * 60 * 60 * 1000;
const blocked = new Map();   // ip -> blocked until (ms)
const reportsOn = new Map(); // ip -> Map(reporterIp -> {reason, t})
const recent = [];           // last reports, for the admin page
const ipCount = new Map();   // ip -> open connections

const ipOf = (s) => {
  const h = s.handshake.headers;
  return String(h["cf-connecting-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || s.handshake.address || "?").trim();
};
const isBlocked = (ip) => (blocked.get(ip) || 0) > Date.now();

function addReport(targetIp, reporterIp, reason) {
  const now = Date.now();
  const m = reportsOn.get(targetIp) || new Map();
  for (const [k, v] of m) if (now - v.t > DAY) m.delete(k);
  m.set(reporterIp, { reason, t: now });
  reportsOn.set(targetIp, m);
  const entry = { time: new Date(now).toISOString(), target: targetIp, reporter: reporterIp, reason };
  recent.push(entry); if (recent.length > 200) recent.shift();
  redis(["LPUSH", "reports", JSON.stringify(entry)]); redis(["LTRIM", "reports", 0, 199]);
  fs.appendFile("reports.log", JSON.stringify(entry) + "\n", () => {});
  const limit = reason === "underage" ? 2 : 3; // different people needed, so one troll cannot ban anyone
  if (m.size >= limit) { blocked.set(targetIp, now + DAY); redis(["SET", "block:" + targetIp, "1", "EX", 86400]); return true; }
  return false;
}

const adminOk = (req) => process.env.ADMIN_KEY && (req.query.key === process.env.ADMIN_KEY || (req.body && req.body.key === process.env.ADMIN_KEY));
app.get("/admin/reports", async (req, res) => {
  if (!adminOk(req)) return res.sendStatus(404);
  let list = recent.slice().reverse();
  const stored = await redis(["LRANGE", "reports", 0, 99]);
  if (Array.isArray(stored) && stored.length) list = stored.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  const keys = (await redis(["KEYS", "block:*"])) || [];
  const mem = [...blocked].filter(([, t]) => t > Date.now()).map(([ip, t]) => ({ ip, until: new Date(t).toISOString() }));
  const known = new Set(mem.map((b) => b.ip));
  const extra = keys.map((k) => k.slice(6)).filter((ip) => !known.has(ip)).map((ip) => ({ ip, until: "within 24h" }));
  res.json({ blocked: mem.concat(extra), recent: list, database: !!R_URL });
});
app.post("/admin/block", (req, res) => {
  if (!adminOk(req)) return res.sendStatus(404);
  const ip = String(req.body.ip || "").slice(0, 80);
  const hours = Math.max(0, Math.min(720, Number(req.body.hours) || 0));
  if (!ip) return res.sendStatus(400);
  if (hours) { blocked.set(ip, Date.now() + hours * 3600000); redis(["SET", "block:" + ip, "1", "EX", hours * 3600]); }
  else { blocked.delete(ip); redis(["DEL", "block:" + ip]); }
  res.json({ ok: true });
});

// rate limiter: allow(socket, "message", 6, 5000) -> at most 6 per 5 seconds
function allow(s, key, max, ms) {
  const now = Date.now();
  const r = (s.data.rl = s.data.rl || {});
  const a = (r[key] = (r[key] || []).filter((t) => now - t < ms));
  if (a.length >= max) return false;
  a.push(now); return true;
}
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|me|ly|gg|tv|app)\b)/i;

// automatic text filter: sexual solicitation and "move to another app" spam
const BAD = /\b(nudes?|sex ?chat|cam ?sex|onlyfans|telegram|whatsapp|snap(chat)?|cashapp|send pics?|horny|dick|pussy|boobs?)\b/i;
const score = (a, b) => (a.lang && a.lang === b.lang ? 4 : 0) + (a.region && a.region === b.region ? 2 : 0)
  + a.tags.filter((t) => (b.tags || []).includes(t)).length * 3;

/* ---------- matching ---------- */
const waiting = { text: [], video: [] };
const partner = new Map();
const prefOf = new Map();
const cleanTags = (a) => Array.isArray(a)
  ? a.slice(0, 5).map((x) => String(x).toLowerCase().trim().slice(0, 20)).filter(Boolean) : [];

const removeFromQueues = (id) => { for (const m in waiting) waiting[m] = waiting[m].filter((s) => s !== id); };
const broadcastCount = () => io.emit("online", io.engine.clientsCount);
function disconnectPair(id, notify = true) {
  const p = partner.get(id);
  if (p) { partner.delete(p); if (notify) io.to(p).emit("partner-left"); }
  partner.delete(id);
}

io.on("connection", (socket) => {
  const ip = ipOf(socket);
  if (isBlocked(ip)) { socket.emit("blocked", { until: blocked.get(ip) }); return socket.disconnect(true); }
  const n = (ipCount.get(ip) || 0) + 1;
  if (n > 6) { socket.emit("notice", "Too many open tabs from your network."); return socket.disconnect(true); }
  ipCount.set(ip, n);
  broadcastCount();
  redis(["GET", "block:" + ip]).then((v) => {
    if (!v) return;
    if (!isBlocked(ip)) blocked.set(ip, Date.now() + DAY);
    socket.emit("blocked", {}); socket.disconnect(true);
  });

  socket.on("find", (d) => {
    if (!allow(socket, "find", 8, 10000)) return socket.emit("notice", "Slow down a little.");
    const mode = d && d.mode === "video" ? "video" : "text";
    const me = { tags: cleanTags(d && d.interests), lang: String((d && d.lang) || "").slice(0, 12), region: String((d && d.region) || "").slice(0, 20) };
    prefOf.set(socket.id, me);
    disconnectPair(socket.id);
    removeFromQueues(socket.id);
    waiting[mode] = waiting[mode].filter((id) => io.sockets.sockets.has(id));
    const q = waiting[mode];
    // best match = shared language, region and interests; if none fit, take anyone waiting
    let best = -1, bestScore = -1;
    q.forEach((id, i) => { const sc = score(me, prefOf.get(id) || { tags: [] }); if (sc > bestScore) { best = i; bestScore = sc; } });
    if (best >= 0) {
      const other = q.splice(best, 1)[0];
      const common = ((prefOf.get(other) || { tags: [] }).tags).filter((t) => me.tags.includes(t));
      partner.set(socket.id, other); partner.set(other, socket.id);
      io.to(other).emit("matched", { initiator: true, mode, common });
      socket.emit("matched", { initiator: false, mode, common });
    } else { q.push(socket.id); socket.emit("waiting"); }
  });

  socket.on("signal", (data) => {
    if (!allow(socket, "signal", 200, 10000)) return;
    const p = partner.get(socket.id);
    if (p) io.to(p).emit("signal", data);
  });
  socket.on("message", (text) => {
    const p = partner.get(socket.id);
    if (!p || typeof text !== "string") return;
    if (!allow(socket, "message", 6, 5000)) return socket.emit("notice", "You are sending messages too fast.");
    if (LINK.test(text)) return socket.emit("notice", "Links are not allowed.");
    if (BAD.test(text)) {
      socket.data.strikes = (socket.data.strikes || 0) + 1;
      socket.emit("notice", "That message was blocked by the automatic filter.");
      if (socket.data.strikes >= 5) { blocked.set(ip, Date.now() + 3600000); redis(["SET", "block:" + ip, "1", "EX", 3600]); socket.emit("blocked", {}); socket.disconnect(true); }
      return;
    }
    io.to(p).emit("message", text.slice(0, 1000));
  });
  socket.on("typing", (v) => {
    if (!allow(socket, "typing", 20, 5000)) return;
    const p = partner.get(socket.id);
    if (p) io.to(p).emit("typing", !!v);
  });
  socket.on("report", (reason) => {
    const p = partner.get(socket.id);
    if (!p || !allow(socket, "report", 3, 60000)) return;
    const ok = ["spam", "sexual", "underage", "harassment", "other"];
    const r = ok.includes(reason) ? reason : "other";
    const target = io.sockets.sockets.get(p);
    if (!target) return;
    if (addReport(ipOf(target), ip, r)) { target.emit("blocked", { until: blocked.get(ipOf(target)) }); target.disconnect(true); }
  });
  socket.on("leave", () => { removeFromQueues(socket.id); disconnectPair(socket.id); });
  socket.on("disconnect", () => {
    removeFromQueues(socket.id); disconnectPair(socket.id); prefOf.delete(socket.id);
    const c = (ipCount.get(ip) || 1) - 1; c > 0 ? ipCount.set(ip, c) : ipCount.delete(ip);
    broadcastCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("StrangerChat running on " + PORT));
