
/* StrangerChat: Online User Counter */

// Send the current number of connected users
function broadcastOnlineCount() {
  const onlineUsers = io.of("/").sockets.size;
  io.emit("online-count", onlineUsers);
}

// Update count whenever a user connects
io.on("connection", (socket) => {
  broadcastOnlineCount();

  // Update count whenever a user disconnects
  socket.on("disconnect", () => {
    broadcastOnlineCount();
  });
});
