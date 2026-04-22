const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Y = require('yjs');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ROOM_ID_LENGTH = 6;
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS || 120000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);

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

const hostsDataDir = path.join(__dirname, 'data');
const hostsDataPath = path.join(hostsDataDir, 'hosts.json');

const ensureHostsStore = () => {
  if (!fs.existsSync(hostsDataDir)) {
    fs.mkdirSync(hostsDataDir, { recursive: true });
  }

  if (!fs.existsSync(hostsDataPath)) {
    fs.writeFileSync(hostsDataPath, '[]', 'utf-8');
  }
};

const readHosts = () => {
  ensureHostsStore();

  try {
    const raw = fs.readFileSync(hostsDataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeHosts = (hosts) => {
  ensureHostsStore();
  fs.writeFileSync(hostsDataPath, JSON.stringify(hosts, null, 2), 'utf-8');
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const toPublicHost = (host) => ({
  id: host.id,
  name: host.name,
  email: host.email,
  createdAt: host.createdAt,
});

const issueAuthToken = (host) =>
  jwt.sign(
    {
      sub: host.id,
      email: host.email,
      name: host.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );

const authMiddleware = (req, res, next) => {
  const authHeader = String(req.headers.authorization || '');

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7).trim();

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
};

app.post('/api/hosts/signup', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!name || !email || !password) {
    res.status(400).json({ ok: false, error: 'Name, email, and password are required' });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'Enter a valid email address' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
    return;
  }

  const hosts = readHosts();
  const existing = hosts.find((host) => host.email === email);

  if (existing) {
    res.status(409).json({ ok: false, error: 'Host account already exists with this email' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  const newHost = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  hosts.push(newHost);
  writeHosts(hosts);

  res.status(201).json({
    ok: true,
    host: toPublicHost(newHost),
    token: issueAuthToken(newHost),
  });
});

app.post('/api/hosts/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'Email and password are required' });
    return;
  }

  const hosts = readHosts();
  const host = hosts.find((item) => item.email === email);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Invalid email or password' });
    return;
  }

  const passwordMatched = await bcrypt.compare(password, host.passwordHash);

  if (!passwordMatched) {
    res.status(401).json({ ok: false, error: 'Invalid email or password' });
    return;
  }

  res.status(200).json({
    ok: true,
    host: toPublicHost(host),
    token: issueAuthToken(host),
  });
});

app.get('/api/hosts/me', authMiddleware, (req, res) => {
  const hosts = readHosts();
  const host = hosts.find((item) => item.id === req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  res.status(200).json({
    ok: true,
    host: toPublicHost(host),
  });
});

app.post('/api/hosts/logout', (_req, res) => {
  res.status(200).json({ ok: true });
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();
const roomCleanupTimers = new Map();

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
const usernameKey = (value) => normalizeUsername(value).toLowerCase();

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

const clearRoomCleanupTimer = (roomId) => {
  const timer = roomCleanupTimers.get(roomId);

  if (timer) {
    clearTimeout(timer);
    roomCleanupTimers.delete(roomId);
  }
};

const scheduleRoomCleanup = (roomId) => {
  clearRoomCleanupTimer(roomId);

  const timer = setTimeout(() => {
    const room = rooms.get(roomId);

    if (!room) {
      roomCleanupTimers.delete(roomId);
      return;
    }

    if (room.users.length === 0) {
      rooms.delete(roomId);
    }

    roomCleanupTimers.delete(roomId);
  }, EMPTY_ROOM_TTL_MS);

  roomCleanupTimers.set(roomId, timer);
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

const leaveCurrentRoom = (socket, options = {}) => {
  const explicitLeave = Boolean(options.explicitLeave);
  const roomId = socket.data.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  const leavingUsername = socket.data.username;

  // If host intentionally leaves via "Leave Room", close room for everyone immediately.
  if (explicitLeave && room.hostUsername === leavingUsername) {
    clearRoomCleanupTimer(roomId);
    io.to(roomId).emit('room-closed', {
      message: 'Host ended this room.',
    });
    rooms.delete(roomId);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.username = null;
    return;
  }

  room.users = room.users.filter((user) => user.socketId !== socket.id);

  socket.leave(roomId);

  if (room.users.length === 0) {
    scheduleRoomCleanup(roomId);
  } else {
    clearRoomCleanupTimer(roomId);

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
      bannedUsernames: new Set(),
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
    clearRoomCleanupTimer(roomId);
    const normalizedUsernameKey = usernameKey(username);

    if (room.bannedUsernames.has(normalizedUsernameKey)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'You are not allowed to join this room' });
      }
      return;
    }

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

  socket.on('remove-participant', (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const targetUsername = normalizeUsername(payload?.targetUsername);
    const requesterUsername = normalizeUsername(socket.data.username);

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

    if (!targetUsername) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Target username is required' });
      }
      return;
    }

    const room = rooms.get(roomId);

    if (room.hostUsername !== requesterUsername) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Only host can remove participants' });
      }
      return;
    }

    if (usernameKey(targetUsername) === usernameKey(requesterUsername)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Host cannot remove self' });
      }
      return;
    }

    room.bannedUsernames.add(usernameKey(targetUsername));

    const targetUser = room.users.find(
      (user) => usernameKey(user.username) === usernameKey(targetUsername),
    );

    if (targetUser) {
      const targetSocket = io.sockets.sockets.get(targetUser.socketId);

      if (targetSocket) {
        targetSocket.emit('participant-removed', {
          message: `You were removed by host from room ${roomId}.`,
        });
        leaveCurrentRoom(targetSocket, { explicitLeave: false });
      }
    }

    if (typeof ack === 'function') {
      ack({ ok: true });
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
    leaveCurrentRoom(socket, { explicitLeave: true });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket, { explicitLeave: false });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
