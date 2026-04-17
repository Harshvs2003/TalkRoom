const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();
const server = http.createServer(app);

const allowedOrigins = FRONTEND_URL.split(',').map((url) => url.trim());

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();

const ensureRoom = (roomId) => {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      content: '',
      users: new Set(),
    });
  }

  return rooms.get(roomId);
};

const emitUserCount = (roomId) => {
  const room = rooms.get(roomId);
  const count = room ? room.users.size : 0;
  io.to(roomId).emit('users-count', count);
};

const leaveRoom = (socket) => {
  const currentRoomId = socket.data.roomId;

  if (!currentRoomId || !rooms.has(currentRoomId)) {
    return;
  }

  const room = rooms.get(currentRoomId);
  room.users.delete(socket.id);
  socket.leave(currentRoomId);

  if (room.users.size === 0) {
    rooms.delete(currentRoomId);
  } else {
    emitUserCount(currentRoomId);
  }

  socket.data.roomId = null;
};

io.on('connection', (socket) => {
  socket.on('join-room', (rawRoomId, ack) => {
    const roomId = String(rawRoomId || '')
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9]{3,12}$/.test(roomId)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Invalid room id' });
      }
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== roomId) {
      leaveRoom(socket);
    }

    const room = ensureRoom(roomId);
    socket.join(roomId);
    room.users.add(socket.id);
    socket.data.roomId = roomId;

    socket.emit('receive-changes', room.content);
    emitUserCount(roomId);

    if (typeof ack === 'function') {
      ack({ ok: true, roomId, content: room.content, usersCount: room.users.size });
    }
  });

  socket.on('send-changes', (nextContent) => {
    const roomId = socket.data.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.content = typeof nextContent === 'string' ? nextContent : '';

    socket.to(roomId).emit('receive-changes', room.content);
  });

  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});