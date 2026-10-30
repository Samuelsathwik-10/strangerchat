'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });
app.use(express.static(path.join(__dirname, 'public')));

const waitingQueue = [];

function broadcastOnlineCount() {
  io.emit('online-count', io.engine.clientsCount);
}
function removeFromQueue(id) {
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (waitingQueue[i].id === id) waitingQueue.splice(i, 1);
  }
}
function detachPartner(socket) {
  const partnerId = socket.partnerId;
  if (!partnerId) return null;
  socket.partnerId = null;
  const partner = io.sockets.sockets.get(partnerId);
  if (partner) partner.partnerId = null;
  return partner || null;
}
function findPartner(socket, requestedMode, avoidId = null) {
  const mode = requestedMode === 'video' ? 'video' : 'chat';
  removeFromQueue(socket.id);
  if (socket.partnerId) detachPartner(socket);

  const index = waitingQueue.findIndex(item =>
    item.mode === mode &&
    io.sockets.sockets.has(item.id) &&
    item.id !== socket.id &&
    item.avoidId !== socket.id &&
    item.id !== avoidId
  );
  if (index < 0) {
    socket.chatMode = mode;
    waitingQueue.push({ id: socket.id, mode, avoidId });
    socket.emit('waiting');
    return;
  }

  const waiting = waitingQueue.splice(index, 1)[0];
  const partner = io.sockets.sockets.get(waiting.id);
  if (!partner) return findPartner(socket, mode, avoidId);

  socket.partnerId = partner.id;
  partner.partnerId = socket.id;
  socket.chatMode = partner.chatMode = mode;
  socket.emit('matched', { partnerId: partner.id, initiator: true, mode });
  partner.emit('matched', { partnerId: socket.id, initiator: false, mode });
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);
  broadcastOnlineCount();

  socket.on('find-partner', mode => findPartner(socket, mode));

  socket.on('send-message', raw => {
    if (!socket.partnerId) return;
    const text = String(typeof raw === 'object' ? raw?.text ?? '' : raw).trim().slice(0, 1000);
    if (text) io.to(socket.partnerId).emit('receive-message', text);
  });

  socket.on('typing', data => {
    if (socket.partnerId) {
      io.to(socket.partnerId).emit('partner-typing', Boolean(data?.isTyping ?? data));
    }
  });

  socket.on('video-signal', data => {
    if (socket.partnerId && socket.chatMode === 'video') {
      io.to(socket.partnerId).emit('video-signal', data);
    }
  });

  socket.on('next-partner', () => {
    removeFromQueue(socket.id);
    const previousPartnerId = socket.partnerId || null;
    const previousPartner = detachPartner(socket);
    findPartner(socket, socket.chatMode || 'chat', previousPartnerId);
    if (previousPartner) previousPartner.emit('partner-left', { reason: 'next' });
  });

  socket.on('leave-chat', () => {
    removeFromQueue(socket.id);
    const previousPartner = detachPartner(socket);
    if (previousPartner) previousPartner.emit('partner-left', { reason: 'left' });
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const previousPartner = detachPartner(socket);
    if (previousPartner) previousPartner.emit('partner-left', { reason: 'disconnect' });
    console.log('User disconnected:', socket.id);
    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`StrangerChat server running on port ${PORT}`));
