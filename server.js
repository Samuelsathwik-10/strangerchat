const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

// waiting queues per mode
const waiting = { text: [], video: [] };
const partner = new Map(); // socket.id -> partner socket.id

function removeFromQueues(id) {
  for (const m of Object.keys(waiting)) waiting[m] = waiting[m].filter((s) => s !== id);
}
function broadcastCount() { io.emit("online", io.engine.clientsCount); }

function disconnectPair(id, notify = true) {
  const p = partner.get(id);
  if (p) {
    partner.delete(p);
    if (notify) io.to(p).emit("partner-left");
  }
  partner.delete(id);
}

io.on("connection", (socket) => {
  broadcastCount();

  socket.on("find", (mode) => {
    mode = mode === "video" ? "video" : "text";
    disconnectPair(socket.id);
    removeFromQueues(socket.id);
    const q = waiting[mode];
    let other = null;
    while (q.length && !other) {
      const cand = q.shift();
      if (cand !== socket.id && io.sockets.sockets.has(cand)) other = cand;
    }
    if (other) {
      partner.set(socket.id, other);
      partner.set(other, socket.id);
      io.to(other).emit("matched", { initiator: true, mode });
      socket.emit("matched", { initiator: false, mode });
    } else {
      q.push(socket.id);
      socket.emit("waiting");
    }
  });

  socket.on("signal", (data) => {
    const p = partner.get(socket.id);
    if (p) io.to(p).emit("signal", data);
  });
  socket.on("message", (text) => {
    const p = partner.get(socket.id);
    if (p && typeof text === "string") io.to(p).emit("message", text.slice(0, 1000));
  });
  socket.on("typing", (v) => {
    const p = partner.get(socket.id);
    if (p) io.to(p).emit("typing", !!v);
  });
  socket.on("report", () => { /* hook: log/store reports here */ console.log("report from", socket.id); });
  socket.on("leave", () => { removeFromQueues(socket.id); disconnectPair(socket.id); });
  socket.on("disconnect", () => {
    removeFromQueues(socket.id);
    disconnectPair(socket.id);
    broadcastCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("StrangerChat running on " + PORT));
