# TalkRoom - Real-Time Collaborative Notepad

A full-stack collaborative notepad using React + TypeScript (frontend), Node.js + Express (backend), Socket.IO, and TailwindCSS.

## Project Structure

- `frontend/` - React + TypeScript + TailwindCSS client
- `backend/` - Express + Socket.IO server

## Environment Variables

1. Backend env (`backend/.env`):

```bash
cd backend
cat > .env
```

```env
PORT=4000
FRONTEND_URL=http://localhost:5173
EMPTY_ROOM_TTL_MS=120000
JWT_SECRET=change-this-in-production
JWT_EXPIRES_IN=7d
BCRYPT_SALT_ROUNDS=10
MONGODB_URI=mongodb://127.0.0.1:27017/talkroom
```

2. Frontend env (`frontend/.env`):

```bash
cd frontend
cat > .env
```

```env
VITE_BACKEND_URL=http://localhost:4000
```

## Install Dependencies

```bash
cd backend
npm install

cd ../frontend
npm install
```

## Run in Development

Open two terminals.

1. Start backend:

```bash
cd backend
npm run dev
```

2. Start frontend:

```bash
cd frontend
npm run dev
```

Frontend: `http://localhost:5173`
Backend health: `http://localhost:4000/health`

## Production Build (Frontend)

```bash
cd frontend
npm run build
```

## Features Included

- Room create/join (anonymous, no auth)
- Real-time shared textarea with Socket.IO
- In-memory room storage
- Debounced typing sync
- Connected users count per room
- Copy room code button
- Responsive, centered Tailwind UI
- Graceful disconnect handling
