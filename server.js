const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const app=express(),server=http.createServer(app),io=new Server(server);
const PORT=process.env.PORT||3000;
app.use(express.static('public'));
const waitingUsers=[],partners=new Map(),userModes=new Map();
function removeFromQueue(id){const i=waitingUsers.indexOf(id);if(i!==-1)waitingUsers.splice(i,1)}
function disconnectPartner(id,notify=true){const pid=partners.get(id);if(!pid)return;partners.delete(id);partners.delete(pid);if(notify&&io.sockets.sockets.has(pid))io.to(pid).emit('partner-left')}
function findPartner(socket,requestedMode){const mode=requestedMode==='video'?'video':'chat';removeFromQueue(socket.id);disconnectPartner(socket.id);userModes.set(socket.id,mode);
for(let i=0;i<waitingUsers.length;i++){const id=waitingUsers[i];if(id!==socket.id&&io.sockets.sockets.has(id)&&!partners.has(id)&&userModes.get(id)===mode){waitingUsers.splice(i,1);partners.set(socket.id,id);partners.set(id,socket.id);console.log('MATCH FOUND:',socket.id,'with',id,'mode:',mode);socket.emit('matched',{initiator:true,partnerId:id,mode});io.to(id).emit('matched',{initiator:false,partnerId:socket.id,mode});return}}
waitingUsers.push(socket.id);socket.emit('waiting')}
io.on('connection',socket=>{console.log('Connected:',socket.id);socket.on('find-partner',mode=>findPartner(socket,mode));
socket.on('send-message',message=>{const pid=partners.get(socket.id);if(!pid||typeof message!=='string')return;const text=message.trim().slice(0,1000);if(text)io.to(pid).emit('receive-message',text)});
socket.on('video-signal',data=>{const pid=partners.get(socket.id);if(!pid||userModes.get(socket.id)!=='video'||userModes.get(pid)!=='video'||!data||typeof data!=='object')return;if(!['offer','answer','ice-candidate'].includes(data.type)||!data.payload)return;io.to(pid).emit('video-signal',{type:data.type,payload:data.payload})});
socket.on('next-partner',()=>{removeFromQueue(socket.id);disconnectPartner(socket.id);findPartner(socket,userModes.get(socket.id)||'chat')});
socket.on('disconnect',()=>{removeFromQueue(socket.id);disconnectPartner(socket.id);userModes.delete(socket.id);console.log('Disconnected:',socket.id)})});
server.listen(PORT,()=>console.log(`StrangerChat running at http://localhost:${PORT}`));
