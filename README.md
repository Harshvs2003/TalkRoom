# TalkRoom - Real-Time Collaborative Notepad

A full-stack collaborative notepad using React + TypeScript (frontend), Node.js + Express (backend), Socket.IO, and TailwindCSS.

## Project Structure

- `frontend/` - React + TypeScript + TailwindCSS client
- `backend/` - Express + Socket.IO server

## Environment Variables

1. Backend env:

```bash
cd backend
cp .env.example .env
```

`backend/.env.example`

```env
PORT=4000
FRONTEND_URL=http://localhost:5173
```

2. Frontend env:

```bash
cd frontend
cp .env.example .env
```

`frontend/.env.example`

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