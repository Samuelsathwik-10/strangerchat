
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000
});

app.use(express.static(path.join(__dirname, 'public')));

const waitingQueue = [];

function broadcastOnlineCount() {
  io.emit('online-count', io.engine.clientsCount);
}

function removeFromQueue(id) {
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].id === id) {
      waitingQueue.splice(i, 1);
    }
  }
}

function disconnectPartner(socket) {
  const partnerId = socket.partnerId;
  if (!partnerId) return;

  socket.partnerId = null;

  const partner = io.sockets.sockets.get(partnerId);

  if (partner) {
    partner.partnerId = null;
    partner.emit('partner-left');
  }
}

function findPartner(socket, requestedMode) {
  const mode = requestedMode === 'video' ? 'video' : 'chat';

  removeFromQueue(socket.id);

  if (socket.partnerId) {
    disconnectPartner(socket);
  }

  const index = waitingQueue.findIndex(item =>
    item.mode === mode &&
    io.sockets.sockets.has(item.id) &&
    item.id !== socket.id
  );

  if (index === -1) {
    socket.chatMode = mode;

    waitingQueue.push({
      id: socket.id,
      mode
    });

    socket.emit('waiting');
    return;
  }

  const waiting = waitingQueue.splice(index, 1)[0];
  const partner = io.sockets.sockets.get(waiting.id);

  if (!partner) {
    return findPartner(socket, mode);
  }

  socket.partnerId = partner.id;
  partner.partnerId = socket.id;

  socket.chatMode = mode;
  partner.chatMode = mode;

  socket.emit('matched', {
    partnerId: partner.id,
    initiator: true,
    mode
  });

  partner.emit('matched', {
    partnerId: socket.id,
    initiator: false,
    mode
  });
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  broadcastOnlineCount();

  // Find a stranger
  socket.on('find-partner', mode => {
    findPartner(socket, mode);
  });

  // Send text messages
  socket.on('send-message', raw => {
    if (!socket.partnerId) return;

    const text = String(
      typeof raw === 'object'
        ? raw?.text ?? ''
        : raw
    ).trim().slice(0, 1000);

    if (text) {
      io.to(socket.partnerId).emit('receive-message', text);
    }
  });

  // Typing indicator
  socket.on('typing', data => {
    if (socket.partnerId) {
      io.to(socket.partnerId).emit(
        'partner-typing',
        Boolean(data?.isTyping ?? data)
      );
    }
  });

  // WebRTC video signalling
  socket.on('video-signal', data => {
    if (socket.partnerId && socket.chatMode === 'video') {
      io.to(socket.partnerId).emit('video-signal', data);
    }
  });

  // Next stranger
  socket.on('next-partner', () => {
    removeFromQueue(socket.id);
    disconnectPartner(socket);

    findPartner(socket, socket.chatMode || 'chat');
  });

  // Leave conversation without reconnecting
  socket.on('leave-chat', () => {
    removeFromQueue(socket.id);
    disconnectPartner(socket);
  });

  // User disconnected
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    disconnectPartner(socket);

    console.log('User disconnected:', socket.id);

    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`StrangerChat server running on port ${PORT}`);
});
