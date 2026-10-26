const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// One waiting queue for users looking for a conversation.
const waitingQueue = [];

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('find-partner', () => {
    // Avoid duplicate queue entries and stale matches.
    removeFromQueue(socket.id);
    if (socket.partnerId) disconnectPartner(socket);

    const index = waitingQueue.findIndex((id) => id !== socket.id && io.sockets.sockets.has(id));
    if (index === -1) {
      waitingQueue.push(socket.id);
      socket.emit('waiting');
      return;
    }

    const partnerId = waitingQueue.splice(index, 1)[0];
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) {
      waitingQueue.push(socket.id);
      socket.emit('waiting');
      return;
    }

    socket.partnerId = partner.id;
    partner.partnerId = socket.id;
    // Exactly one side initiates the WebRTC offer.
    socket.emit('matched', { partnerId: partner.id, initiator: true });
    partner.emit('matched', { partnerId: socket.id, initiator: false });
  });

  // The browser forwards offer, answer, and ICE candidate payloads here.
  socket.on('video-signal', (data) => {
    if (socket.partnerId && data && typeof data === 'object') {
      io.to(socket.partnerId).emit('video-signal', data);
    }
  });

  socket.on('send-message', (text) => {
    if (socket.partnerId && typeof text === 'string') {
      io.to(socket.partnerId).emit('receive-message', text);
    }
  });

  socket.on('next-partner', () => {
    removeFromQueue(socket.id);
    disconnectPartner(socket);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    disconnectPartner(socket);
    console.log(`User disconnected: ${socket.id}`);
  });

  function removeFromQueue(id) {
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      if (waitingQueue[i] === id) waitingQueue.splice(i, 1);
    }
  }

  function disconnectPartner(userSocket) {
    const partnerId = userSocket.partnerId;
    userSocket.partnerId = null;
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.partnerId === userSocket.id) {
      partnerSocket.partnerId = null;
      partnerSocket.emit('partner-left');
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`StrangerChat Server running on port ${PORT}`);
});
