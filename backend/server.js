const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const Y = require('yjs');
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

const rooms = new Map();

const generateCode = (length) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  return Array.from({ length }, () => {
    const randomIndex = Math.floor(Math.random() * characters.length);
    return characters[randomIndex];
  }).join('');
};

const createUniqueRoomId = () => {
  let roomId = generateCode(ROOM_ID_LENGTH);

  while (rooms.has(roomId)) {
    roomId = generateCode(ROOM_ID_LENGTH);
  }

  return roomId;
};

const normalizeRoomId = (value) => String(value || '').trim().toUpperCase();
const normalizeUsername = (value) => String(value || '').trim();

const sharedDocId = 'shared-main';
const personalDocId = (username) => `personal-${username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

const toPublicDoc = (doc) => ({
  id: doc.id,
  name: doc.name,
  type: doc.type,
  ownerUsername: doc.ownerUsername || null,
});

const toPublicRoomState = (room) => ({
  hostUsername: room.hostUsername,
  viewMode: room.viewMode,
  docs: room.docs.map(toPublicDoc),
});

const emitUsersUpdate = (roomId) => {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  io.to(roomId).emit(
    'users-update',
    room.users.map((user) => user.username),
  );
};

const emitRoomState = (roomId) => {
  const room = rooms.get(roomId);

  if (!room) {
    return;
  }

  io.to(roomId).emit('room-state', toPublicRoomState(room));
};

const ensurePersonalDoc = (room, username) => {
  const docId = personalDocId(username);
  const existing = room.docs.find((doc) => doc.id === docId);

  if (existing) {
    return existing;
  }

  const doc = {
    id: docId,
    name: `${username}'s Card`,
    type: 'personal',
    ownerUsername: username,
    ydoc: new Y.Doc(),
  };

  room.docs.push(doc);
  return doc;
};

const canEditDoc = (doc, username) => {
  if (doc.type === 'shared') {
    return true;
  }

  return doc.ownerUsername === username;
};

const leaveCurrentRoom = (socket) => {
  const roomId = socket.data.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  const leavingUsername = socket.data.username;

  room.users = room.users.filter((user) => user.socketId !== socket.id);

  socket.leave(roomId);

  if (room.users.length === 0) {
    rooms.delete(roomId);
  } else {
    if (room.hostUsername === leavingUsername) {
      room.hostUsername = room.users[0].username;
    }

    emitUsersUpdate(roomId);
    emitRoomState(roomId);
  }

  socket.data.roomId = null;
  socket.data.username = null;
};

io.on('connection', (socket) => {
  socket.on('create-room', (payload, ack) => {
    const requestedRoomId = normalizeRoomId(payload?.roomId);
    const hostUsername = normalizeUsername(payload?.username);
    let roomId = requestedRoomId;

    if (!hostUsername) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Username is required to create a room' });
      }
      return;
    }

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
      hostUsername,
      viewMode: 'single_shared',
      docs: [
        {
          id: sharedDocId,
          name: 'Shared Screen',
          type: 'shared',
          ownerUsername: null,
          ydoc: new Y.Doc(),
        },
      ],
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

    room.users = room.users.filter((user) => user.socketId !== socket.id);
    room.users.push({ socketId: socket.id, username });

    ensurePersonalDoc(room, username);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    emitUsersUpdate(roomId);
    emitRoomState(roomId);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomId,
        users: room.users.map((user) => user.username),
        roomState: toPublicRoomState(room),
        docSnapshots: room.docs.map((doc) => ({
          docId: doc.id,
          update: Array.from(Y.encodeStateAsUpdate(doc.ydoc)),
        })),
      });
    }
  });

  socket.on('set-view-mode', (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const viewMode = payload?.viewMode;

    if (!roomId || !rooms.has(roomId)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Room not found' });
      }
      return;
    }

    if (socket.data.roomId !== roomId) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Not a room member' });
      }
      return;
    }

    const room = rooms.get(roomId);

    if (room.hostUsername !== socket.data.username) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Only host can change view mode' });
      }
      return;
    }

    if (!['single_shared', 'one_each', 'both'].includes(viewMode)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Invalid view mode' });
      }
      return;
    }

    room.viewMode = viewMode;
    emitRoomState(roomId);

    if (typeof ack === 'function') {
      ack({ ok: true, roomState: toPublicRoomState(room) });
    }
  });

  socket.on('yjs-update', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const docId = String(payload?.docId || '').trim();

    if (!roomId || !rooms.has(roomId) || !docId) {
      return;
    }

    if (socket.data.roomId !== roomId) {
      return;
    }

    const room = rooms.get(roomId);
    const doc = room.docs.find((item) => item.id === docId);

    if (!doc || !canEditDoc(doc, socket.data.username)) {
      return;
    }

    const updateArray = payload?.update;

    if (!Array.isArray(updateArray)) {
      return;
    }

    Y.applyUpdate(doc.ydoc, Uint8Array.from(updateArray));

    socket.to(roomId).emit('yjs-update', {
      roomId,
      docId,
      update: updateArray,
    });
  });

  socket.on('awareness-update', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const docId = String(payload?.docId || '').trim();

    if (!roomId || !rooms.has(roomId) || !docId) {
      return;
    }

    if (socket.data.roomId !== roomId) {
      return;
    }

    if (!Array.isArray(payload?.update)) {
      return;
    }

    socket.to(roomId).emit('awareness-update', {
      roomId,
      docId,
      update: payload.update,
    });
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