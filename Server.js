const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

// In-memory storage for rooms (messages persist while app runs)
const rooms = new Map(); // roomId => { messages: [{text, timestamp}], users: [] }

// Redirect root to random 3-digit room
app.get('/', (req, res) => {
  const roomId = Math.floor(Math.random() * 900 + 100); // 100-999
  res.redirect(`/${roomId}`);
});

// Serve room page with embedded frontend
app.get('/:room', (req, res) => {
  const roomId = req.params.room;
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hayden Meet - Room ${roomId}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #0f0f0f; color: #ddd; margin: 0; padding: 15px; }
    h2 { text-align: center; color: #00cc66; margin-bottom: 10px; }
    #video-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin: 20px 0; }
    video { width: 100%; background: #000; border: 2px solid #333; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.6); }
    #controls { text-align: center; margin: 15px 0; }
    button { background: #00cc66; color: white; border: none; padding: 10px 20px; margin: 5px; border-radius: 6px; cursor: pointer; font-size: 16px; }
    button:hover { background: #00b359; }
    #chat { background: #1a1a1a; padding: 15px; border-radius: 10px; max-width: 700px; margin: 0 auto 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
    #messages { height: 220px; overflow-y: auto; background: #000; padding: 10px; border-radius: 6px; margin-bottom: 10px; }
    #messages p { margin: 6px 0; font-size: 14px; }
    input { width: 70%; padding: 10px; border: 1px solid #444; border-radius: 6px; background: #222; color: #ddd; }
    #status { text-align: center; color: #ffcc00; font-weight: bold; margin-top: 10px; }
    #userCount { font-size: 14px; color: #aaa; }
  </style>
</head>
<body>
  <h2>Room Code: ${roomId} <button onclick="copyCode()">Copy & Share</button> <span id="userCount">(1 user online)</span></h2>
  <div id="video-grid"></div>
  <div id="controls">
    <button id="videoBtn">Mute Video</button>
    <button id="audioBtn">Mute Audio</button>
  </div>
  <div id="chat">
    <div id="messages"></div>
    <input id="messageInput" placeholder="Type a message..." autocomplete="off">
    <button onclick="sendMessage()">Send</button>
  </div>
  <div id="status">Connecting to room...</div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const ROOM_ID = "${roomId}";
    const videoGrid = document.getElementById('video-grid');
    let localStream;
    const myVideo = document.createElement('video');
    myVideo.muted = true;
    let peers = {};
    let videoEnabled = true;
    let audioEnabled = true;
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80' },
        { urls: 'turn:openrelay.metered.ca:443' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp' }
      ]
    };

    // Start media and join
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        localStream = stream;
        addVideoStream(myVideo, stream, 'You (local)');
        socket.emit('join-room', ROOM_ID);
        document.getElementById('status').textContent = 'Connected! Share the room code.';
      })
      .catch(err => {
        document.getElementById('status').textContent = 'Camera/mic access denied: ' + err.message;
      });

    socket.on('user-connected', userId => connectToNewUser(userId));
    socket.on('user-disconnected', userId => {
      if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
        const vid = document.getElementById('vid-' + userId);
        if (vid) vid.remove();
      }
    });
    socket.on('user-count', count => {
      document.getElementById('userCount').textContent = `(${count} users online)`;
    });

    socket.on('chat-history', messages => {
      messages.forEach(m => addMessage(m.text, m.timestamp));
    });

    socket.on('message', m => addMessage(m.text, m.timestamp));

    function connectToNewUser(userId) {
      const pc = new RTCPeerConnection(config);
      peers[userId] = pc;

      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = e => {
        const video = document.createElement('video');
        video.id = 'vid-' + userId;
        video.autoplay = true;
        video.playsinline = true;
        video.srcObject = e.streams[0];
        videoGrid.append(video);
      };

      pc.onicecandidate = e => {
        if (e.candidate) socket.emit('candidate', ROOM_ID, userId, e.candidate);
      };

      pc.createOffer().then(offer => pc.setLocalDescription(offer))
        .then(() => socket.emit('offer', ROOM_ID, userId, pc.localDescription));
    }

    socket.on('offer', (fromId, offer) => {
      const pc = new RTCPeerConnection(config);
      peers[fromId] = pc;

      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      pc.ontrack = e => { /* same as above */ };

      pc.onicecandidate = e => {
        if (e.candidate) socket.emit('candidate', ROOM_ID, fromId, e.candidate);
      };

      pc.setRemoteDescription(offer)
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => socket.emit('answer', ROOM_ID, fromId, pc.localDescription));
    });

    socket.on('answer', (fromId, answer) => peers[fromId].setRemoteDescription(answer));

    socket.on('candidate', (fromId, candidate) => peers[fromId].addIceCandidate(candidate));

    function addVideoStream(video, stream, label = '') {
      video.srcObject = stream;
      video.addEventListener('loadedmetadata', () => video.play());
      videoGrid.append(video);
      // Optional label if wanted
    }

    function addMessage(text, timestamp) {
      const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      document.getElementById('messages').innerHTML += `<p><small>[${time}]</small> ${text}</p>`;
      document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
    }

    function sendMessage() {
      const input = document.getElementById('messageInput');
      const msg = input.value.trim();
      if (msg) {
        socket.emit('message', ROOM_ID, msg);
        input.value = '';
      }
    }

    document.getElementById('messageInput').addEventListener('keypress', e => {
      if (e.key === 'Enter') sendMessage();
    });

    document.getElementById('videoBtn').onclick = () => {
      videoEnabled = !videoEnabled;
      localStream.getVideoTracks()[0].enabled = videoEnabled;
      document.getElementById('videoBtn').textContent = videoEnabled ? 'Mute Video' : 'Unmute Video';
    };

    document.getElementById('audioBtn').onclick = () => {
      audioEnabled = !audioEnabled;
      localStream.getAudioTracks()[0].enabled = audioEnabled;
      document.getElementById('audioBtn').textContent = audioEnabled ? 'Mute Audio' : 'Unmute Audio';
    };

    function copyCode() {
      navigator.clipboard.writeText(ROOM_ID).then(() => alert('Room code copied! Share it.'));
    }
  </script>
</body>
</html>
  `);
});

// Socket.io backend logic
io.on('connection', socket => {
  socket.on('join-room', roomId => {
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, { messages: [], users: [] });
    const room = rooms.get(roomId);
    room.users.push(socket.id);

    socket.to(roomId).emit('user-connected', socket.id);
    socket.emit('chat-history', room.messages);
    io.to(roomId).emit('user-count', room.users.length);

    socket.on('message', (roomId, msg) => {
      const entry = { text: msg, timestamp: Date.now() };
      room.messages.push(entry);
      io.to(roomId).emit('message', entry);
    });

    socket.on('disconnect', () => {
      room.users = room.users.filter(id => id !== socket.id);
      socket.to(roomId).emit('user-disconnected', socket.id);
      io.to(roomId).emit('user-count', room.users.length);
      if (room.users.length === 0) rooms.delete(roomId);
    });
  });

  // Signaling relays
  socket.on('offer', (roomId, toId, offer) => socket.to(roomId).emit('offer', socket.id, offer));
  socket.on('answer', (roomId, toId, answer) => socket.to(roomId).emit('answer', socket.id, answer));
  socket.on('candidate', (roomId, toId, candidate) => socket.to(roomId).emit('candidate', socket.id, candidate));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server running on port ${port}`));
