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

type AppScreen = 'home' | 'created' | 'room';
type CreateMode = 'auto' | 'custom';
type ViewMode = 'single_shared' | 'one_each' | 'both';
type DocType = 'shared' | 'personal';

type CreateRoomAck = {
  ok: boolean;
  roomId?: string;
  message?: string;
  error?: string;
};

type DocInfo = {
  id: string;
  name: string;
  type: DocType;
  ownerUsername: string | null;
};

type RoomState = {
  hostUsername: string;
  viewMode: ViewMode;
  docs: DocInfo[];
};

type JoinRoomAck = {
  ok: boolean;
  roomId?: string;
  users?: string[];
  roomState?: RoomState;
  docSnapshots?: Array<{ docId: string; update: number[] }>;
  error?: string;
};

type RealtimePayload = {
  roomId: string;
  docId: string;
  update: number[];
};

type DocModel = {
  info: DocInfo;
  ydoc: Y.Doc;
  awareness: Awareness;
};

type EditorInstance = {
  quill: Quill;
  binding: QuillBinding;
  onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  onAwarenessUpdate: (event: { added: number[]; updated: number[]; removed: number[] }) => void;
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
  const roomIdRef = useRef('');
  const usernameRef = useRef('');

  const docModelsRef = useRef(new Map<string, DocModel>());
  const editorInstancesRef = useRef(new Map<string, EditorInstance>());
  const containerMapRef = useRef(new Map<string, HTMLDivElement>());

  const [appScreen, setAppScreen] = useState<AppScreen>('home');
  const [connected, setConnected] = useState(false);

  const [username, setUsername] = useState('');
  const [createMode, setCreateMode] = useState<CreateMode>('auto');
  const [createRoomInput, setCreateRoomInput] = useState('');
  const [joinRoomInput, setJoinRoomInput] = useState('');

  const [createdRoomId, setCreatedRoomId] = useState('');
  const [joinedRoomId, setJoinedRoomId] = useState('');

  const [users, setUsers] = useState<string[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    roomIdRef.current = joinedRoomId;
  }, [joinedRoomId]);

  useEffect(() => {
    usernameRef.current = username.trim();
  }, [username]);

  const canEditDoc = useCallback(
    (doc: DocInfo) => {
      if (doc.type === 'shared') {
        return true;
      }

      return doc.ownerUsername === username.trim();
    },
    [username],
  );

  const destroyAllEditors = useCallback(() => {
    editorInstancesRef.current.forEach((instance, docId) => {
      const model = docModelsRef.current.get(docId);
      if (model) {
        model.awareness.off('update', instance.onAwarenessUpdate);
        model.ydoc.off('update', instance.onDocUpdate);
      }

      instance.binding.destroy();
    });

    editorInstancesRef.current.clear();
    containerMapRef.current.forEach((container) => {
      container.innerHTML = '';
    });
  }, []);

  const destroyAllDocs = useCallback(() => {
    destroyAllEditors();

    docModelsRef.current.forEach((model) => {
      model.awareness.destroy();
      model.ydoc.destroy();
    });

    docModelsRef.current.clear();
  }, [destroyAllEditors]);

  const bindEditorToDoc = useCallback(
    (docId: string) => {
      const socket = socketRef.current;
      const roomId = roomIdRef.current;
      const model = docModelsRef.current.get(docId);
      const container = containerMapRef.current.get(docId);

      if (!socket || !roomId || !model || !container) {
        return;
      }

      if (editorInstancesRef.current.has(docId)) {
        return;
      }

      container.innerHTML = '';

      const quill = new Quill(container, {
        theme: 'snow',
        modules: {
          toolbar: false,
          cursors: {
            hideDelayMs: 2000,
            hideSpeedMs: 250,
            transformOnTextChange: true,
          },
          history: {
            userOnly: true,
          },
        },
        placeholder: 'Write here...',
      });

      quill.enable(canEditDoc(model.info));

      const ytext = model.ydoc.getText('content');
      const binding = new QuillBinding(ytext, quill, model.awareness);

      const onDocUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote') {
          return;
        }

        socket.emit('yjs-update', {
          roomId,
          docId,
          update: Array.from(update),
        });
      };

      const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changedClients = [...added, ...updated, ...removed];

        if (changedClients.length === 0) {
          return;
        }

        const update = encodeAwarenessUpdate(model.awareness, changedClients);

        socket.emit('awareness-update', {
          roomId,
          docId,
          update: Array.from(update),
        });
      };

      model.ydoc.on('update', onDocUpdate);
      model.awareness.on('update', onAwarenessUpdate);

      editorInstancesRef.current.set(docId, {
        quill,
        binding,
        onDocUpdate,
        onAwarenessUpdate,
      });
    },
    [canEditDoc],
  );

  const ensureDocModels = useCallback((nextRoomState: RoomState, snapshots?: Array<{ docId: string; update: number[] }>) => {
    const snapshotMap = new Map((snapshots || []).map((item) => [item.docId, item.update]));
    const existingDocIds = new Set(docModelsRef.current.keys());

    nextRoomState.docs.forEach((docInfo) => {
      const existing = docModelsRef.current.get(docInfo.id);

      if (existing) {
        existing.info = docInfo;
        existingDocIds.delete(docInfo.id);
        return;
      }

      const ydoc = new Y.Doc();
      const snapshot = snapshotMap.get(docInfo.id);

      if (Array.isArray(snapshot) && snapshot.length > 0) {
        Y.applyUpdate(ydoc, Uint8Array.from(snapshot), 'remote');
      }

      const awareness = new Awareness(ydoc);
      awareness.setLocalStateField('user', {
        name: usernameRef.current || 'Guest',
        color: getUserColor(usernameRef.current || 'Guest'),
      });

      docModelsRef.current.set(docInfo.id, {
        info: docInfo,
        ydoc,
        awareness,
      });
    });

    existingDocIds.forEach((docId) => {
      const instance = editorInstancesRef.current.get(docId);
      const model = docModelsRef.current.get(docId);

      if (instance && model) {
        model.awareness.off('update', instance.onAwarenessUpdate);
        model.ydoc.off('update', instance.onDocUpdate);
        instance.binding.destroy();
        editorInstancesRef.current.delete(docId);
      }

      if (model) {
        model.awareness.destroy();
        model.ydoc.destroy();
      }

      docModelsRef.current.delete(docId);
      const container = containerMapRef.current.get(docId);
      if (container) {
        container.innerHTML = '';
      }
      containerMapRef.current.delete(docId);
    });
  }, []);

  const setDocContainer = useCallback(
    (docId: string, node: HTMLDivElement | null) => {
      if (!node) {
        const instance = editorInstancesRef.current.get(docId);
        const model = docModelsRef.current.get(docId);

        if (instance && model) {
          model.awareness.off('update', instance.onAwarenessUpdate);
          model.ydoc.off('update', instance.onDocUpdate);
          instance.binding.destroy();
          editorInstancesRef.current.delete(docId);
        }

        containerMapRef.current.delete(docId);
        return;
      }

      containerMapRef.current.set(docId, node);
      bindEditorToDoc(docId);
    },
    [bindEditorToDoc],
  );

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
      ensureDocModels(nextRoomState);
      setRoomState(nextRoomState);
      nextRoomState.docs.forEach((doc) => bindEditorToDoc(doc.id));
    };

    const handleYjsUpdate = (payload: RealtimePayload) => {
      if (!payload?.roomId || payload.roomId !== roomIdRef.current) {
        return;
      }

      const model = docModelsRef.current.get(payload.docId);
      if (!model || !Array.isArray(payload.update)) {
        return;
      }

      Y.applyUpdate(model.ydoc, Uint8Array.from(payload.update), 'remote');
    };

    const handleAwarenessUpdate = (payload: RealtimePayload) => {
      if (!payload?.roomId || payload.roomId !== roomIdRef.current) {
        return;
      }

      const model = docModelsRef.current.get(payload.docId);
      if (!model || !Array.isArray(payload.update)) {
        return;
      }

      applyAwarenessUpdate(model.awareness, Uint8Array.from(payload.update), 'remote');
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
      destroyAllDocs();
    };
  }, [bindEditorToDoc, destroyAllDocs, ensureDocModels]);

  useEffect(() => {
    docModelsRef.current.forEach((model) => {
      model.awareness.setLocalStateField('user', {
        name: username.trim() || 'Guest',
        color: getUserColor(username.trim() || 'Guest'),
      });
    });

    editorInstancesRef.current.forEach((instance, docId) => {
      const model = docModelsRef.current.get(docId);
      if (!model) {
        return;
      }

      instance.quill.enable(canEditDoc(model.info));
    });
  }, [canEditDoc, username]);

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

  const sharedDoc = useMemo(
    () => roomState?.docs.find((doc) => doc.type === 'shared') || null,
    [roomState],
  );

  const personalDocs = useMemo(
    () => (roomState?.docs || []).filter((doc) => doc.type === 'personal'),
    [roomState],
  );

  const showSharedPane = roomState?.viewMode === 'single_shared' || roomState?.viewMode === 'both';
  const showPersonalGrid = roomState?.viewMode === 'one_each' || roomState?.viewMode === 'both';

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

          destroyAllDocs();
          ensureDocModels(ack.roomState, ack.docSnapshots);
          setRoomState(ack.roomState);
          setJoinedRoomId(ack.roomId);
          setJoinRoomInput(ack.roomId);
          setUsers(Array.isArray(ack.users) ? ack.users : []);
          setAppScreen('room');
          setStatusMessage('Joined room successfully');

          ack.roomState.docs.forEach((doc) => bindEditorToDoc(doc.id));
        },
      );
    },
    [bindEditorToDoc, connected, destroyAllDocs, ensureDocModels, username, validateRoomCode, validateUsername],
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
        setAppScreen('created');
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

  const handleViewModeChange = useCallback(
    (viewMode: ViewMode) => {
      const socket = socketRef.current;

      if (!socket || !joinedRoomId || !isHost) {
        return;
      }

      socket.emit('set-view-mode', { roomId: joinedRoomId, viewMode }, (ack: { ok: boolean; roomState?: RoomState; error?: string }) => {
        if (!ack?.ok || !ack.roomState) {
          setErrorMessage(ack?.error || 'Could not update mode');
          return;
        }

        ensureDocModels(ack.roomState);
        setRoomState(ack.roomState);
        ack.roomState.docs.forEach((doc) => bindEditorToDoc(doc.id));
        setStatusMessage(`Mode switched to ${viewMode.replace(/_/g, ' ')}`);
      });
    },
    [bindEditorToDoc, ensureDocModels, isHost, joinedRoomId],
  );

  const goHome = useCallback(() => {
    socketRef.current?.emit('leave-room');
    destroyAllDocs();

    setAppScreen('home');
    setJoinedRoomId('');
    setUsers([]);
    setRoomState(null);
    setStatusMessage('');
    setErrorMessage('');
  }, [destroyAllDocs]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_0%_0%,_#d1fae5,_#ecfeff_44%,_#f8fafc_100%)] px-4 py-8 font-sans text-slate-800 md:py-12">
      <section className="mx-auto w-full max-w-7xl rounded-3xl border border-slate-200 bg-white p-6 shadow-panel md:p-8">
        <header className="mb-6 border-b border-slate-100 pb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">TalkRoom</p>
          <h1 className="text-2xl font-bold text-slate-900">Collaborative Document</h1>
        </header>

        {appScreen === 'home' ? (
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

        {appScreen === 'created' ? (
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

        {appScreen === 'room' ? (
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
                  <label className="mb-2 block text-xs font-medium text-slate-600">View Mode</label>
                  <select
                    value={roomState?.viewMode || 'single_shared'}
                    onChange={(event) => handleViewModeChange(event.target.value as ViewMode)}
                    className="h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="single_shared">Single Shared Screen</option>
                    <option value="one_each">One Screen Each</option>
                    <option value="both">Both</option>
                  </select>
                </div>
              ) : null}

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

            <div className="space-y-4">
              {showSharedPane && sharedDoc ? (
                <section className="rounded-2xl border border-slate-200 bg-slate-100 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-700">{sharedDoc.name}</p>
                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">Editable by all</span>
                  </div>
                  <div className="doc-editor mx-auto max-w-4xl rounded-xl bg-white shadow-sm">
                    <div ref={(node) => setDocContainer(sharedDoc.id, node)} className="doc-editor-surface" />
                  </div>
                </section>
              ) : null}

              {showPersonalGrid ? (
                <section className="rounded-2xl border border-slate-200 bg-slate-100 p-4">
                  <div className="mb-3">
                    <p className="text-sm font-semibold text-slate-700">Personal Cards</p>
                    <p className="text-xs text-slate-500">Everyone can view all cards. Only owner can edit their card.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {personalDocs.map((doc) => {
                      const editable = canEditDoc(doc);

                      return (
                        <article key={doc.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-700">{doc.name}</p>
                            <span className={editable ? 'rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-700' : 'rounded-full bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600'}>
                              {editable ? 'You can edit' : 'Read only'}
                            </span>
                          </div>
                          <div className="doc-editor-card rounded-lg border border-slate-200">
                            <div ref={(node) => setDocContainer(doc.id, node)} className="doc-editor-surface" />
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}
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