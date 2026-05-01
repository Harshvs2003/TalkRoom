const { MongoClient } = require('mongodb');

const initializeDatabase = async (mongoUri) => {
  const client = new MongoClient(mongoUri, {
    // Render/Atlas deployments can intermittently fail TLS handshakes on IPv6 paths.
    // Forcing IPv4 makes server selection more stable across platforms.
    family: 4,
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  await client.connect();

  let db = client.db();
  if (!db?.databaseName || db.databaseName === 'test') {
    db = client.db('talkroom');
  }

  const hostsCollection = db.collection('hosts');
  const privateRoomsCollection = db.collection('privateRooms');

  await Promise.all([
    hostsCollection.createIndex({ email: 1 }, { unique: true }),
    hostsCollection.createIndex({ id: 1 }, { unique: true }),
    privateRoomsCollection.createIndex({ id: 1 }, { unique: true }),
    privateRoomsCollection.createIndex({ roomCode: 1 }, { unique: true }),
    privateRoomsCollection.createIndex({ hostId: 1 }),
  ]);

  return {
    client,
    db,
    collections: {
      hostsCollection,
      privateRoomsCollection,
    },
  };
};

module.exports = { initializeDatabase };
