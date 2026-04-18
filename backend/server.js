const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ROOM_ID_LENGTH = 6;

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

// In-memory room store:
// rooms = {
//   roomId: {
//     users: [{ socketId, username }],
//     text: ''
//   }
// }
const rooms = new Map();

const generateRoomId = () => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  return Array.from({ length: ROOM_ID_LENGTH }, () => {
    const randomIndex = Math.floor(Math.random() * characters.length);
    return characters[randomIndex];
  }).join('');
};

const createUniqueRoomId = () => {
  let roomId = generateRoomId();

  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  return roomId;
};

const normalizeRoomId = (value) => String(value || '').trim().toUpperCase();
const normalizeUsername = (value) => String(value || '').trim();

const emitUsersUpdate = (roomId) => {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  const usernames = room.users.map((user) => user.username);
  io.to(roomId).emit('users-update', usernames);
};

const leaveCurrentRoom = (socket) => {
  const roomId = socket.data.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  room.users = room.users.filter((user) => user.socketId !== socket.id);

  socket.leave(roomId);
  emitUsersUpdate(roomId);

  socket.data.roomId = null;
  socket.data.username = null;
};

io.on('connection', (socket) => {
  socket.on('create-room', (payload, ack) => {
    const requestedRoomId = normalizeRoomId(payload?.roomId);
    let roomId = requestedRoomId;

    if (requestedRoomId) {
      if (!/^[A-Z0-9]{3,12}$/.test(requestedRoomId)) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Invalid room code' });
        }
        return;
      }

      if (rooms.has(requestedRoomId)) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Room already exists' });
        }
        return;
      }
    } else {
      roomId = createUniqueRoomId();
    }

    rooms.set(roomId, {
      users: [],
      text: '',
    });

    if (typeof ack === 'function') {
      ack({ ok: true, roomId, message: 'Room Created' });
    }
  });

  socket.on('join-room', (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId);
    const username = normalizeUsername(payload?.username);

    if (!/^[A-Z0-9]{3,12}$/.test(roomId)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Invalid room code' });
      }
      return;
    }

    if (!username) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Username is required' });
      }
      return;
    }

    if (!rooms.has(roomId)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Room does not exist' });
      }
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== roomId) {
      leaveCurrentRoom(socket);
    }

    const room = rooms.get(roomId);
    const usernameTaken = room.users.some(
      (user) => user.username.toLowerCase() === username.toLowerCase(),
    );

    if (usernameTaken) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Username already exists in this room' });
      }
      return;
    }

    // If same socket re-joins same room, remove stale entry before adding again.
    room.users = room.users.filter((user) => user.socketId !== socket.id);

    room.users.push({
      socketId: socket.id,
      username,
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    emitUsersUpdate(roomId);
    socket.emit('text-update', room.text);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomId,
        text: room.text,
        users: room.users.map((user) => user.username),
      });
    }
  });

  socket.on('text-change', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    if (socket.data.roomId !== roomId) {
      return;
    }

    const room = rooms.get(roomId);
    room.text = typeof payload?.text === 'string' ? payload.text : '';

    socket.to(roomId).emit('text-update', room.text);
  });

  socket.on('typing', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    if (socket.data.roomId !== roomId) {
      return;
    }

    const username = normalizeUsername(payload?.username || socket.data.username);
    const isTyping = Boolean(payload?.isTyping);

    if (!username) {
      return;
    }

    socket.to(roomId).emit('typing', { username, isTyping });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
