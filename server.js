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

// Waiting queue for video and text matching
let waitingQueue = [];

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Find a match or join waiting queue
  socket.on('find_partner', (data) => {
    // Remove if user is already in queue
    waitingQueue = waitingQueue.filter(user => user.id !== socket.id);

    if (waitingQueue.length > 0) {
      // Match found
      const partner = waitingQueue.shift();
      
      socket.partnerId = partner.id;
      partner.socket.partnerId = socket.id;

      // Notify both clients and decide initiator
      socket.emit('match_found', { partnerId: partner.id, initiator: true });
      partner.socket.emit('match_found', { partnerId: socket.id, initiator: false });
    } else {
      // Add to queue
      waitingQueue.push({ id: socket.id, socket: socket, interests: data?.interests || [] });
      socket.emit('waiting_for_partner');
    }
  });

  // WebRTC Signaling
  socket.on('signal', (data) => {
    if (data.target) {
      io.to(data.target).emit('signal', {
        sender: socket.id,
        signal: data.signal
      });
    }
  });

  // Chat message relay
  socket.on('send_message', (data) => {
    if (socket.partnerId) {
      io.to(socket.partnerId).emit('receive_message', { text: data.text });
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    if (socket.partnerId) {
      io.to(socket.partnerId).emit('partner_typing', { isTyping: data.isTyping });
    }
  });

  // Next / Skip partner
  socket.on('skip_partner', () => {
    cleanUpPartner(socket);
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    waitingQueue = waitingQueue.filter(user => user.id !== socket.id);
    cleanUpPartner(socket);
  });

  function cleanUpPartner(userSocket) {
    if (userSocket.partnerId) {
      io.to(userSocket.partnerId).emit('partner_left');
      const partnerSocket = io.sockets.sockets.get(userSocket.partnerId);
      if (partnerSocket) {
        partnerSocket.partnerId = null;
      }
      userSocket.partnerId = null;
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`StrangerChat Server running on port ${PORT}`);
});
