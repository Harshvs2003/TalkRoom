const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const Y = require('yjs');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ROOM_ID_LENGTH = 6;
const SCREEN_ID_LENGTH = 8;

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

// rooms = {
//   roomId: {
//     users: [{ socketId, username }],
//     hostUsername: string,
//     mode: 'single_shared' | 'one_each',
//     screens: [{ id, name, type, ownerUsername, doc: Y.Doc }]
//   }
// }
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

const createScreenId = (room) => {
  let screenId = generateCode(SCREEN_ID_LENGTH);

  while (room.screens.some((screen) => screen.id === screenId)) {
    screenId = generateCode(SCREEN_ID_LENGTH);
  }

  return screenId;
};

const normalizeRoomId = (value) => String(value || '').trim().toUpperCase();
const normalizeUsername = (value) => String(value || '').trim();

const toPublicScreen = (screen) => ({
  id: screen.id,
  name: screen.name,
  type: screen.type,
  ownerUsername: screen.ownerUsername || null,
});

const toPublicRoomState = (room) => ({
  hostUsername: room.hostUsername,
  mode: room.mode,
  screens: room.screens.map(toPublicScreen),
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

const createScreen = (room, options) => {
  const screen = {
    id: createScreenId(room),
    name: options.name,
    type: options.type,
    ownerUsername: options.ownerUsername || null,
    doc: new Y.Doc(),
  };

  room.screens.push(screen);
  return screen;
};

const ensurePersonalScreen = (room, username) => {
  const existing = room.screens.find(
    (screen) => screen.type === 'personal' && screen.ownerUsername === username,
  );

  if (existing) {
    return existing;
  }

  return createScreen(room, {
    name: `${username}'s Screen`,
    type: 'personal',
    ownerUsername: username,
  });
};

const canEditScreen = (screen, username) => {
  if (screen.type === 'shared') {
    return true;
  }

  return screen.ownerUsername === username;
};

const getDefaultScreenForUser = (room, username) => {
  if (room.mode === 'one_each') {
    const personal = room.screens.find(
      (screen) => screen.type === 'personal' && screen.ownerUsername === username,
    );

    if (personal) {
      return personal;
    }
  }

  const firstShared = room.screens.find((screen) => screen.type === 'shared');
  if (firstShared) {
    return firstShared;
  }

  return room.screens[0] || null;
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

    const room = {
      users: [],
      hostUsername,
      mode: 'single_shared',
      screens: [],
    };

    createScreen(room, {
      name: 'Shared Screen 1',
      type: 'shared',
      ownerUsername: null,
    });

    rooms.set(roomId, room);

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

    if (room.mode === 'one_each') {
      ensurePersonalScreen(room, username);
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    emitUsersUpdate(roomId);
    emitRoomState(roomId);

    const defaultScreen = getDefaultScreenForUser(room, username);
    const initialYDoc = defaultScreen
      ? Array.from(Y.encodeStateAsUpdate(defaultScreen.doc))
      : [];

    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomId,
        users: room.users.map((user) => user.username),
        roomState: toPublicRoomState(room),
        defaultScreenId: defaultScreen ? defaultScreen.id : null,
        initialYDoc,
      });
    }
  });

  socket.on('open-screen', (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const screenId = String(payload?.screenId || '').trim();

    if (!roomId || !rooms.has(roomId) || !screenId) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Invalid screen request' });
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
    const screen = room.screens.find((item) => item.id === screenId);

    if (!screen) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Screen not found' });
      }
      return;
    }

    if (typeof ack === 'function') {
      ack({
        ok: true,
        screen: toPublicScreen(screen),
        initialYDoc: Array.from(Y.encodeStateAsUpdate(screen.doc)),
      });
    }
  });

  socket.on('set-room-mode', (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const mode = payload?.mode;

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
        ack({ ok: false, error: 'Only host can change mode' });
      }
      return;
    }

    if (mode !== 'single_shared' && mode !== 'one_each') {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Invalid mode' });
      }
      return;
    }

    room.mode = mode;

    if (mode === 'one_each') {
      room.users.forEach((user) => {
        ensurePersonalScreen(room, user.username);
      });
    }

    emitRoomState(roomId);

    if (typeof ack === 'function') {
      ack({ ok: true, roomState: toPublicRoomState(room) });
    }
  });

  socket.on('add-shared-screen', (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);

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
        ack({ ok: false, error: 'Only host can add shared screens' });
      }
      return;
    }

    const sharedCount = room.screens.filter((screen) => screen.type === 'shared').length;
    const requestedName = String(payload?.name || '').trim();
    const screenName = requestedName || `Shared Screen ${sharedCount + 1}`;

    const screen = createScreen(room, {
      name: screenName,
      type: 'shared',
      ownerUsername: null,
    });

    emitRoomState(roomId);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        screen: toPublicScreen(screen),
      });
    }
  });

  socket.on('yjs-update', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const screenId = String(payload?.screenId || '').trim();

    if (!roomId || !rooms.has(roomId) || !screenId) {
      return;
    }

    if (socket.data.roomId !== roomId) {
      return;
    }

    const room = rooms.get(roomId);
    const screen = room.screens.find((item) => item.id === screenId);

    if (!screen || !canEditScreen(screen, socket.data.username)) {
      return;
    }

    const updateArray = payload?.update;

    if (!Array.isArray(updateArray)) {
      return;
    }

    Y.applyUpdate(screen.doc, Uint8Array.from(updateArray));

    socket.to(roomId).emit('yjs-update', {
      roomId,
      screenId,
      update: updateArray,
    });
  });

  socket.on('awareness-update', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const screenId = String(payload?.screenId || '').trim();

    if (!roomId || !rooms.has(roomId) || !screenId) {
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
      screenId,
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