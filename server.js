
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const waitingUsers = { chat: new Set(), video: new Set() };
const partners = new Map();
const userModes = new Map();

function broadcastOnlineCount() {
  io.emit("online-count", io.engine.clientsCount);
}

function removeFromQueue(id) {
  waitingUsers.chat.delete(id);
  waitingUsers.video.delete(id);
}

function disconnectPartner(id) {
  const partnerId = partners.get(id);
  if (!partnerId) return;
  partners.delete(id);
  partners.delete(partnerId);
  io.to(partnerId).emit("partner-left");
}

function findPartner(socket, requestedMode) {
  const mode = requestedMode === "video" ? "video" : "chat";
  removeFromQueue(socket.id);
  disconnectPartner(socket.id);
  userModes.set(socket.id, mode);

  for (const id of waitingUsers[mode]) {
    if (id !== socket.id && io.sockets.sockets.has(id)) {
      waitingUsers[mode].delete(id);
      partners.set(socket.id, id);
      partners.set(id, socket.id);
      socket.emit("matched", { partnerId: id, initiator: true });
      io.to(id).emit("matched", {
        partnerId: socket.id,
        initiator: false
      });
      return;
    }
  }

  waitingUsers[mode].add(socket.id);
  socket.emit("waiting");
}

io.on("connection", (socket) => {
  broadcastOnlineCount();

  socket.on("find-partner", (mode) => findPartner(socket, mode));

  socket.on("send-message", (message) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || typeof message !== "string") return;
    const text = message.trim().slice(0, 1000);
    if (text) io.to(partnerId).emit("receive-message", text);
  });

  socket.on("video-signal", (data) => {
    const partnerId = partners.get(socket.id);
    if (
      !partnerId ||
      userModes.get(socket.id) !== "video" ||
      !data ||
      typeof data !== "object" ||
      !["offer", "answer", "ice-candidate"].includes(data.type)
    ) return;

    io.to(partnerId).emit("video-signal", {
      type: data.type,
      payload: data.payload
    });
  });

  socket.on("next-partner", () => {
  removeFromQueue(socket.id);
  disconnectPartner(socket.id);
  findPartner(socket, userModes.get(socket.id) || "chat");
});

socket.on("leave-chat", () => {
  removeFromQueue(socket.id);
  disconnectPartner(socket.id);
});

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    disconnectPartner(socket.id);
    userModes.delete(socket.id);
    broadcastOnlineCount();
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`StrangerChat running on port ${PORT}`);
});
