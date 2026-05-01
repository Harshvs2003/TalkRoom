const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hostsDataPath = path.join(__dirname, '..', 'data', 'hosts.json');
const privateRoomsDataPath = path.join(__dirname, '..', 'data', 'private-rooms.json');

const usernameKey = (value) => String(value || '').trim().toLowerCase();
const unique = (values) => Array.from(new Set(values));
const normalizeBannedParticipants = (values) =>
  unique(
    (Array.isArray(values) ? values : [])
      .map((value) => usernameKey(value))
      .filter(Boolean),
  );

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

const createStores = ({ hostsCollection, privateRoomsCollection }) => {
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

  return {
    readHosts,
    writeHosts,
    readPrivateRooms,
    writePrivateRooms,
    migrateLegacyJsonIfNeeded,
  };
};

module.exports = { createStores };
