import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
const USERNAME_STORAGE_KEY = 'talkroom_username';
const TEXT_DEBOUNCE_MS = 180;
const TYPING_IDLE_MS = 500;

type Screen = 'home' | 'created' | 'room';
type CreateMode = 'auto' | 'custom';

type CreateRoomAck = {
  ok: boolean;
  roomId?: string;
  message?: string;
  error?: string;
};

type JoinRoomAck = {
  ok: boolean;
  roomId?: string;
  text?: string;
  users?: string[];
  error?: string;
};

type TypingPayload = {
  username: string;
  isTyping: boolean;
};

function App() {
  const socketRef = useRef<Socket | null>(null);
  const textDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameRef = useRef('');

  const [screen, setScreen] = useState<Screen>('home');
  const [connected, setConnected] = useState(false);

  const [username, setUsername] = useState('');
  const [createMode, setCreateMode] = useState<CreateMode>('auto');
  const [createRoomInput, setCreateRoomInput] = useState('');
  const [joinRoomInput, setJoinRoomInput] = useState('');

  const [createdRoomId, setCreatedRoomId] = useState('');
  const [joinedRoomId, setJoinedRoomId] = useState('');
  const [content, setContent] = useState('');

  const [users, setUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    usernameRef.current = username.trim();
  }, [username]);

  useEffect(() => {
    const storedName = localStorage.getItem(USERNAME_STORAGE_KEY);
    if (storedName) {
      setUsername(storedName);
    }

    const socket = io(BACKEND_URL, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    const handleConnect = () => {
      setConnected(true);
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    const handleUsersUpdate = (nextUsers: string[]) => {
      setUsers(Array.isArray(nextUsers) ? nextUsers : []);
    };

    const handleTextUpdate = (nextText: string) => {
      setContent(typeof nextText === 'string' ? nextText : '');
    };

    const handleTyping = (payload: TypingPayload) => {
      if (!payload?.username || payload.username === usernameRef.current) {
        return;
      }

      setTypingUsers((prev) => {
        if (payload.isTyping) {
          return prev.includes(payload.username) ? prev : [...prev, payload.username];
        }

        return prev.filter((name) => name !== payload.username);
      });
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('users-update', handleUsersUpdate);
    socket.on('text-update', handleTextUpdate);
    socket.on('typing', handleTyping);

    return () => {
      if (textDebounceRef.current) {
        clearTimeout(textDebounceRef.current);
      }

      if (typingDebounceRef.current) {
        clearTimeout(typingDebounceRef.current);
      }

      socket.emit('leave-room');
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('users-update', handleUsersUpdate);
      socket.off('text-update', handleTextUpdate);
      socket.off('typing', handleTyping);
      socket.disconnect();
    };
  }, []);

  const normalizedCreateRoomCode = useMemo(
    () => createRoomInput.trim().toUpperCase(),
    [createRoomInput],
  );
  const normalizedJoinRoomCode = useMemo(
    () => joinRoomInput.trim().toUpperCase(),
    [joinRoomInput],
  );

  const typingText = useMemo(() => {
    if (typingUsers.length === 0) {
      return '';
    }

    if (typingUsers.length === 1) {
      return `${typingUsers[0]} is typing...`;
    }

    return `${typingUsers[0]} and ${typingUsers.length - 1} others are typing...`;
  }, [typingUsers]);

  const validateUsername = useCallback(() => {
    if (!username.trim()) {
      setErrorMessage('Please enter a username first.');
      return false;
    }

    return true;
  }, [username]);

  const validateRoomCode = useCallback((roomCode: string) => /^[A-Z0-9]{3,12}$/.test(roomCode), []);

  const joinRoom = useCallback(
    (roomCode: string) => {
      const socket = socketRef.current;
      if (!socket) {
        setErrorMessage('Socket is not ready yet.');
        return;
      }

      if (!connected) {
        setErrorMessage('Still connecting to server. Please wait a moment.');
        return;
      }

      if (!validateUsername()) {
        return;
      }

      const normalized = roomCode.trim().toUpperCase();
      if (!validateRoomCode(normalized)) {
        setErrorMessage('Invalid room code');
        return;
      }

      setErrorMessage('');
      setStatusMessage('');

      const cleanUsername = username.trim();
      localStorage.setItem(USERNAME_STORAGE_KEY, cleanUsername);

      socket.emit(
        'join-room',
        {
          roomId: normalized,
          username: cleanUsername,
        },
        (ack: JoinRoomAck) => {
          if (!ack?.ok || !ack.roomId) {
            setErrorMessage(ack?.error || 'Unable to join room.');
            return;
          }

          setJoinedRoomId(ack.roomId);
          setJoinRoomInput(ack.roomId);
          setContent(ack.text || '');
          setUsers(Array.isArray(ack.users) ? ack.users : []);
          setTypingUsers([]);
          setScreen('room');
          setStatusMessage('Joined room successfully');
        },
      );
    },
    [connected, username, validateRoomCode, validateUsername],
  );

  const handleCreateRoom = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      setErrorMessage('Socket is not ready yet.');
      return;
    }

    if (!connected) {
      setErrorMessage('Still connecting to server. Please wait a moment.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('');

    if (createMode === 'custom' && !validateRoomCode(normalizedCreateRoomCode)) {
      setErrorMessage('Custom room code must be 3-12 letters or numbers.');
      return;
    }

    socket.emit(
      'create-room',
      { roomId: createMode === 'custom' ? normalizedCreateRoomCode : '' },
      (ack: CreateRoomAck) => {
        if (!ack?.ok || !ack.roomId) {
          setErrorMessage(ack?.error || 'Could not create room.');
          return;
        }

        setCreatedRoomId(ack.roomId);
        setJoinRoomInput(ack.roomId);
        setStatusMessage(ack.message || 'Room Created');
        setScreen('created');
      },
    );
  }, [connected, createMode, normalizedCreateRoomCode, validateRoomCode]);

  const handleJoinCreatedRoom = useCallback(() => {
    joinRoom(createdRoomId);
  }, [createdRoomId, joinRoom]);

  const emitTypingSignal = useCallback(
    (isTyping: boolean) => {
      const socket = socketRef.current;
      if (!socket || !joinedRoomId || !username.trim()) {
        return;
      }

      socket.emit('typing', {
        roomId: joinedRoomId,
        username: username.trim(),
        isTyping,
      });
    },
    [joinedRoomId, username],
  );

  const handleTextChange = useCallback(
    (nextText: string) => {
      const socket = socketRef.current;
      setContent(nextText);

      if (!socket || !joinedRoomId) {
        return;
      }

      emitTypingSignal(true);

      if (typingDebounceRef.current) {
        clearTimeout(typingDebounceRef.current);
      }

      typingDebounceRef.current = setTimeout(() => {
        emitTypingSignal(false);
      }, TYPING_IDLE_MS);

      if (textDebounceRef.current) {
        clearTimeout(textDebounceRef.current);
      }

      textDebounceRef.current = setTimeout(() => {
        socket.emit('text-change', {
          roomId: joinedRoomId,
          text: nextText,
        });
      }, TEXT_DEBOUNCE_MS);
    },
    [emitTypingSignal, joinedRoomId],
  );

  const handleCopyCode = useCallback(async () => {
    const code = joinedRoomId || createdRoomId || normalizedJoinRoomCode;
    if (!code) {
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setErrorMessage('Could not copy room code.');
    }
  }, [createdRoomId, joinedRoomId, normalizedJoinRoomCode]);

  const goHome = useCallback(() => {
    emitTypingSignal(false);
    socketRef.current?.emit('leave-room');

    setScreen('home');
    setJoinedRoomId('');
    setUsers([]);
    setTypingUsers([]);
    setContent('');
    setStatusMessage('');
    setErrorMessage('');

    if (textDebounceRef.current) {
      clearTimeout(textDebounceRef.current);
    }

    if (typingDebounceRef.current) {
      clearTimeout(typingDebounceRef.current);
    }
  }, [emitTypingSignal]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_0%_0%,_#d1fae5,_#ecfeff_44%,_#f8fafc_100%)] px-4 py-8 font-sans text-slate-800 md:py-12">
      <section className="mx-auto w-full max-w-5xl rounded-3xl border border-slate-200 bg-white p-6 shadow-panel md:p-8">
        <header className="mb-6 border-b border-slate-100 pb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">TalkRoom</p>
          <h1 className="text-2xl font-bold text-slate-900">Collaborative Notepad</h1>
        </header>

        {screen === 'home' ? (
          <div className="mx-auto flex max-w-xl flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <h2 className="text-xl font-semibold text-slate-900">Home</h2>

            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter username"
              className="h-11 rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
            />

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-sm font-semibold text-slate-700">Create Room</p>
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setCreateMode('auto')}
                  className={createMode === 'auto' ? 'h-10 rounded-lg bg-brand-500 text-sm font-semibold text-white' : 'h-10 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700'}
                >
                  Auto ID
                </button>
                <button
                  type="button"
                  onClick={() => setCreateMode('custom')}
                  className={createMode === 'custom' ? 'h-10 rounded-lg bg-brand-500 text-sm font-semibold text-white' : 'h-10 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700'}
                >
                  Custom ID
                </button>
              </div>

              {createMode === 'custom' ? (
                <input
                  type="text"
                  value={createRoomInput}
                  onChange={(event) => setCreateRoomInput(event.target.value.toUpperCase())}
                  placeholder="Enter custom room code"
                  className="mb-3 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm uppercase tracking-wider outline-none ring-brand-500 transition focus:ring-2"
                />
              ) : null}

              <button
                type="button"
                onClick={handleCreateRoom}
                className="h-11 w-full rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition hover:bg-brand-600"
              >
                Create Room
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-sm font-semibold text-slate-700">Join Room</p>
              <input
                type="text"
                value={joinRoomInput}
                onChange={(event) => setJoinRoomInput(event.target.value.toUpperCase())}
                placeholder="Enter room code to join"
                className="mb-3 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm uppercase tracking-wider outline-none ring-brand-500 transition focus:ring-2"
              />
              <button
                type="button"
                onClick={() => joinRoom(normalizedJoinRoomCode)}
                className="h-11 w-full rounded-xl border border-brand-500 px-4 text-sm font-semibold text-brand-700 transition hover:bg-brand-50"
              >
                Join Room
              </button>
            </div>
          </div>
        ) : null}

        {screen === 'created' ? (
          <div className="mx-auto flex max-w-xl flex-col gap-5 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 shadow-sm md:p-6">
            <h2 className="text-xl font-semibold text-emerald-800">Room Created Successfully</h2>
            <p className="text-sm text-slate-600">Share this room code, then click Join Room to enter.</p>
            <p className="rounded-xl border border-emerald-200 bg-white px-4 py-3 text-center text-3xl font-bold tracking-[0.18em] text-slate-900">
              {createdRoomId}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleCopyCode}
                className="h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                {copied ? 'Copied!' : 'Copy Room Code'}
              </button>
              <button
                type="button"
                onClick={handleJoinCreatedRoom}
                className="h-11 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition hover:bg-brand-600"
              >
                Join Room
              </button>
            </div>
            <button
              type="button"
              onClick={goHome}
              className="h-10 rounded-xl text-sm font-semibold text-slate-600 transition hover:bg-white"
            >
              Back to Home
            </button>
          </div>
        ) : null}

        {screen === 'room' ? (
          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            <aside className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3">
                <span className={connected ? 'rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700' : 'rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-700'}>
                  {connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>

              <div className="mb-4 space-y-2 text-sm">
                <p>
                  Room: <span className="font-semibold">{joinedRoomId}</span>
                </p>
                <p>
                  Username: <span className="font-semibold">{username.trim()}</span>
                </p>
                <p>
                  Users: <span className="font-semibold">{users.length}</span>
                </p>
              </div>

              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">Active Users</h3>
              <ul className="space-y-2 text-sm">
                {users.map((name) => (
                  <li key={name} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="font-medium text-slate-700">{name}</span>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={goHome}
                className="mt-4 h-10 w-full rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                Leave Room
              </button>
            </aside>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <textarea
                value={content}
                onChange={(event) => handleTextChange(event.target.value)}
                placeholder="Start collaborating in real-time..."
                className="h-[56vh] min-h-[320px] w-full resize-y rounded-xl border border-slate-200 p-4 text-sm leading-7 outline-none ring-brand-500 transition focus:ring-2"
              />
              <p className="mt-2 min-h-5 text-sm text-slate-500">{typingText}</p>
            </div>
          </div>
        ) : null}

        {statusMessage ? (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {statusMessage}
          </p>
        ) : null}

        {errorMessage ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
          </p>
        ) : null}
      </section>
    </main>
  );
}

export default App;