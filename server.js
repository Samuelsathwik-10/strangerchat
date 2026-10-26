
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

let waitingQueue = [];

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(user => user.id !== socketId);
}

function endPartner(socket, notifyPartner = true) {
  const partnerId = socket.partnerId;
  socket.partnerId = null;

  if (!partnerId) return;

  const partnerSocket = io.sockets.sockets.get(partnerId);

  if (partnerSocket) {
    partnerSocket.partnerId = null;
    if (notifyPartner) partnerSocket.emit('partner-left');
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('find-partner', (modeValue) => {
    const mode = modeValue === 'video' ? 'video' : 'chat';

    removeFromQueue(socket.id);
    endPartner(socket);

    const index = waitingQueue.findIndex(user =>
      user.id !== socket.id &&
      user.mode === mode &&
      io.sockets.sockets.has(user.id)
    );

    if (index !== -1) {
      const partner = waitingQueue.splice(index, 1)[0];

      socket.partnerId = partner.id;
      partner.socket.partnerId = socket.id;

      socket.emit('matched', {
        partnerId: partner.id,
        initiator: true
      });

      partner.socket.emit('matched', {
        partnerId: socket.id,
        initiator: false
      });

      console.log(`Matched ${socket.id} with ${partner.id} (${mode})`);
    } else {
      waitingQueue.push({ id: socket.id, socket, mode });
      socket.emit('waiting');
    }
  });

  socket.on('video-signal', (data) => {
    if (socket.partnerId && data) {
      io.to(socket.partnerId).emit('video-signal', data);
    }
  });

  socket.on('send-message', (text) => {
    if (socket.partnerId) {
      const message = typeof text === 'string'
        ? text
        : String(text?.text ?? '');

      io.to(socket.partnerId).emit(
        'receive-message',
        message.slice(0, 1000)
      );
    }
  });

  socket.on('next-partner', () => {
    removeFromQueue(socket.id);
    endPartner(socket);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    removeFromQueue(socket.id);
    endPartner(socket);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`StrangerChat Server running on port ${PORT}`);
});
