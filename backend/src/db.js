const { MongoClient } = require('mongodb');

const initializeDatabase = async (mongoUri) => {
  const client = new MongoClient(mongoUri);
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
