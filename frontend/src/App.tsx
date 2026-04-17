import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
const ROOM_ID_LENGTH = 6;
const TYPING_DEBOUNCE_MS = 120;

type JoinAck = {
  ok: boolean;
  error?: string;
  roomId?: string;
  content?: string;
  usersCount?: number;
};

const createRoomId = () =>
  Array.from({ length: ROOM_ID_LENGTH }, () => {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return characters[Math.floor(Math.random() * characters.length)];
  }).join('');

function App() {
  const socketRef = useRef<Socket | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [roomInput, setRoomInput] = useState('');
  const [roomId, setRoomId] = useState('');
  const [content, setContent] = useState('');
  const [usersCount, setUsersCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const socket = io(BACKEND_URL, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    const handleConnect = () => {
      setConnected(true);
      setError('');
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    const handleReceiveChanges = (incoming: string) => {
      setContent(incoming);
    };

    const handleUsersCount = (count: number) => {
      setUsersCount(count);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('receive-changes', handleReceiveChanges);
    socket.on('users-count', handleUsersCount);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      socket.emit('leave-room');
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('receive-changes', handleReceiveChanges);
      socket.off('users-count', handleUsersCount);
      socket.disconnect();
    };
  }, []);

  const normalizedRoomInput = useMemo(
    () => roomInput.trim().toUpperCase(),
    [roomInput],
  );

  const joinRoom = useCallback((targetRoomId: string) => {
    const socket = socketRef.current;

    if (!socket) {
      return;
    }

    setError('');
    const normalized = targetRoomId.trim().toUpperCase();

    if (!/^[A-Z0-9]{3,12}$/.test(normalized)) {
      setError('Room code must be 3-12 alphanumeric characters.');
      return;
    }

    socket.emit('join-room', normalized, (ack: JoinAck) => {
      if (!ack?.ok || !ack.roomId) {
        setError(ack?.error || 'Unable to join the room.');
        return;
      }

      setRoomId(ack.roomId);
      setRoomInput(ack.roomId);
      setContent(ack.content || '');
      setUsersCount(ack.usersCount || 1);
    });
  }, []);

  const handleCreateRoom = useCallback(() => {
    const newRoomId = createRoomId();
    joinRoom(newRoomId);
  }, [joinRoom]);

  const handleJoinRoom = useCallback(() => {
    joinRoom(normalizedRoomInput);
  }, [joinRoom, normalizedRoomInput]);

  const handleTyping = useCallback(
    (value: string) => {
      setContent(value);

      if (!roomId || !socketRef.current) {
        return;
      }

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        socketRef.current?.emit('send-changes', value);
      }, TYPING_DEBOUNCE_MS);
    },
    [roomId],
  );

  const handleCopyRoomCode = useCallback(async () => {
    if (!roomId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setError('Could not copy room code.');
    }
  }, [roomId]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#d4f7ef,_#f7fbfa_45%,_#ffffff_100%)] px-4 py-10 font-sans text-slate-800">
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-3xl border border-teal-100 bg-white/90 p-6 shadow-panel backdrop-blur md:p-10">
        <header className="space-y-2 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-600">
            TalkRoom Collaborative Notepad
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            Real-time room editor
          </h1>
          <p className="text-sm text-slate-600">
            Create a room or join one with a code. No login needed.
          </p>
        </header>

        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
          <input
            type="text"
            value={roomInput}
            onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
            placeholder="Enter room code"
            className="h-11 rounded-xl border border-teal-200 px-3 text-sm uppercase tracking-wider outline-none ring-brand-500 transition focus:ring-2"
          />
          <button
            type="button"
            onClick={handleCreateRoom}
            className="h-11 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            Create Room
          </button>
          <button
            type="button"
            onClick={handleJoinRoom}
            className="h-11 rounded-xl border border-brand-500 px-4 text-sm font-semibold text-brand-700 transition hover:bg-brand-50"
          >
            Join Room
          </button>
          <button
            type="button"
            onClick={handleCopyRoomCode}
            disabled={!roomId}
            className="h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? 'Copied' : 'Copy Code'}
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm">
          <p>
            Room: <span className="font-semibold">{roomId || 'Not joined'}</span>
          </p>
          <p>
            Status:{' '}
            <span className={connected ? 'font-semibold text-emerald-600' : 'font-semibold text-rose-600'}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </p>
          <p>
            Users: <span className="font-semibold">{usersCount}</span>
          </p>
        </div>

        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <textarea
          value={content}
          onChange={(event) => handleTyping(event.target.value)}
          placeholder={roomId ? 'Start typing...' : 'Join a room to start collaborating...'}
          disabled={!roomId}
          className="h-[52vh] min-h-[320px] w-full resize-y rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-7 text-slate-800 outline-none ring-brand-500 transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-100"
        />
      </section>
    </main>
  );
}

export default App;