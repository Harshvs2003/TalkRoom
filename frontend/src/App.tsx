import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import Quill from 'quill';
import QuillCursors from 'quill-cursors';
import { QuillBinding } from 'y-quill';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import 'quill/dist/quill.snow.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
const USERNAME_STORAGE_KEY = 'talkroom_username';

type Screen = 'home' | 'created' | 'room';
type CreateMode = 'auto' | 'custom';
type RoomMode = 'single_shared' | 'one_each';

type CreateRoomAck = {
  ok: boolean;
  roomId?: string;
  message?: string;
  error?: string;
};

type ScreenInfo = {
  id: string;
  name: string;
  type: 'shared' | 'personal';
  ownerUsername: string | null;
};

type RoomState = {
  hostUsername: string;
  mode: RoomMode;
  screens: ScreenInfo[];
};

type JoinRoomAck = {
  ok: boolean;
  roomId?: string;
  users?: string[];
  roomState?: RoomState;
  defaultScreenId?: string | null;
  initialYDoc?: number[];
  error?: string;
};

type OpenScreenAck = {
  ok: boolean;
  screen?: ScreenInfo;
  initialYDoc?: number[];
  error?: string;
};

type RoomBroadcastPayload = {
  roomId: string;
  screenId: string;
  update: number[];
};

type PendingEditorInit = {
  roomId: string;
  screenId: string;
  initialYDoc: number[];
};

const ROOM_COLORS = ['#0891b2', '#2563eb', '#7c3aed', '#c2410c', '#059669', '#be123c'];

const getUserColor = (username: string) => {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }

  return ROOM_COLORS[Math.abs(hash) % ROOM_COLORS.length];
};

if (!(Quill as { imports?: Record<string, unknown> }).imports?.['modules/cursors']) {
  Quill.register('modules/cursors', QuillCursors);
}

function App() {
  const socketRef = useRef<Socket | null>(null);
  const usernameRef = useRef('');
  const joinedRoomIdRef = useRef('');
  const activeScreenIdRef = useRef('');

  const quillContainerRef = useRef<HTMLDivElement | null>(null);
  const [quillContainerEl, setQuillContainerEl] = useState<HTMLDivElement | null>(null);

  const quillRef = useRef<Quill | null>(null);
  const yDocRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const collabCleanupRef = useRef<(() => void) | null>(null);

  const [screen, setScreen] = useState<Screen>('home');
  const [connected, setConnected] = useState(false);

  const [username, setUsername] = useState('');
  const [createMode, setCreateMode] = useState<CreateMode>('auto');
  const [createRoomInput, setCreateRoomInput] = useState('');
  const [joinRoomInput, setJoinRoomInput] = useState('');

  const [createdRoomId, setCreatedRoomId] = useState('');
  const [joinedRoomId, setJoinedRoomId] = useState('');
  const [activeScreenId, setActiveScreenId] = useState('');

  const [users, setUsers] = useState<string[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [pendingEditorInit, setPendingEditorInit] = useState<PendingEditorInit | null>(null);

  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    usernameRef.current = username.trim();
  }, [username]);

  useEffect(() => {
    joinedRoomIdRef.current = joinedRoomId;
  }, [joinedRoomId]);

  useEffect(() => {
    activeScreenIdRef.current = activeScreenId;
  }, [activeScreenId]);

  const setQuillContainerNode = useCallback((node: HTMLDivElement | null) => {
    quillContainerRef.current = node;
    setQuillContainerEl(node);
  }, []);

  const getScreenById = useCallback(
    (screenId: string) => roomState?.screens.find((item) => item.id === screenId) || null,
    [roomState],
  );

  const canCurrentUserEditScreen = useCallback(
    (screenId: string) => {
      const screenInfo = getScreenById(screenId);

      if (!screenInfo) {
        return false;
      }

      if (screenInfo.type === 'shared') {
        return true;
      }

      return screenInfo.ownerUsername === username.trim();
    },
    [getScreenById, username],
  );

  const destroyCollaboration = useCallback(() => {
    if (collabCleanupRef.current) {
      collabCleanupRef.current();
      collabCleanupRef.current = null;
    }
  }, []);

  const initCollaboration = useCallback(
    (roomId: string, screenId: string, initialYDoc: number[]) => {
      const socket = socketRef.current;
      const container = quillContainerRef.current;

      if (!socket || !container) {
        return false;
      }

      destroyCollaboration();
      container.innerHTML = '';

      const ydoc = new Y.Doc();
      if (Array.isArray(initialYDoc) && initialYDoc.length > 0) {
        Y.applyUpdate(ydoc, Uint8Array.from(initialYDoc), 'remote');
      }

      const ytext = ydoc.getText('shared-note');
      const awareness = new Awareness(ydoc);

      awareness.setLocalStateField('user', {
        name: usernameRef.current || 'Guest',
        color: getUserColor(usernameRef.current || 'Guest'),
      });

      const quill = new Quill(container, {
        theme: 'snow',
        modules: {
          toolbar: false,
          cursors: {
            hideDelayMs: 2200,
            hideSpeedMs: 300,
            transformOnTextChange: true,
          },
          history: {
            userOnly: true,
          },
        },
        placeholder: 'Start writing your shared document...',
      });

      const binding = new QuillBinding(ytext, quill, awareness);
      quill.enable(canCurrentUserEditScreen(screenId));

      const onDocUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote') {
          return;
        }

        socket.emit('yjs-update', {
          roomId,
          screenId,
          update: Array.from(update),
        });
      };

      const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changedClients = [...added, ...updated, ...removed];

        if (changedClients.length === 0) {
          return;
        }

        const update = encodeAwarenessUpdate(awareness, changedClients);
        socket.emit('awareness-update', {
          roomId,
          screenId,
          update: Array.from(update),
        });
      };

      ydoc.on('update', onDocUpdate);
      awareness.on('update', onAwarenessUpdate);

      quillRef.current = quill;
      yDocRef.current = ydoc;
      awarenessRef.current = awareness;

      collabCleanupRef.current = () => {
        awareness.off('update', onAwarenessUpdate);
        ydoc.off('update', onDocUpdate);
        binding.destroy();
        awareness.destroy();
        ydoc.destroy();
        container.innerHTML = '';

        quillRef.current = null;
        yDocRef.current = null;
        awarenessRef.current = null;
      };

      return true;
    },
    [canCurrentUserEditScreen, destroyCollaboration],
  );

  useEffect(() => {
    if (screen !== 'room' || !pendingEditorInit || !quillContainerEl) {
      return;
    }

    const ready = initCollaboration(
      pendingEditorInit.roomId,
      pendingEditorInit.screenId,
      pendingEditorInit.initialYDoc,
    );

    if (ready) {
      setPendingEditorInit(null);
      setErrorMessage('');
    }
  }, [initCollaboration, pendingEditorInit, quillContainerEl, screen]);

  useEffect(() => {
    const quill = quillRef.current;

    if (!quill || !activeScreenId) {
      return;
    }

    quill.enable(canCurrentUserEditScreen(activeScreenId));
  }, [activeScreenId, canCurrentUserEditScreen, roomState]);

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

    const handleRoomState = (nextRoomState: RoomState) => {
      setRoomState(nextRoomState);
    };

    const handleYjsUpdate = (payload: RoomBroadcastPayload) => {
      if (!payload?.roomId || payload.roomId !== joinedRoomIdRef.current) {
        return;
      }

      if (!payload?.screenId || payload.screenId !== activeScreenIdRef.current) {
        return;
      }

      if (!Array.isArray(payload.update) || !yDocRef.current) {
        return;
      }

      Y.applyUpdate(yDocRef.current, Uint8Array.from(payload.update), 'remote');
    };

    const handleAwarenessUpdate = (payload: RoomBroadcastPayload) => {
      if (!payload?.roomId || payload.roomId !== joinedRoomIdRef.current) {
        return;
      }

      if (!payload?.screenId || payload.screenId !== activeScreenIdRef.current) {
        return;
      }

      if (!Array.isArray(payload.update) || !awarenessRef.current) {
        return;
      }

      applyAwarenessUpdate(
        awarenessRef.current,
        Uint8Array.from(payload.update),
        'remote',
      );
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('users-update', handleUsersUpdate);
    socket.on('room-state', handleRoomState);
    socket.on('yjs-update', handleYjsUpdate);
    socket.on('awareness-update', handleAwarenessUpdate);

    return () => {
      socket.emit('leave-room');
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('users-update', handleUsersUpdate);
      socket.off('room-state', handleRoomState);
      socket.off('yjs-update', handleYjsUpdate);
      socket.off('awareness-update', handleAwarenessUpdate);
      socket.disconnect();
      destroyCollaboration();
    };
  }, [destroyCollaboration]);

  useEffect(() => {
    if (!awarenessRef.current || !username.trim()) {
      return;
    }

    awarenessRef.current.setLocalStateField('user', {
      name: username.trim(),
      color: getUserColor(username.trim()),
    });
  }, [username]);

  const normalizedCreateRoomCode = useMemo(
    () => createRoomInput.trim().toUpperCase(),
    [createRoomInput],
  );

  const normalizedJoinRoomCode = useMemo(
    () => joinRoomInput.trim().toUpperCase(),
    [joinRoomInput],
  );

  const isHost = useMemo(
    () => Boolean(roomState && roomState.hostUsername === username.trim()),
    [roomState, username],
  );

  const activeScreen = useMemo(
    () => getScreenById(activeScreenId),
    [activeScreenId, getScreenById],
  );

  const canEditActiveScreen = useMemo(
    () => (activeScreen ? canCurrentUserEditScreen(activeScreen.id) : false),
    [activeScreen, canCurrentUserEditScreen],
  );

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
          if (!ack?.ok || !ack.roomId || !ack.roomState) {
            setErrorMessage(ack?.error || 'Unable to join room.');
            return;
          }

          setJoinedRoomId(ack.roomId);
          setJoinRoomInput(ack.roomId);
          setUsers(Array.isArray(ack.users) ? ack.users : []);
          setRoomState(ack.roomState);
          setScreen('room');
          setStatusMessage('Joined room successfully');

          const nextScreenId = ack.defaultScreenId || ack.roomState.screens[0]?.id || '';
          setActiveScreenId(nextScreenId);

          if (nextScreenId) {
            setPendingEditorInit({
              roomId: ack.roomId,
              screenId: nextScreenId,
              initialYDoc: ack.initialYDoc || [],
            });
          }
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

    if (!validateUsername()) {
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
      {
        roomId: createMode === 'custom' ? normalizedCreateRoomCode : '',
        username: username.trim(),
      },
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
  }, [connected, createMode, normalizedCreateRoomCode, username, validateRoomCode, validateUsername]);

  const handleJoinCreatedRoom = useCallback(() => {
    joinRoom(createdRoomId);
  }, [createdRoomId, joinRoom]);

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

  const handleOpenScreen = useCallback(
    (screenId: string) => {
      const socket = socketRef.current;

      if (!socket || !joinedRoomId) {
        return;
      }

      if (screenId === activeScreenId) {
        return;
      }

      socket.emit('open-screen', { roomId: joinedRoomId, screenId }, (ack: OpenScreenAck) => {
        if (!ack?.ok || !ack.screen) {
          setErrorMessage(ack?.error || 'Could not open screen');
          return;
        }

        setActiveScreenId(ack.screen.id);
        setPendingEditorInit({
          roomId: joinedRoomId,
          screenId: ack.screen.id,
          initialYDoc: ack.initialYDoc || [],
        });
      });
    },
    [activeScreenId, joinedRoomId],
  );

  const handleModeChange = useCallback(
    (mode: RoomMode) => {
      const socket = socketRef.current;

      if (!socket || !joinedRoomId || !isHost) {
        return;
      }

      socket.emit('set-room-mode', { roomId: joinedRoomId, mode }, (ack: { ok: boolean; roomState?: RoomState; error?: string }) => {
        if (!ack?.ok || !ack.roomState) {
          setErrorMessage(ack?.error || 'Could not update mode');
          return;
        }

        setRoomState(ack.roomState);
        setStatusMessage(`Mode updated to ${mode === 'one_each' ? 'One Screen Each' : 'Single Shared'}`);
      });
    },
    [isHost, joinedRoomId],
  );

  const handleAddSharedScreen = useCallback(() => {
    const socket = socketRef.current;

    if (!socket || !joinedRoomId || !isHost) {
      return;
    }

    socket.emit('add-shared-screen', { roomId: joinedRoomId }, (ack: { ok: boolean; screen?: ScreenInfo; error?: string }) => {
      if (!ack?.ok || !ack.screen) {
        setErrorMessage(ack?.error || 'Could not add shared screen');
        return;
      }

      setStatusMessage(`Added ${ack.screen.name}`);
      handleOpenScreen(ack.screen.id);
    });
  }, [handleOpenScreen, isHost, joinedRoomId]);

  const goHome = useCallback(() => {
    socketRef.current?.emit('leave-room');
    destroyCollaboration();

    setScreen('home');
    setJoinedRoomId('');
    setActiveScreenId('');
    setUsers([]);
    setRoomState(null);
    setPendingEditorInit(null);
    setStatusMessage('');
    setErrorMessage('');
  }, [destroyCollaboration]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_0%_0%,_#d1fae5,_#ecfeff_44%,_#f8fafc_100%)] px-4 py-8 font-sans text-slate-800 md:py-12">
      <section className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white p-6 shadow-panel md:p-8">
        <header className="mb-6 border-b border-slate-100 pb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">TalkRoom</p>
          <h1 className="text-2xl font-bold text-slate-900">Collaborative Document</h1>
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
          <div className="grid gap-4 lg:grid-cols-[290px_1fr]">
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
                  Host: <span className="font-semibold">{roomState?.hostUsername}</span>
                </p>
                <p>
                  Users: <span className="font-semibold">{users.length}</span>
                </p>
              </div>

              {isHost ? (
                <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Host Controls</p>
                  <label className="mb-2 block text-xs font-medium text-slate-600">Editing Mode</label>
                  <select
                    value={roomState?.mode || 'single_shared'}
                    onChange={(event) => handleModeChange(event.target.value as RoomMode)}
                    className="mb-2 h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="single_shared">Single Shared Screen</option>
                    <option value="one_each">One Screen Each</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleAddSharedScreen}
                    className="h-10 w-full rounded-lg bg-brand-500 text-sm font-semibold text-white hover:bg-brand-600"
                  >
                    Add Shared Screen
                  </button>
                </div>
              ) : null}

              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">Screens</h3>
              <ul className="mb-4 space-y-2 text-sm">
                {(roomState?.screens || []).map((screenItem) => {
                  const isActive = activeScreenId === screenItem.id;
                  const isEditable = screenItem.type === 'shared' || screenItem.ownerUsername === username.trim();

                  return (
                    <li key={screenItem.id}>
                      <button
                        type="button"
                        onClick={() => handleOpenScreen(screenItem.id)}
                        className={isActive ? 'w-full rounded-lg border border-brand-500 bg-brand-50 px-2 py-2 text-left' : 'w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-left'}
                      >
                        <p className="font-semibold text-slate-700">{screenItem.name}</p>
                        <p className="text-xs text-slate-500">
                          {screenItem.type === 'shared' ? 'Shared' : `Personal: ${screenItem.ownerUsername}`}
                        </p>
                        <p className="text-xs text-slate-500">{isEditable ? 'Editable' : 'Read only'}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>

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

            <div className="rounded-2xl border border-slate-200 bg-slate-100 p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-700">
                  {activeScreen?.name || 'No screen selected'}
                </p>
                <span className={canEditActiveScreen ? 'rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700' : 'rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-600'}>
                  {canEditActiveScreen ? 'You can edit' : 'Read only'}
                </span>
              </div>

              <div className="doc-editor mx-auto max-w-3xl rounded-xl bg-white shadow-sm">
                <div ref={setQuillContainerNode} className="doc-editor-surface" />
              </div>
              <p className="mt-2 text-sm text-slate-500">
                Shared screens are editable by all. Personal screens are editable only by the owner and visible to everyone.
              </p>
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