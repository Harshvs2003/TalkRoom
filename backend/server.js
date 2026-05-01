const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const Y = require('yjs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ROOM_ID_LENGTH = 6;
const PRIVATE_ROOM_CODE_LENGTH = 10;
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS || 120000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/talkroom';
const hostsDataPath = path.join(__dirname, 'data', 'hosts.json');
const privateRoomsDataPath = path.join(__dirname, 'data', 'private-rooms.json');

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

let mongoClient = null;
let db = null;
let hostsCollection = null;
let privateRoomsCollection = null;

const normalizePrivateRoomRecord = (room) => {
  const nextRoom = { ...room };
  let migrated = false;

  if (!Array.isArray(nextRoom.meetings)) {
    const seedName = String(nextRoom.name || 'Meeting 1').trim() || 'Meeting 1';
    const now = new Date().toISOString();
    nextRoom.meetings = [
      {
        id: crypto.randomUUID(),
        name: seedName,
        status: 'open',
        startedAt: now,
        closedAt: null,
        participants: [],
      },
    ];
    nextRoom.workspaceName = nextRoom.workspaceName || `${nextRoom.hostDisplayName || nextRoom.hostName || 'Host'} Workspace`;
    migrated = true;
  }

  if (!nextRoom.workspaceName) {
    nextRoom.workspaceName = `${nextRoom.hostDisplayName || nextRoom.hostName || 'Host'} Workspace`;
    migrated = true;
  }

  const normalizedBanned = normalizeBannedParticipants(nextRoom.bannedParticipants);
  if (!Array.isArray(nextRoom.bannedParticipants) || normalizedBanned.length !== nextRoom.bannedParticipants.length) {
    nextRoom.bannedParticipants = normalizedBanned;
    migrated = true;
  }

  if (!Array.isArray(nextRoom.sessionHistory)) {
    nextRoom.sessionHistory = [];
    migrated = true;
  }

  return { record: nextRoom, migrated };
};

const initializeDatabase = async () => {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db();
  if (!db?.databaseName || db.databaseName === 'test') {
    throw new Error('MONGODB_URI must include a database name, e.g. mongodb://127.0.0.1:27017/talkroom');
  }
  hostsCollection = db.collection('hosts');
  privateRoomsCollection = db.collection('privateRooms');

  await Promise.all([
    hostsCollection.createIndex({ email: 1 }, { unique: true }),
    hostsCollection.createIndex({ id: 1 }, { unique: true }),
    privateRoomsCollection.createIndex({ id: 1 }, { unique: true }),
    privateRoomsCollection.createIndex({ roomCode: 1 }, { unique: true }),
    privateRoomsCollection.createIndex({ hostId: 1 }),
  ]);
};

const readArrayJsonFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const migrateLegacyJsonIfNeeded = async () => {
  const [hostsCount, privateRoomsCount] = await Promise.all([
    hostsCollection.countDocuments({}),
    privateRoomsCollection.countDocuments({}),
  ]);

  if (hostsCount === 0) {
    const legacyHosts = readArrayJsonFile(hostsDataPath);
    if (legacyHosts.length > 0) {
      await hostsCollection.insertMany(legacyHosts);
    }
  }

  if (privateRoomsCount === 0) {
    const legacyPrivateRooms = readArrayJsonFile(privateRoomsDataPath);
    if (legacyPrivateRooms.length > 0) {
      const normalized = legacyPrivateRooms.map((room) => normalizePrivateRoomRecord(room).record);
      await privateRoomsCollection.insertMany(normalized);
    }
  }
};

const writeHosts = async (hosts) => {
  const hostIds = hosts.map((host) => host.id).filter(Boolean);
  const ops = hosts.map((host) => ({
    replaceOne: {
      filter: { id: host.id },
      replacement: host,
      upsert: true,
    },
  }));

  if (ops.length > 0) {
    await hostsCollection.bulkWrite(ops, { ordered: false });
  }

  await hostsCollection.deleteMany(hostIds.length ? { id: { $nin: hostIds } } : {});
};

const readHosts = async () => hostsCollection.find({}).toArray();

const writePrivateRooms = async (privateRooms) => {
  const roomIds = privateRooms.map((room) => room.id).filter(Boolean);
  const ops = privateRooms.map((room) => ({
    replaceOne: {
      filter: { id: room.id },
      replacement: room,
      upsert: true,
    },
  }));

  if (ops.length > 0) {
    await privateRoomsCollection.bulkWrite(ops, { ordered: false });
  }

  await privateRoomsCollection.deleteMany(roomIds.length ? { id: { $nin: roomIds } } : {});
};

const readPrivateRooms = async () => {
  const privateRooms = await privateRoomsCollection.find({}).toArray();
  let migrated = false;
  const normalized = privateRooms.map((room) => {
    const { record, migrated: recordMigrated } = normalizePrivateRoomRecord(room);
    if (recordMigrated) {
      migrated = true;
    }
    return record;
  });

  if (migrated) {
    await writePrivateRooms(normalized);
  }

  return normalized;
};

const getOpenMeeting = (privateRoomRecord) =>
  privateRoomRecord.meetings.find((meeting) => meeting.status === 'open') || null;

const toPublicMeeting = (meeting) => ({
  id: meeting.id,
  name: meeting.name,
  status: meeting.status,
  startedAt: meeting.startedAt,
  closedAt: meeting.closedAt || null,
  participantsCount: Array.isArray(meeting.participants) ? meeting.participants.length : 0,
  participants: Array.isArray(meeting.participants)
    ? meeting.participants.map((participant) => ({
        username: participant.username,
        firstJoinedAt: participant.firstJoinedAt,
        lastJoinedAt: participant.lastJoinedAt,
        joinCount: participant.joinCount,
      }))
    : [],
});

const aggregateParticipants = (privateRoomRecord) => {
  const participantMap = new Map();
  const bannedLookup = new Set(normalizeBannedParticipants(privateRoomRecord.bannedParticipants));

  (privateRoomRecord.meetings || []).forEach((meeting) => {
    (meeting.participants || []).forEach((participant) => {
      const key = usernameKey(participant.username);

      if (!key) {
        return;
      }

      const joinCount = Number(participant.joinCount || 0) || 0;
      const existing = participantMap.get(key);

      if (existing) {
        existing.totalJoinCount += joinCount;
        existing.meetingsJoined += 1;
        if (
          participant.lastJoinedAt &&
          (!existing.lastJoinedAt || new Date(participant.lastJoinedAt) > new Date(existing.lastJoinedAt))
        ) {
          existing.lastJoinedAt = participant.lastJoinedAt;
        }
      } else {
        participantMap.set(key, {
          username: participant.username,
          key,
          totalJoinCount: joinCount,
          meetingsJoined: 1,
          firstJoinedAt: participant.firstJoinedAt || null,
          lastJoinedAt: participant.lastJoinedAt || null,
          banned: bannedLookup.has(key),
        });
      }
    });
  });

  return Array.from(participantMap.values()).sort((a, b) => a.username.localeCompare(b.username));
};

const toPublicSessionSnapshot = (snapshot) => ({
  id: snapshot.id,
  privateRoomId: snapshot.privateRoomId,
  roomCode: snapshot.roomCode,
  meetingId: snapshot.meetingId,
  meetingName: snapshot.meetingName,
  capturedAt: snapshot.capturedAt,
  activeUsers: Array.isArray(snapshot.activeUsers) ? snapshot.activeUsers : [],
  docs: Array.isArray(snapshot.docs)
    ? snapshot.docs.map((doc) => ({
        docId: doc.docId,
        name: doc.name,
        type: doc.type,
        ownerUsername: doc.ownerUsername || null,
        text: String(doc.text || ''),
      }))
    : [],
});

const toPublicPrivateRoom = (privateRoomRecord) => ({
  id: privateRoomRecord.id,
  workspaceName: privateRoomRecord.workspaceName,
  roomCode: privateRoomRecord.roomCode,
  hostDisplayName: privateRoomRecord.hostDisplayName,
  createdAt: privateRoomRecord.createdAt,
  updatedAt: privateRoomRecord.updatedAt,
  bannedParticipants: normalizeBannedParticipants(privateRoomRecord.bannedParticipants),
  participantsStatus: aggregateParticipants(privateRoomRecord),
  sessionHistory: Array.isArray(privateRoomRecord.sessionHistory)
    ? privateRoomRecord.sessionHistory.map(toPublicSessionSnapshot)
    : [],
  meetings: (privateRoomRecord.meetings || []).map(toPublicMeeting),
  currentMeeting: getOpenMeeting(privateRoomRecord)
    ? toPublicMeeting(getOpenMeeting(privateRoomRecord))
    : null,
});

const closeOpenMeeting = (privateRoomRecord) => {
  const openMeeting = getOpenMeeting(privateRoomRecord);

  if (!openMeeting) {
    return false;
  }

  openMeeting.status = 'closed';
  openMeeting.closedAt = new Date().toISOString();
  return true;
};

const captureSessionSnapshot = ({ privateRoomRecord, meeting, runtimeRoom }) => {
  if (!privateRoomRecord || !meeting || !runtimeRoom) {
    return;
  }

  const snapshot = {
    id: crypto.randomUUID(),
    privateRoomId: privateRoomRecord.id,
    roomCode: privateRoomRecord.roomCode,
    meetingId: meeting.id,
    meetingName: meeting.name,
    capturedAt: new Date().toISOString(),
    activeUsers: runtimeRoom.users.map((user) => user.username),
    docs: runtimeRoom.docs.map((doc) => ({
      docId: doc.id,
      name: doc.name,
      type: doc.type,
      ownerUsername: doc.ownerUsername || null,
      text: doc.ydoc.getText('content').toString(),
    })),
  };

  if (!Array.isArray(privateRoomRecord.sessionHistory)) {
    privateRoomRecord.sessionHistory = [];
  }

  privateRoomRecord.sessionHistory.unshift(snapshot);
  privateRoomRecord.sessionHistory = privateRoomRecord.sessionHistory.slice(0, 100);
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

const getHostById = async (hostId) => {
  const hosts = await readHosts();
  return hosts.find((host) => host.id === hostId) || null;
};

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

  const hosts = await readHosts();
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
  await writeHosts(hosts);

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

  const hosts = await readHosts();
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

app.get('/api/hosts/me', authMiddleware, async (req, res) => {
  const hosts = await readHosts();
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

app.get('/api/private-rooms', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRooms = (await readPrivateRooms())
    .filter((room) => room.hostId === host.id)
    .map((room) => toPublicPrivateRoom(room));

  res.status(200).json({ ok: true, privateRooms });
});

app.post('/api/private-rooms', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const meetingName = String(req.body?.meetingName || req.body?.name || '').trim();
  const workspaceName = String(req.body?.workspaceName || '').trim();
  const joinPasscode = String(req.body?.joinPasscode || '');
  const hostDisplayName = String(req.body?.hostDisplayName || host.name).trim();

  if (!meetingName) {
    res.status(400).json({ ok: false, error: 'Meeting name is required' });
    return;
  }

  if (joinPasscode.length < 4) {
    res.status(400).json({ ok: false, error: 'Join passcode must be at least 4 characters' });
    return;
  }

  const privateRooms = await readPrivateRooms();
  const roomCode = await createUniquePrivateRoomCode();
  const joinPasscodeHash = await bcrypt.hash(joinPasscode, BCRYPT_SALT_ROUNDS);
  const now = new Date().toISOString();
  const firstMeeting = {
    id: crypto.randomUUID(),
    name: meetingName,
    status: 'open',
    startedAt: now,
    closedAt: null,
    participants: [],
  };

  const newPrivateRoom = {
    id: crypto.randomUUID(),
    hostId: host.id,
    hostName: host.name,
    hostDisplayName: hostDisplayName || host.name,
    workspaceName: workspaceName || `${hostDisplayName || host.name} Workspace`,
    roomCode,
    joinPasscodeHash,
    createdAt: now,
    updatedAt: now,
    bannedParticipants: [],
    sessionHistory: [],
    meetings: [firstMeeting],
  };

  privateRooms.push(newPrivateRoom);
  await writePrivateRooms(privateRooms);
  ensureRuntimeRoomFromPrivateRecord(newPrivateRoom);

  res.status(201).json({
    ok: true,
    privateRoom: toPublicPrivateRoom(newPrivateRoom),
  });
});

app.post('/api/private-rooms/:privateRoomId/meetings', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const meetingName = String(req.body?.meetingName || '').trim();

  if (!meetingName) {
    res.status(400).json({ ok: false, error: 'Meeting name is required' });
    return;
  }

  const privateRooms = await readPrivateRooms();
  const privateRoom = privateRooms.find((room) => room.id === privateRoomId);

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  const openMeeting = getOpenMeeting(privateRoom);

  if (openMeeting) {
    res.status(409).json({ ok: false, error: 'Close current meeting before starting a new one' });
    return;
  }

  const now = new Date().toISOString();
  privateRoom.meetings.push({
    id: crypto.randomUUID(),
    name: meetingName,
    status: 'open',
    startedAt: now,
    closedAt: null,
    participants: [],
  });
  privateRoom.updatedAt = now;

  await writePrivateRooms(privateRooms);
  ensureRuntimeRoomFromPrivateRecord(privateRoom);

  res.status(201).json({
    ok: true,
    privateRoom: toPublicPrivateRoom(privateRoom),
  });
});

app.post('/api/private-rooms/:privateRoomId/close-meeting', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const privateRooms = await readPrivateRooms();
  const privateRoom = privateRooms.find((room) => room.id === privateRoomId);
  const runtimeRoomId = privateRoom ? normalizeRoomId(privateRoom.roomCode) : '';
  const runtimeRoom = runtimeRoomId ? rooms.get(runtimeRoomId) : null;
  const activeMeetingBeforeClose = privateRoom ? getOpenMeeting(privateRoom) : null;

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  const closed = closeOpenMeeting(privateRoom);

  if (!closed) {
    res.status(409).json({ ok: false, error: 'No open meeting to close' });
    return;
  }

  captureSessionSnapshot({
    privateRoomRecord: privateRoom,
    meeting: activeMeetingBeforeClose,
    runtimeRoom,
  });
  privateRoom.updatedAt = new Date().toISOString();
  await writePrivateRooms(privateRooms);

  if (runtimeRoom) {
    io.to(runtimeRoomId).emit('room-closed', {
      message: 'Host closed this meeting.',
    });
    clearRoomCleanupTimer(runtimeRoomId);
    rooms.delete(runtimeRoomId);
  }

  res.status(200).json({
    ok: true,
    privateRoom: toPublicPrivateRoom(privateRoom),
  });
});

app.get('/api/private-rooms/:privateRoomId/participants', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const privateRoom = (await readPrivateRooms()).find((room) => room.id === privateRoomId);

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  res.status(200).json({
    ok: true,
    privateRoomId: privateRoom.id,
    roomCode: privateRoom.roomCode,
    participants: aggregateParticipants(privateRoom),
    bannedParticipants: normalizeBannedParticipants(privateRoom.bannedParticipants),
  });
});

app.post('/api/private-rooms/:privateRoomId/participants/ban', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const username = normalizeUsername(req.body?.username);
  const usernameLower = usernameKey(username);

  if (!usernameLower) {
    res.status(400).json({ ok: false, error: 'Username is required' });
    return;
  }

  const privateRooms = await readPrivateRooms();
  const privateRoom = privateRooms.find((room) => room.id === privateRoomId);

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  privateRoom.bannedParticipants = normalizeBannedParticipants([
    ...(privateRoom.bannedParticipants || []),
    usernameLower,
  ]);
  privateRoom.updatedAt = new Date().toISOString();
  await writePrivateRooms(privateRooms);

  const runtimeRoom = rooms.get(normalizeRoomId(privateRoom.roomCode));
  if (runtimeRoom) {
    runtimeRoom.bannedUsernames.add(usernameLower);
  }

  res.status(200).json({
    ok: true,
    privateRoom: toPublicPrivateRoom(privateRoom),
  });
});

app.post('/api/private-rooms/:privateRoomId/participants/unban', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const username = normalizeUsername(req.body?.username);
  const usernameLower = usernameKey(username);

  if (!usernameLower) {
    res.status(400).json({ ok: false, error: 'Username is required' });
    return;
  }

  const privateRooms = await readPrivateRooms();
  const privateRoom = privateRooms.find((room) => room.id === privateRoomId);

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  privateRoom.bannedParticipants = normalizeBannedParticipants(privateRoom.bannedParticipants).filter(
    (item) => item !== usernameLower,
  );
  privateRoom.updatedAt = new Date().toISOString();
  await writePrivateRooms(privateRooms);

  const runtimeRoom = rooms.get(normalizeRoomId(privateRoom.roomCode));
  if (runtimeRoom) {
    runtimeRoom.bannedUsernames.delete(usernameLower);
  }

  res.status(200).json({
    ok: true,
    privateRoom: toPublicPrivateRoom(privateRoom),
  });
});

app.get('/api/private-rooms/:privateRoomId/session-history', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const privateRoom = (await readPrivateRooms()).find((room) => room.id === privateRoomId);

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  res.status(200).json({
    ok: true,
    privateRoomId: privateRoom.id,
    roomCode: privateRoom.roomCode,
    sessionHistory: (privateRoom.sessionHistory || []).map(toPublicSessionSnapshot),
  });
});

app.get('/api/private-rooms/:privateRoomId/exports', authMiddleware, async (req, res) => {
  const host = await getHostById(req.auth.sub);

  if (!host) {
    res.status(401).json({ ok: false, error: 'Host account not found' });
    return;
  }

  const privateRoomId = String(req.params.privateRoomId || '').trim();
  const format = String(req.query.format || 'json').trim().toLowerCase();
  const privateRoom = (await readPrivateRooms()).find((room) => room.id === privateRoomId);

  if (!privateRoom || privateRoom.hostId !== host.id) {
    res.status(404).json({ ok: false, error: 'Private room not found' });
    return;
  }

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"${privateRoom.roomCode}-export.json\"`);
    res.status(200).send(
      JSON.stringify(
        {
          room: toPublicPrivateRoom(privateRoom),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (format === 'csv') {
    const rows = [];
    rows.push(['roomCode', 'meetingName', 'meetingStatus', 'participant', 'joinCount', 'firstJoinedAt', 'lastJoinedAt'].join(','));

    (privateRoom.meetings || []).forEach((meeting) => {
      const participants = Array.isArray(meeting.participants) ? meeting.participants : [];

      if (participants.length === 0) {
        rows.push([
          privateRoom.roomCode,
          `"${String(meeting.name || '').replace(/\"/g, '\"\"')}"`,
          meeting.status || '',
          '',
          '0',
          '',
          '',
        ].join(','));
        return;
      }

      participants.forEach((participant) => {
        rows.push([
          privateRoom.roomCode,
          `"${String(meeting.name || '').replace(/\"/g, '\"\"')}"`,
          meeting.status || '',
          `"${String(participant.username || '').replace(/\"/g, '\"\"')}"`,
          String(participant.joinCount || 0),
          participant.firstJoinedAt || '',
          participant.lastJoinedAt || '',
        ].join(','));
      });
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"${privateRoom.roomCode}-export.csv\"`);
    res.status(200).send(rows.join('\n'));
    return;
  }

  res.status(400).json({ ok: false, error: 'Unsupported export format. Use json or csv.' });
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

const createUniqueRoomId = async () => {
  const privateRoomCodes = new Set((await readPrivateRooms()).map((room) => room.roomCode));
  let roomId = generateCode(ROOM_ID_LENGTH);

  while (rooms.has(roomId) || privateRoomCodes.has(roomId)) {
    roomId = generateCode(ROOM_ID_LENGTH);
  }

  return roomId;
};

const createUniquePrivateRoomCode = async () => {
  const privateRooms = await readPrivateRooms();
  let roomCode = generateCode(PRIVATE_ROOM_CODE_LENGTH);

  while (
    privateRooms.some((room) => room.roomCode === roomCode) ||
    rooms.has(roomCode)
  ) {
    roomCode = generateCode(PRIVATE_ROOM_CODE_LENGTH);
  }

  return roomCode;
};

const normalizeRoomId = (value) => String(value || '').trim().toUpperCase();
const normalizeUsername = (value) => String(value || '').trim();
const usernameKey = (value) => normalizeUsername(value).toLowerCase();
const unique = (values) => Array.from(new Set(values));
const normalizeBannedParticipants = (values) =>
  unique(
    (Array.isArray(values) ? values : [])
      .map((value) => usernameKey(value))
      .filter(Boolean),
  );

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
  hostOwnerId: room.hostOwnerId || null,
  roomType: room.roomType || 'temporary',
  currentMeetingName: room.currentMeetingName || null,
  viewMode: room.viewMode,
  users: room.users.map((user) => user.username),
  docs: room.docs.map(toPublicDoc),
});

const createRuntimeRoom = ({
  hostUsername,
  hostOwnerId = null,
  hostSocketId = null,
  roomType = 'temporary',
  isPrivate = false,
  password = null,
  privateRoomId = null,
  activeMeetingId = null,
  currentMeetingName = null,
}) => ({
  users: [],
  text: '',
  isPrivate,
  password,
  hostUsername,
  hostOwnerId,
  hostSocketId,
  roomType,
  privateRoomId,
  activeMeetingId,
  currentMeetingName,
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

const ensureRuntimeRoomFromPrivateRecord = (privateRoomRecord) => {
  const roomId = normalizeRoomId(privateRoomRecord.roomCode);
  const activeMeeting = getOpenMeeting(privateRoomRecord);
  const existing = rooms.get(roomId);

  if (!activeMeeting) {
    return null;
  }

  if (existing) {
    existing.activeMeetingId = activeMeeting.id;
    existing.currentMeetingName = activeMeeting.name;
    existing.isPrivate = true;
    existing.password = privateRoomRecord.joinPasscodeHash;
    existing.bannedUsernames = new Set(normalizeBannedParticipants(privateRoomRecord.bannedParticipants));
    return existing;
  }

  const room = createRuntimeRoom({
    hostUsername: privateRoomRecord.hostDisplayName || privateRoomRecord.hostName || 'Host',
    hostOwnerId: privateRoomRecord.hostId,
    hostSocketId: null,
    roomType: 'private',
    isPrivate: true,
    password: privateRoomRecord.joinPasscodeHash,
    privateRoomId: privateRoomRecord.id,
    activeMeetingId: activeMeeting.id,
    currentMeetingName: activeMeeting.name,
  });
  room.bannedUsernames = new Set(normalizeBannedParticipants(privateRoomRecord.bannedParticipants));

  rooms.set(roomId, room);
  return room;
};

const hydrateRuntimeRoomsFromPrivateRooms = async () => {
  const privateRooms = await readPrivateRooms();
  privateRooms.forEach((privateRoom) => {
    ensureRuntimeRoomFromPrivateRecord(privateRoom);
  });
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

const isHostActor = (room, socket) => {
  if (room.roomType === 'private') {
    if (room.hostOwnerId && socket.data.hostId) {
      return room.hostOwnerId === socket.data.hostId;
    }

    if (room.hostSocketId) {
      return room.hostSocketId === socket.id;
    }
  }

  return room.hostUsername === socket.data.username;
};

const leaveCurrentRoom = async (socket, options = {}) => {
  const explicitLeave = Boolean(options.explicitLeave);
  const roomId = socket.data.roomId;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  const leavingUsername = socket.data.username;

  // If host intentionally leaves via "Leave Room", close room for everyone immediately.
  if (explicitLeave && isHostActor(room, socket)) {
    if (room.roomType === 'private' && room.privateRoomId) {
      const privateRooms = await readPrivateRooms();
      const privateRoom = privateRooms.find((item) => item.id === room.privateRoomId);
      const activeMeetingBeforeClose = privateRoom ? getOpenMeeting(privateRoom) : null;

      if (privateRoom) {
        const closed = closeOpenMeeting(privateRoom);
        if (closed) {
          captureSessionSnapshot({
            privateRoomRecord: privateRoom,
            meeting: activeMeetingBeforeClose,
            runtimeRoom: room,
          });
          privateRoom.updatedAt = new Date().toISOString();
          await writePrivateRooms(privateRooms);
        }
      }
    }

    clearRoomCleanupTimer(roomId);
    io.to(roomId).emit('room-closed', {
      message: 'Host ended this room.',
    });
    rooms.delete(roomId);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.username = null;
    socket.data.hostId = null;
    return;
  }

  room.users = room.users.filter((user) => user.socketId !== socket.id);
  if (leavingUsername) {
    console.log('User left:', roomId, leavingUsername);
    console.log('Users in room:', room.users.length);
  }

  socket.leave(roomId);

  if (room.users.length === 0) {
    if (room.roomType === 'private') {
      clearRoomCleanupTimer(roomId);
    } else {
      scheduleRoomCleanup(roomId);
    }
  } else {
    clearRoomCleanupTimer(roomId);

    if (room.roomType !== 'private' && room.hostUsername === leavingUsername) {
      room.hostUsername = room.users[0].username;
    }

    emitUsersUpdate(roomId);
    emitRoomState(roomId);
  }

  socket.data.roomId = null;
  socket.data.username = null;
  socket.data.hostId = null;
};

io.on('connection', (socket) => {
  socket.on('create-room', async (payload, ack) => {
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

      if ((await readPrivateRooms()).some((room) => room.roomCode === requestedRoomId)) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Room code reserved by a private room' });
        }
        return;
      }
    } else {
      roomId = await createUniqueRoomId();
    }

    rooms.set(
      roomId,
      createRuntimeRoom({
        hostUsername,
        roomType: 'temporary',
        isPrivate: false,
      }),
    );

    if (typeof ack === 'function') {
      ack({ ok: true, roomId, message: 'Room Created' });
    }
  });

  socket.on('join-room', async (payload, ack) => {
    const requestedRoomId = normalizeRoomId(payload?.roomId);
    const username = normalizeUsername(payload?.username);
    const joinPasscode = String(payload?.joinPasscode || '');
    const hostToken = String(payload?.hostToken || '');
    let joiningHostId = null;

    if (hostToken) {
      try {
        const decoded = jwt.verify(hostToken, JWT_SECRET);
        joiningHostId = decoded?.sub || null;
      } catch {
        joiningHostId = null;
      }
    }

    if (!/^[A-Z0-9]{3,12}$/.test(requestedRoomId)) {
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

    const privateRoomRecord = (await readPrivateRooms()).find(
      (room) => normalizeRoomId(room.roomCode) === requestedRoomId,
    );
    const roomId = privateRoomRecord
      ? normalizeRoomId(privateRoomRecord.roomCode)
      : requestedRoomId;
    const normalizedUsernameKey = usernameKey(username);

    if (privateRoomRecord) {
      const passcodeValid = bcrypt.compareSync(joinPasscode, privateRoomRecord.joinPasscodeHash);

      if (!passcodeValid) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'Invalid room passcode' });
        }
        return;
      }

      const runtimeRoom = ensureRuntimeRoomFromPrivateRecord(privateRoomRecord);

      if (!runtimeRoom) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'No active meeting. Host needs to start a new meeting.' });
        }
        return;
      }

      if (normalizeBannedParticipants(privateRoomRecord.bannedParticipants).includes(normalizedUsernameKey)) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'You are not allowed to join this room' });
        }
        return;
      }
    } else if (!rooms.has(roomId)) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Room does not exist' });
      }
      return;
    }

    if (socket.data.roomId && socket.data.roomId !== roomId) {
      await leaveCurrentRoom(socket);
    }

    const room = rooms.get(roomId);
    if (!room) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Room does not exist' });
      }
      return;
    }

    clearRoomCleanupTimer(roomId);
    if (room.roomType === 'private' && privateRoomRecord) {
      room.hostOwnerId = privateRoomRecord.hostId;
      if (joiningHostId && joiningHostId === privateRoomRecord.hostId) {
        room.hostUsername = username;
        room.hostSocketId = socket.id;
      } else if (!room.hostUsername) {
        room.hostUsername = privateRoomRecord.hostDisplayName || privateRoomRecord.hostName || 'Host';
      }

      const privateRooms = await readPrivateRooms();
      const persistedRoom = privateRooms.find((item) => item.id === privateRoomRecord.id);
      const activeMeeting = persistedRoom ? getOpenMeeting(persistedRoom) : null;

      if (persistedRoom && activeMeeting) {
        const now = new Date().toISOString();
        const existingParticipant = activeMeeting.participants.find(
          (participant) => usernameKey(participant.username) === usernameKey(username),
        );

        if (existingParticipant) {
          existingParticipant.lastJoinedAt = now;
          existingParticipant.joinCount = Number(existingParticipant.joinCount || 0) + 1;
        } else {
          activeMeeting.participants.push({
            username,
            firstJoinedAt: now,
            lastJoinedAt: now,
            joinCount: 1,
          });
        }

        persistedRoom.updatedAt = now;
        await writePrivateRooms(privateRooms);
      }
    }
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
    console.log('JOIN:', roomId, username);
    console.log('ROOM USERS:', room.users.length);
    console.log('SOCKET ROOMS:', Array.from(socket.rooms));
    console.log('User joined:', roomId, username);
    console.log('Users in room:', room.users.length);
    socket.data.roomId = roomId;
    socket.data.username = username;
    socket.data.hostId = joiningHostId;

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
        text: room.text || '',
      });
    }
  });

  socket.on('send-changes', (payload) => {
    const roomId = normalizeRoomId(payload?.roomId || socket.data.roomId);
    const text = String(payload?.text ?? payload ?? '');

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    if (socket.data.roomId !== roomId) {
      return;
    }

    const room = rooms.get(roomId);
    room.text = text;
    socket.to(roomId).emit('receive-changes', text);
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

    if (!isHostActor(room, socket)) {
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

  socket.on('remove-participant', async (payload, ack) => {
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

    if (!isHostActor(room, socket)) {
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

    if (room.roomType === 'private' && room.privateRoomId) {
      const privateRooms = await readPrivateRooms();
      const privateRoom = privateRooms.find((item) => item.id === room.privateRoomId);

      if (privateRoom) {
        privateRoom.bannedParticipants = normalizeBannedParticipants([
          ...(privateRoom.bannedParticipants || []),
          usernameKey(targetUsername),
        ]);
        privateRoom.updatedAt = new Date().toISOString();
        await writePrivateRooms(privateRooms);
      }
    }

    const targetUser = room.users.find(
      (user) => usernameKey(user.username) === usernameKey(targetUsername),
    );

    if (targetUser) {
      const targetSocket = io.sockets.sockets.get(targetUser.socketId);

      if (targetSocket) {
        targetSocket.emit('participant-removed', {
          message: `You were removed by host from room ${roomId}.`,
        });
        await leaveCurrentRoom(targetSocket, { explicitLeave: false });
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
    void leaveCurrentRoom(socket, { explicitLeave: true });
  });

  socket.on('disconnect', () => {
    void leaveCurrentRoom(socket, { explicitLeave: false });
  });
});

const bootstrap = async () => {
  await initializeDatabase();
  await migrateLegacyJsonIfNeeded();
  await hydrateRuntimeRoomsFromPrivateRooms();

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Allowed frontend origins: ${allowedOrigins.join(', ')}`);
    console.log(`MongoDB database: ${db.databaseName}`);
  });
};

bootstrap().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
