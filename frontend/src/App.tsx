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

const rawBackendUrl = String(import.meta.env.VITE_BACKEND_URL || '').trim();
const isLocalBackendUrl = /localhost|127\.0\.0\.1/i.test(rawBackendUrl);
const BACKEND_URL = import.meta.env.PROD
  ? (isLocalBackendUrl ? '' : rawBackendUrl)
  : (rawBackendUrl || 'http://localhost:4000');
const USERNAME_STORAGE_KEY = 'talkroom_username';
const REMEMBER_NAME_KEY = 'talkroom_remember_name';
const SESSION_USERNAME_KEY = 'talkroom_session_username';
const LAST_ROOM_KEY = 'talkroom_last_room';
const LAST_ROOM_PASSCODE_KEY = 'talkroom_last_room_passcode';
const HOST_TOKEN_KEY = 'talkroom_host_token';

type AppScreen = 'home' | 'hostAuth' | 'created' | 'room';
type CreateMode = 'auto' | 'custom';
type ViewMode = 'single_shared' | 'one_each' | 'both';
type DocType = 'shared' | 'personal';

type CreateRoomAck = {
  ok: boolean;
  roomId?: string;
  message?: string;
  error?: string;
};

type HostProfile = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
};

type MeetingSummary = {
  id: string;
  name: string;
  status: 'open' | 'closed';
  startedAt: string;
  closedAt: string | null;
  participantsCount: number;
  participants?: Array<{
    username: string;
    firstJoinedAt: string;
    lastJoinedAt: string;
    joinCount: number;
  }>;
};

type PrivateRoom = {
  id: string;
  workspaceName: string;
  roomCode: string;
  hostDisplayName: string;
  createdAt: string;
  updatedAt: string;
  bannedParticipants?: string[];
  participantsStatus?: ParticipantStatus[];
  sessionHistory?: SessionSnapshot[];
  meetings: MeetingSummary[];
  currentMeeting: MeetingSummary | null;
};

type ParticipantStatus = {
  username: string;
  key: string;
  totalJoinCount: number;
  meetingsJoined: number;
  firstJoinedAt: string | null;
  lastJoinedAt: string | null;
  banned: boolean;
};

type SessionSnapshot = {
  id: string;
  privateRoomId: string;
  roomCode: string;
  meetingId: string;
  meetingName: string;
  capturedAt: string;
  activeUsers: string[];
  docs: Array<{
    docId: string;
    name: string;
    type: DocType;
    ownerUsername: string | null;
    text: string;
  }>;
};

type HostDashboardTab =
  | 'create_private_room'
  | 'current_room_joining'
  | 'meeting_history'
  | 'participants_status'
  | 'session_history'
  | 'exports';

type DocInfo = {
  id: string;
  name: string;
  type: DocType;
  ownerUsername: string | null;
};

type RoomState = {
  hostUsername: string;
  hostOwnerId?: string | null;
  roomType?: 'temporary' | 'private';
  currentMeetingName?: string | null;
  viewMode: ViewMode;
  users?: string[];
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

type RoomClosedPayload = {
  message?: string;
};

type ParticipantRemovedPayload = {
  message?: string;
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
  const restoreAttemptedRef = useRef(false);
  const restoreRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const docModelsRef = useRef(new Map<string, DocModel>());
  const editorInstancesRef = useRef(new Map<string, EditorInstance>());
  const containerMapRef = useRef(new Map<string, HTMLDivElement>());

  const [appScreen, setAppScreen] = useState<AppScreen>('home');
  const [connected, setConnected] = useState(false);

  const [rememberName, setRememberName] = useState(() => localStorage.getItem(REMEMBER_NAME_KEY) === '1');
  const [username, setUsername] = useState(() => {
    const remembered = localStorage.getItem(REMEMBER_NAME_KEY) === '1';

    if (remembered) {
      return localStorage.getItem(USERNAME_STORAGE_KEY) || '';
    }

    return sessionStorage.getItem(SESSION_USERNAME_KEY) || '';
  });
  const [createMode, setCreateMode] = useState<CreateMode>('auto');
  const [createRoomInput, setCreateRoomInput] = useState('');
  const [joinRoomInput, setJoinRoomInput] = useState('');
  const [joinRoomPasscodeInput, setJoinRoomPasscodeInput] = useState('');

  const [createdRoomId, setCreatedRoomId] = useState('');
  const [joinedRoomId, setJoinedRoomId] = useState('');

  const [users, setUsers] = useState<string[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);

  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [hostToken, setHostToken] = useState(() => localStorage.getItem(HOST_TOKEN_KEY) || '');
  const [hostProfile, setHostProfile] = useState<HostProfile | null>(null);
  const [hostAuthMode, setHostAuthMode] = useState<'login' | 'signup'>('login');
  const [hostNameInput, setHostNameInput] = useState('');
  const [hostEmailInput, setHostEmailInput] = useState('');
  const [hostPasswordInput, setHostPasswordInput] = useState('');
  const [hostAuthBusy, setHostAuthBusy] = useState(false);
  const [hostAuthMessage, setHostAuthMessage] = useState('');
  const [privateRooms, setPrivateRooms] = useState<PrivateRoom[]>([]);
  const [privateRoomsLoading, setPrivateRoomsLoading] = useState(false);
  const [privateRoomNameInput, setPrivateRoomNameInput] = useState('');
  const [privateRoomPasscodeInput, setPrivateRoomPasscodeInput] = useState('');
  const [newMeetingRoomId, setNewMeetingRoomId] = useState('');
  const [newMeetingNameInput, setNewMeetingNameInput] = useState('');
  const [hostDashboardTab, setHostDashboardTab] = useState<HostDashboardTab>('create_private_room');
  const [selectedPrivateRoomId, setSelectedPrivateRoomId] = useState('');
  const [selectedExportMeetingId, setSelectedExportMeetingId] = useState('');
  const [participantsStatus, setParticipantsStatus] = useState<ParticipantStatus[]>([]);
  const [participantsStatusLoading, setParticipantsStatusLoading] = useState(false);
  const [sessionHistory, setSessionHistory] = useState<SessionSnapshot[]>([]);
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);

  useEffect(() => {
    roomIdRef.current = joinedRoomId;
  }, [joinedRoomId]);

  useEffect(() => {
    usernameRef.current = username.trim();
  }, [username]);

  useEffect(() => {
    localStorage.setItem(REMEMBER_NAME_KEY, rememberName ? '1' : '0');
  }, [rememberName]);

  useEffect(() => {
    const cleanName = username.trim();

    if (cleanName) {
      sessionStorage.setItem(SESSION_USERNAME_KEY, cleanName);
    } else {
      sessionStorage.removeItem(SESSION_USERNAME_KEY);
    }

    if (rememberName) {
      if (cleanName) {
        localStorage.setItem(USERNAME_STORAGE_KEY, cleanName);
      } else {
        localStorage.removeItem(USERNAME_STORAGE_KEY);
      }
    } else {
      localStorage.removeItem(USERNAME_STORAGE_KEY);
    }
  }, [rememberName, username]);

  useEffect(() => {
    if (hostToken) {
      localStorage.setItem(HOST_TOKEN_KEY, hostToken);
    } else {
      localStorage.removeItem(HOST_TOKEN_KEY);
    }
  }, [hostToken]);

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
    if (appScreen !== 'room' || !roomState) {
      return;
    }

    // Ensure editors bind after React has mounted any newly added doc containers.
    const timer = setTimeout(() => {
      roomState.docs.forEach((doc) => bindEditorToDoc(doc.id));
    }, 0);

    return () => clearTimeout(timer);
  }, [appScreen, bindEditorToDoc, roomState]);

  useEffect(() => {
    const socket = io(BACKEND_URL, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    const handleConnect = () => {
      setConnected(true);
      restoreAttemptedRef.current = false;
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    const handleConnectError = () => {
      setConnected(false);
      setErrorMessage(
        `Unable to connect to backend (${BACKEND_URL || 'same-origin'}). Check VITE_BACKEND_URL and backend deployment health.`,
      );
    };

    const handleUsersUpdate = (nextUsers: string[]) => {
      setUsers(Array.isArray(nextUsers) ? nextUsers : []);
    };

    const handleRoomState = (nextRoomState: RoomState) => {
      ensureDocModels(nextRoomState);
      setRoomState(nextRoomState);
      if (Array.isArray(nextRoomState.users)) {
        setUsers(nextRoomState.users);
      }
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

    const handleRoomClosed = (payload: RoomClosedPayload) => {
      destroyAllDocs();
      sessionStorage.removeItem(LAST_ROOM_KEY);
      sessionStorage.removeItem(LAST_ROOM_PASSCODE_KEY);
      setAppScreen('home');
      setJoinedRoomId('');
      setUsers([]);
      setRoomState(null);
      setStatusMessage('');
      setErrorMessage(payload?.message || 'Room was closed by host.');
    };

    const handleParticipantRemoved = (payload: ParticipantRemovedPayload) => {
      destroyAllDocs();
      sessionStorage.removeItem(LAST_ROOM_KEY);
      sessionStorage.removeItem(LAST_ROOM_PASSCODE_KEY);
      setAppScreen('home');
      setJoinedRoomId('');
      setUsers([]);
      setRoomState(null);
      setStatusMessage('');
      setErrorMessage(payload?.message || 'You were removed from this room by host.');
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('users-update', handleUsersUpdate);
    socket.on('room-state', handleRoomState);
    socket.on('yjs-update', handleYjsUpdate);
    socket.on('awareness-update', handleAwarenessUpdate);
    socket.on('room-closed', handleRoomClosed);
    socket.on('participant-removed', handleParticipantRemoved);

    return () => {
      socket.emit('leave-room');
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('users-update', handleUsersUpdate);
      socket.off('room-state', handleRoomState);
      socket.off('yjs-update', handleYjsUpdate);
      socket.off('awareness-update', handleAwarenessUpdate);
      socket.off('room-closed', handleRoomClosed);
      socket.off('participant-removed', handleParticipantRemoved);
      socket.disconnect();
      destroyAllDocs();
    };
  }, [destroyAllDocs]);

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
    () =>
      Boolean(
        roomState &&
          ((roomState.roomType === 'private' &&
            hostProfile?.id &&
            roomState.hostOwnerId === hostProfile.id) ||
            roomState.hostUsername === username.trim()),
      ),
    [hostProfile?.id, roomState, username],
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

  const hostApiRequest = useCallback(
    async (endpoint: string, options?: RequestInit) => {
      const response = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: options?.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(hostToken ? { Authorization: `Bearer ${hostToken}` } : {}),
          ...(options?.headers || {}),
        },
        body: options?.body,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error || 'Request failed');
      }

      return data;
    },
    [hostToken],
  );

  const fetchHostProfile = useCallback(async () => {
    if (!hostToken) {
      setHostProfile(null);
      return;
    }

    try {
      const data = await hostApiRequest('/api/hosts/me');
      setHostProfile(data.host || null);
      setHostAuthMessage('');
    } catch {
      setHostProfile(null);
      setHostToken('');
    }
  }, [hostApiRequest, hostToken]);

  useEffect(() => {
    fetchHostProfile();
  }, [fetchHostProfile]);

  const fetchPrivateRooms = useCallback(async () => {
    if (!hostToken) {
      setPrivateRooms([]);
      return;
    }

    setPrivateRoomsLoading(true);

    try {
      const data = await hostApiRequest('/api/private-rooms');
      setPrivateRooms(Array.isArray(data.privateRooms) ? data.privateRooms : []);
    } catch {
      setPrivateRooms([]);
    } finally {
      setPrivateRoomsLoading(false);
    }
  }, [hostApiRequest, hostToken]);

  useEffect(() => {
    fetchPrivateRooms();
  }, [fetchPrivateRooms, hostProfile?.id]);

  useEffect(() => {
    if (!privateRooms.length) {
      setSelectedPrivateRoomId('');
      return;
    }

    if (!selectedPrivateRoomId || !privateRooms.some((room) => room.id === selectedPrivateRoomId)) {
      setSelectedPrivateRoomId(privateRooms[0].id);
    }
  }, [privateRooms, selectedPrivateRoomId]);

  const selectedPrivateRoom = useMemo(
    () => privateRooms.find((room) => room.id === selectedPrivateRoomId) || null,
    [privateRooms, selectedPrivateRoomId],
  );
  const selectedExportSnapshot = useMemo(
    () => sessionHistory.find((snapshot) => snapshot.meetingId === selectedExportMeetingId) || null,
    [selectedExportMeetingId, sessionHistory],
  );

  const hostDashboardTabs = useMemo(
    () => [
      { id: 'create_private_room', label: 'Create Private Room' },
      { id: 'current_room_joining', label: 'Current Room Joining' },
      { id: 'meeting_history', label: 'Meeting History' },
      { id: 'participants_status', label: 'Participants Status' },
      { id: 'session_history', label: 'Session History' },
      { id: 'exports', label: 'Exports' },
    ] as Array<{ id: HostDashboardTab; label: string }>,
    [],
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
    (roomCode: string, options?: { silent?: boolean; restored?: boolean; joinPasscode?: string }) => {
      const socket = socketRef.current;
      const silent = Boolean(options?.silent);
      const restored = Boolean(options?.restored);
      const joinPasscode = String(options?.joinPasscode ?? joinRoomPasscodeInput);

      if (!socket) {
        if (!silent) {
          setErrorMessage('Socket is not ready yet.');
        }
        return;
      }

      if (!connected) {
        if (!silent) {
          setErrorMessage('Still connecting to server. Please wait a moment.');
        }
        return;
      }

      if (!validateUsername()) {
        return;
      }

      const normalized = roomCode.trim().toUpperCase();
      if (!validateRoomCode(normalized)) {
        if (!silent) {
          setErrorMessage('Invalid room code');
        }
        return;
      }

      if (!silent) {
        setErrorMessage('');
        setStatusMessage('');
      }

      const cleanUsername = username.trim();

      socket.emit(
        'join-room',
        {
          roomId: normalized,
          username: cleanUsername,
          joinPasscode,
          hostToken: hostToken || undefined,
        },
        (ack: JoinRoomAck) => {
          if (!ack?.ok || !ack.roomId || !ack.roomState) {
            const message = ack?.error || 'Unable to join room.';

            // Refresh can race with old socket disconnect; retry once shortly for restore flow.
            if (restored && message === 'Username already exists in this room') {
              if (restoreRetryTimeoutRef.current) {
                clearTimeout(restoreRetryTimeoutRef.current);
              }

              restoreRetryTimeoutRef.current = setTimeout(() => {
                joinRoom(roomCode, { silent: true, restored: true });
              }, 700);
              return;
            }

            sessionStorage.removeItem(LAST_ROOM_KEY);
            sessionStorage.removeItem(LAST_ROOM_PASSCODE_KEY);
            if (!silent) {
              setErrorMessage(message);
            }
            return;
          }

          destroyAllDocs();
          ensureDocModels(ack.roomState, ack.docSnapshots);
          setRoomState(ack.roomState);
          setJoinedRoomId(ack.roomId);
          setJoinRoomInput(ack.roomId);
          setJoinRoomPasscodeInput(joinPasscode);
          setUsers(
            Array.isArray(ack.roomState.users)
              ? ack.roomState.users
              : Array.isArray(ack.users)
                ? ack.users
                : [],
          );
          setAppScreen('room');
          sessionStorage.setItem(LAST_ROOM_KEY, ack.roomId);
          sessionStorage.setItem(LAST_ROOM_PASSCODE_KEY, joinPasscode || '');

          if (!silent) {
            setStatusMessage(restored ? 'Session restored successfully' : 'Joined room successfully');
          }
        },
      );
    },
    [connected, destroyAllDocs, ensureDocModels, hostToken, joinRoomPasscodeInput, username, validateRoomCode, validateUsername],
  );

  useEffect(() => {
    if (!connected || appScreen !== 'home' || restoreAttemptedRef.current) {
      return;
    }

    const lastRoom = sessionStorage.getItem(LAST_ROOM_KEY);
    const lastRoomPasscode = sessionStorage.getItem(LAST_ROOM_PASSCODE_KEY) || '';
    const currentUsername = usernameRef.current;

    if (!lastRoom || !currentUsername) {
      return;
    }

    restoreAttemptedRef.current = true;
    joinRoom(lastRoom, { silent: true, restored: true, joinPasscode: lastRoomPasscode });
  }, [appScreen, connected, joinRoom]);

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
        setStatusMessage(`Mode switched to ${viewMode.replace(/_/g, ' ')}`);
      });
    },
    [ensureDocModels, isHost, joinedRoomId],
  );

  const handleHostAuthSubmit = useCallback(async () => {
    setHostAuthBusy(true);
    setHostAuthMessage('');

    try {
      if (!hostEmailInput.trim() || !hostPasswordInput) {
        throw new Error('Email and password are required');
      }

      const payload =
        hostAuthMode === 'signup'
          ? {
              name: hostNameInput.trim(),
              email: hostEmailInput.trim(),
              password: hostPasswordInput,
            }
          : {
              email: hostEmailInput.trim(),
              password: hostPasswordInput,
            };

      if (hostAuthMode === 'signup' && !payload.name) {
        throw new Error('Name is required for signup');
      }

      const data = await hostApiRequest(`/api/hosts/${hostAuthMode}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setHostToken(data.token || '');
      setHostProfile(data.host || null);
      setHostPasswordInput('');
      setHostAuthMessage(
        hostAuthMode === 'signup'
          ? 'Host account created and logged in.'
          : 'Logged in successfully.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      setHostAuthMessage(message);
    } finally {
      setHostAuthBusy(false);
    }
  }, [hostApiRequest, hostAuthMode, hostEmailInput, hostNameInput, hostPasswordInput]);

  const handleHostLogout = useCallback(async () => {
    try {
      await hostApiRequest('/api/hosts/logout', { method: 'POST' });
    } catch {
      // Ignore logout errors because client token is source of truth.
    }

    setHostToken('');
    setHostProfile(null);
    setPrivateRooms([]);
    setSelectedPrivateRoomId('');
    setParticipantsStatus([]);
    setSessionHistory([]);
    setHostDashboardTab('create_private_room');
    setHostPasswordInput('');
    setHostAuthMessage('Logged out.');
  }, [hostApiRequest]);

  const handleCreatePrivateRoom = useCallback(async () => {
    if (!privateRoomNameInput.trim() || !privateRoomPasscodeInput) {
      setHostAuthMessage('Private room name and passcode are required');
      return;
    }

    setHostAuthBusy(true);
    setHostAuthMessage('');

    try {
      const data = await hostApiRequest('/api/private-rooms', {
        method: 'POST',
        body: JSON.stringify({
          meetingName: privateRoomNameInput.trim(),
          joinPasscode: privateRoomPasscodeInput,
          hostDisplayName: username.trim() || hostProfile?.name || 'Host',
        }),
      });

      const created = data?.privateRoom as PrivateRoom | undefined;

      if (created) {
        setPrivateRooms((prev) => [created, ...prev]);
        setHostAuthMessage(`Private room created: ${created.roomCode}`);
        setJoinRoomInput(created.roomCode);
        setJoinRoomPasscodeInput(privateRoomPasscodeInput);
      } else {
        setHostAuthMessage('Private room created');
      }

      setPrivateRoomNameInput('');
      setPrivateRoomPasscodeInput('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create private room';
      setHostAuthMessage(message);
    } finally {
      setHostAuthBusy(false);
    }
  }, [hostApiRequest, hostProfile?.name, privateRoomNameInput, privateRoomPasscodeInput, username]);

  const handleStartNewMeeting = useCallback(
    async (privateRoomId: string) => {
      const meetingName = newMeetingNameInput.trim();

      if (!meetingName) {
        setHostAuthMessage('Meeting name is required');
        return;
      }

      setHostAuthBusy(true);
      setHostAuthMessage('');

      try {
        const data = await hostApiRequest(`/api/private-rooms/${privateRoomId}/meetings`, {
          method: 'POST',
          body: JSON.stringify({ meetingName }),
        });

        const updated = data?.privateRoom as PrivateRoom | undefined;

        if (updated) {
          setPrivateRooms((prev) =>
            prev.map((room) => (room.id === updated.id ? updated : room)),
          );
        }

        setHostAuthMessage(`New meeting started: ${meetingName}`);
        setNewMeetingRoomId('');
        setNewMeetingNameInput('');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start meeting';
        setHostAuthMessage(message);
      } finally {
        setHostAuthBusy(false);
      }
    },
    [hostApiRequest, newMeetingNameInput],
  );

  const handleCloseCurrentMeeting = useCallback(
    async (privateRoomId: string) => {
      setHostAuthBusy(true);
      setHostAuthMessage('');

      try {
        const data = await hostApiRequest(`/api/private-rooms/${privateRoomId}/close-meeting`, {
          method: 'POST',
        });

        const updated = data?.privateRoom as PrivateRoom | undefined;

        if (updated) {
          setPrivateRooms((prev) =>
            prev.map((room) => (room.id === updated.id ? updated : room)),
          );
        }

        setHostAuthMessage('Meeting closed successfully.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not close meeting';
        setHostAuthMessage(message);
      } finally {
        setHostAuthBusy(false);
      }
    },
    [hostApiRequest],
  );

  const fetchParticipantsStatus = useCallback(
    async (privateRoomId: string) => {
      if (!privateRoomId) {
        setParticipantsStatus([]);
        return;
      }

      setParticipantsStatusLoading(true);

      try {
        const data = await hostApiRequest(`/api/private-rooms/${privateRoomId}/participants`);
        setParticipantsStatus(Array.isArray(data.participants) ? data.participants : []);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load participants';
        setHostAuthMessage(message);
        setParticipantsStatus([]);
      } finally {
        setParticipantsStatusLoading(false);
      }
    },
    [hostApiRequest],
  );

  const fetchSessionHistory = useCallback(
    async (privateRoomId: string) => {
      if (!privateRoomId) {
        setSessionHistory([]);
        return;
      }

      setSessionHistoryLoading(true);

      try {
        const data = await hostApiRequest(`/api/private-rooms/${privateRoomId}/session-history`);
        setSessionHistory(Array.isArray(data.sessionHistory) ? data.sessionHistory : []);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load session history';
        setHostAuthMessage(message);
        setSessionHistory([]);
      } finally {
        setSessionHistoryLoading(false);
      }
    },
    [hostApiRequest],
  );

  const handleBanToggleParticipant = useCallback(
    async (participant: ParticipantStatus, action: 'ban' | 'unban') => {
      if (!selectedPrivateRoomId) {
        return;
      }

      setHostAuthBusy(true);
      setHostAuthMessage('');

      try {
        const endpoint =
          action === 'ban'
            ? `/api/private-rooms/${selectedPrivateRoomId}/participants/ban`
            : `/api/private-rooms/${selectedPrivateRoomId}/participants/unban`;

        const data = await hostApiRequest(endpoint, {
          method: 'POST',
          body: JSON.stringify({ username: participant.username }),
        });

        const updated = data?.privateRoom as PrivateRoom | undefined;

        if (updated) {
          setPrivateRooms((prev) => prev.map((room) => (room.id === updated.id ? updated : room)));
        }

        setHostAuthMessage(
          action === 'ban'
            ? `${participant.username} banned from this private room code.`
            : `${participant.username} unbanned.`,
        );

        await fetchParticipantsStatus(selectedPrivateRoomId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update participant status';
        setHostAuthMessage(message);
      } finally {
        setHostAuthBusy(false);
      }
    },
    [fetchParticipantsStatus, hostApiRequest, selectedPrivateRoomId],
  );

  const handleExportData = useCallback(
    async (format: 'json' | 'csv' | 'pdf' | 'docx', meetingId?: string) => {
      if (!selectedPrivateRoomId || !selectedPrivateRoom) {
        setHostAuthMessage('Choose a private room first.');
        return;
      }

      try {
        const query = new URLSearchParams({ format });
        if (meetingId) {
          query.set('meetingId', meetingId);
        }

        const response = await fetch(
          `${BACKEND_URL}/api/private-rooms/${selectedPrivateRoomId}/exports?${query.toString()}`,
          {
            headers: {
              ...(hostToken ? { Authorization: `Bearer ${hostToken}` } : {}),
            },
          },
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data?.error || 'Export failed');
        }

        const blob = await response.blob();
        const meetingSuffix = meetingId ? `-${meetingId.slice(0, 8)}` : '';
        const fileName = `${selectedPrivateRoom.roomCode}${meetingSuffix}-export.${format}`;
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
        setHostAuthMessage(`${format.toUpperCase()} export downloaded${meetingId ? ' for selected meeting' : ''}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not export data';
        setHostAuthMessage(message);
      }
    },
    [hostToken, selectedPrivateRoom, selectedPrivateRoomId],
  );

  const handleRemoveParticipant = useCallback(
    (targetUsername: string) => {
      const socket = socketRef.current;

      if (!socket || !joinedRoomId || !isHost) {
        return;
      }

      socket.emit(
        'remove-participant',
        { roomId: joinedRoomId, targetUsername },
        (ack: { ok: boolean; error?: string }) => {
          if (!ack?.ok) {
            setErrorMessage(ack?.error || 'Could not remove participant');
            return;
          }

          setStatusMessage(`${targetUsername} removed from room`);
          setErrorMessage('');
        },
      );
    },
    [isHost, joinedRoomId],
  );

  const goHome = useCallback(async () => {
    const roomId = joinedRoomId.trim();
    const currentUsername = username.trim();
    const isPrivateRoom = roomState?.roomType === 'private';
    const isPrivateHost = Boolean(
      isPrivateRoom &&
      hostProfile?.id &&
      roomState?.hostOwnerId === hostProfile.id,
    );

    if (isPrivateHost) {
      const shouldClose = window.confirm(
        'Do you want to leave and close this meeting now? This will save a snapshot automatically.',
      );

      if (!shouldClose) {
        return;
      }

      const matchingPrivateRoom = privateRooms.find((room) => room.roomCode === roomId);
      if (!matchingPrivateRoom) {
        setErrorMessage('Could not find private room record to close this meeting.');
        return;
      }

      try {
        await hostApiRequest(`/api/private-rooms/${matchingPrivateRoom.id}/close-meeting`, {
          method: 'POST',
        });
        setStatusMessage('Meeting closed and snapshot saved.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not close meeting';
        setErrorMessage(message);
        return;
      }
    } else {
      socketRef.current?.emit('leave-room');
    }

    destroyAllDocs();
    sessionStorage.removeItem(LAST_ROOM_KEY);
    sessionStorage.removeItem(LAST_ROOM_PASSCODE_KEY);

    setAppScreen('home');
    setJoinedRoomId('');
    setUsers([]);
    setRoomState(null);
    setStatusMessage((prev) => prev || (currentUsername ? `${currentUsername} left the room.` : ''));
    setErrorMessage('');
  }, [
    destroyAllDocs,
    hostApiRequest,
    hostProfile?.id,
    joinedRoomId,
    privateRooms,
    roomState?.hostOwnerId,
    roomState?.roomType,
    username,
  ]);

  useEffect(() => {
    if (!hostProfile || !selectedPrivateRoomId) {
      setParticipantsStatus([]);
      setSessionHistory([]);
      setSelectedExportMeetingId('');
      return;
    }

    if (hostDashboardTab === 'participants_status') {
      fetchParticipantsStatus(selectedPrivateRoomId);
    }

    if (hostDashboardTab === 'session_history' || hostDashboardTab === 'exports') {
      fetchSessionHistory(selectedPrivateRoomId);
    }
  }, [
    fetchParticipantsStatus,
    fetchSessionHistory,
    hostDashboardTab,
    hostProfile,
    selectedPrivateRoomId,
  ]);

  useEffect(() => () => {
    if (restoreRetryTimeoutRef.current) {
      clearTimeout(restoreRetryTimeoutRef.current);
    }
  }, []);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_0%_0%,_#d1fae5,_#ecfeff_44%,_#f8fafc_100%)] px-4 py-8 font-sans text-slate-800 md:py-12">
      <section className="mx-auto w-full max-w-7xl rounded-3xl border border-slate-200 bg-white p-6 shadow-panel md:p-8">
        <header className="mb-6 flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">TalkRoom</p>
            <h1 className="text-2xl font-bold text-slate-900">Collaborative Document</h1>
          </div>
          <button
            type="button"
            onClick={() => setAppScreen('hostAuth')}
            className="h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Host Portal
          </button>
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
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={rememberName}
                onChange={(event) => setRememberName(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Remember this name on this device
            </label>

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
              <input
                type="password"
                value={joinRoomPasscodeInput}
                onChange={(event) => setJoinRoomPasscodeInput(event.target.value)}
                placeholder="Room passcode (only for private rooms)"
                className="mb-3 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
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

        {appScreen === 'hostAuth' ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-slate-900">Host Portal</h2>
              <button
                type="button"
                onClick={() => setAppScreen('home')}
                className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Back
              </button>
            </div>

            {hostProfile ? (
              <div className="grid gap-4 lg:grid-cols-[250px_1fr]">
                <aside className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">TalkRoom</p>
                  <p className="mt-1 text-sm font-semibold text-slate-800">{hostProfile.name}</p>
                  <p className="mb-4 text-xs text-slate-500">{hostProfile.email}</p>
                  <nav className="space-y-1">
                    {hostDashboardTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setHostDashboardTab(tab.id)}
                        className={hostDashboardTab === tab.id ? 'w-full rounded-lg bg-brand-500 px-3 py-2 text-left text-sm font-semibold text-white' : 'w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-slate-200'}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </nav>
                  <button
                    type="button"
                    onClick={handleHostLogout}
                    className="mt-4 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Logout Host
                  </button>
                </aside>

                <div className="space-y-4 text-sm">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Private Room</label>
                      <button
                        type="button"
                        onClick={fetchPrivateRooms}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        Refresh
                      </button>
                      {privateRoomsLoading ? (
                        <span className="text-xs text-slate-500">Loading...</span>
                      ) : null}
                    </div>
                    <select
                      value={selectedPrivateRoomId}
                      onChange={(event) => setSelectedPrivateRoomId(event.target.value)}
                      className="h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
                    >
                      {privateRooms.length === 0 ? (
                        <option value="">No private rooms yet</option>
                      ) : (
                        privateRooms.map((room) => (
                          <option key={room.id} value={room.id}>
                            {room.workspaceName} ({room.roomCode})
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {hostDashboardTab === 'create_private_room' ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="mb-2 text-sm font-semibold text-slate-700">Create Private Room (Permanent)</p>
                      <input
                        type="text"
                        value={privateRoomNameInput}
                        onChange={(event) => setPrivateRoomNameInput(event.target.value)}
                        placeholder="First meeting name"
                        className="mb-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
                      />
                      <input
                        type="password"
                        value={privateRoomPasscodeInput}
                        onChange={(event) => setPrivateRoomPasscodeInput(event.target.value)}
                        placeholder="Participant join passcode"
                        className="mb-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
                      />
                      <button
                        type="button"
                        onClick={handleCreatePrivateRoom}
                        disabled={hostAuthBusy}
                        className="h-10 w-full rounded-lg bg-brand-500 text-sm font-semibold text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {hostAuthBusy ? 'Please wait...' : 'Create 10-char Private Room'}
                      </button>
                    </div>
                  ) : null}

                  {hostDashboardTab === 'current_room_joining' ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="mb-2 text-sm font-semibold text-slate-700">Current Room Joining</p>
                      {selectedPrivateRoom ? (
                        <>
                          <p className="text-xs text-slate-500">Code: {selectedPrivateRoom.roomCode}</p>
                          <p className="text-xs text-slate-500">Current: {selectedPrivateRoom.currentMeeting?.name || 'No active meeting'}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setJoinRoomInput(selectedPrivateRoom.roomCode);
                                setAppScreen('home');
                              }}
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            >
                              Use Code In Join
                            </button>
                            {selectedPrivateRoom.currentMeeting ? (
                              <button
                                type="button"
                                onClick={() => handleCloseCurrentMeeting(selectedPrivateRoom.id)}
                                disabled={hostAuthBusy}
                                className="rounded-md border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Close Meeting
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setNewMeetingRoomId(selectedPrivateRoom.id);
                                  setNewMeetingNameInput('');
                                }}
                                className="rounded-md border border-brand-400 px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                              >
                                Start New Meeting
                              </button>
                            )}
                          </div>
                          {newMeetingRoomId === selectedPrivateRoom.id ? (
                            <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                              <input
                                type="text"
                                value={newMeetingNameInput}
                                onChange={(event) => setNewMeetingNameInput(event.target.value)}
                                placeholder="Meeting name"
                                className="mb-2 h-9 w-full rounded-md border border-slate-300 px-2 text-xs outline-none ring-brand-500 transition focus:ring-2"
                              />
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleStartNewMeeting(selectedPrivateRoom.id)}
                                  className="rounded-md bg-brand-500 px-2 py-1 text-xs font-semibold text-white hover:bg-brand-600"
                                >
                                  Create
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setNewMeetingRoomId('');
                                    setNewMeetingNameInput('');
                                  }}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p className="text-xs text-slate-500">Create a private room first.</p>
                      )}
                    </div>
                  ) : null}

                  {hostDashboardTab === 'meeting_history' ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="mb-2 text-sm font-semibold text-slate-700">Meeting History</p>
                      {!selectedPrivateRoom ? (
                        <p className="text-xs text-slate-500">Select a private room.</p>
                      ) : selectedPrivateRoom.meetings.length === 0 ? (
                        <p className="text-xs text-slate-500">No meetings yet.</p>
                      ) : (
                        <ul className="space-y-2">
                          {selectedPrivateRoom.meetings
                            .slice()
                            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
                            .map((meeting) => (
                              <li key={meeting.id} className="rounded-md border border-slate-200 p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-semibold text-slate-700">{meeting.name}</p>
                                  <span className={meeting.status === 'open' ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700' : 'rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600'}>
                                    {meeting.status === 'open' ? 'Open' : 'Closed'}
                                  </span>
                                </div>
                                <p className="mt-1 text-[11px] text-slate-500">Started: {new Date(meeting.startedAt).toLocaleString()}</p>
                                <p className="text-[11px] text-slate-500">Closed: {meeting.closedAt ? new Date(meeting.closedAt).toLocaleString() : 'Still open'}</p>
                                <p className="text-[11px] text-slate-500">Total participants: {meeting.participantsCount}</p>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  {hostDashboardTab === 'participants_status' ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="mb-2 text-sm font-semibold text-slate-700">Participants Status</p>
                      {!selectedPrivateRoom ? (
                        <p className="text-xs text-slate-500">Select a private room.</p>
                      ) : participantsStatusLoading ? (
                        <p className="text-xs text-slate-500">Loading participants...</p>
                      ) : participantsStatus.length === 0 ? (
                        <p className="text-xs text-slate-500">No participants data yet.</p>
                      ) : (
                        <ul className="space-y-2">
                          {participantsStatus.map((participant) => (
                            <li key={participant.key} className="flex items-center justify-between rounded-md border border-slate-200 p-2">
                              <div>
                                <p className="text-sm font-semibold text-slate-700">{participant.username}</p>
                                <p className="text-[11px] text-slate-500">Meetings: {participant.meetingsJoined} | Joins: {participant.totalJoinCount}</p>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleBanToggleParticipant(participant, participant.banned ? 'unban' : 'ban')}
                                disabled={hostAuthBusy}
                                className={participant.banned ? 'rounded-md border border-emerald-300 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60' : 'rounded-md border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60'}
                              >
                                {participant.banned ? 'Unban' : 'Ban'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  {hostDashboardTab === 'session_history' ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-semibold text-slate-700">Session History</p>
                        {selectedPrivateRoomId ? (
                          <button
                            type="button"
                            onClick={() => fetchSessionHistory(selectedPrivateRoomId)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            Refresh
                          </button>
                        ) : null}
                      </div>
                      {!selectedPrivateRoom ? (
                        <p className="text-xs text-slate-500">Select a private room.</p>
                      ) : sessionHistoryLoading ? (
                        <p className="text-xs text-slate-500">Loading session snapshots...</p>
                      ) : sessionHistory.length === 0 ? (
                        <p className="text-xs text-slate-500">No session snapshots yet. Close a meeting to generate one.</p>
                      ) : (
                        <ul className="space-y-2">
                          {sessionHistory.map((snapshot) => (
                            <li key={snapshot.id} className="rounded-md border border-slate-200 p-2">
                              <p className="text-xs font-semibold text-slate-700">{snapshot.meetingName} ({new Date(snapshot.capturedAt).toLocaleString()})</p>
                              <p className="text-[11px] text-slate-500">Active users at close: {snapshot.activeUsers.join(', ') || 'None'}</p>
                              <p className="text-[11px] text-slate-500">Docs captured: {snapshot.docs.length}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  {hostDashboardTab === 'exports' ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <p className="mb-2 text-sm font-semibold text-slate-700">Exports</p>
                      <p className="mb-3 text-xs text-slate-500">Export all meetings together or open a specific meeting snapshot and export only that meeting.</p>
                      <div className="mb-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => handleExportData('json')} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export All JSON</button>
                        <button type="button" onClick={() => handleExportData('csv')} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export All CSV</button>
                        <button type="button" onClick={() => handleExportData('pdf')} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export All PDF</button>
                        <button type="button" onClick={() => handleExportData('docx')} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export All Word</button>
                      </div>

                      {!selectedPrivateRoom ? (
                        <p className="text-xs text-slate-500">Select a private room.</p>
                      ) : (
                        <div className="space-y-3">
                          <div className="rounded-md border border-slate-200">
                            {(selectedPrivateRoom.meetings || []).length === 0 ? (
                              <p className="p-3 text-xs text-slate-500">No meetings yet.</p>
                            ) : (
                              <ul className="divide-y divide-slate-200">
                                {selectedPrivateRoom.meetings
                                  .slice()
                                  .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
                                  .map((meeting) => (
                                    <li key={meeting.id} className="p-3">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                          <p className="text-xs font-semibold text-slate-700">{meeting.name}</p>
                                          <p className="text-[11px] text-slate-500">Started: {new Date(meeting.startedAt).toLocaleString()}</p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <button
                                            type="button"
                                            onClick={() => setSelectedExportMeetingId(selectedExportMeetingId === meeting.id ? '' : meeting.id)}
                                            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                                          >
                                            {selectedExportMeetingId === meeting.id ? 'Hide' : 'Open'}
                                          </button>
                                          <button type="button" onClick={() => handleExportData('json', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">JSON</button>
                                          <button type="button" onClick={() => handleExportData('csv', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">CSV</button>
                                          <button type="button" onClick={() => handleExportData('pdf', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">PDF</button>
                                          <button type="button" onClick={() => handleExportData('docx', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">Word</button>
                                        </div>
                                      </div>
                                      {selectedExportMeetingId === meeting.id ? (
                                        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                                          {!selectedExportSnapshot ? (
                                            <p className="text-xs text-slate-500">Snapshot not captured yet. Close the meeting to generate automatic snapshot.</p>
                                          ) : (
                                            <div className="space-y-2">
                                              <p className="text-[11px] text-slate-500">Captured: {new Date(selectedExportSnapshot.capturedAt).toLocaleString()}</p>
                                              <p className="text-[11px] text-slate-500">Active users: {selectedExportSnapshot.activeUsers.join(', ') || 'None'}</p>
                                              <div className="max-h-72 space-y-2 overflow-auto rounded border border-slate-200 bg-white p-2">
                                                {selectedExportSnapshot.docs.map((doc) => (
                                                  <div key={doc.docId} className="rounded border border-slate-200 bg-white p-2">
                                                    <p className="text-xs font-semibold text-slate-700">{doc.name} ({doc.type})</p>
                                                    <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-600">{doc.text || '(No text)'}</pre>
                                                  </div>
                                                ))}
                                              </div>
                                              <div className="flex flex-wrap gap-2">
                                                <button type="button" onClick={() => handleExportData('json', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export This JSON</button>
                                                <button type="button" onClick={() => handleExportData('csv', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export This CSV</button>
                                                <button type="button" onClick={() => handleExportData('pdf', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export This PDF</button>
                                                <button type="button" onClick={() => handleExportData('docx', meeting.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">Export This Word</button>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      ) : null}
                                    </li>
                                  ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setHostAuthMode('login')}
                    className={hostAuthMode === 'login' ? 'h-10 rounded-lg bg-brand-500 text-sm font-semibold text-white' : 'h-10 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700'}
                  >
                    Login
                  </button>
                  <button
                    type="button"
                    onClick={() => setHostAuthMode('signup')}
                    className={hostAuthMode === 'signup' ? 'h-10 rounded-lg bg-brand-500 text-sm font-semibold text-white' : 'h-10 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700'}
                  >
                    Signup
                  </button>
                </div>

                {hostAuthMode === 'signup' ? (
                  <input
                    type="text"
                    value={hostNameInput}
                    onChange={(event) => setHostNameInput(event.target.value)}
                    placeholder="Host name"
                    className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
                  />
                ) : null}

                <input
                  type="email"
                  value={hostEmailInput}
                  onChange={(event) => setHostEmailInput(event.target.value)}
                  placeholder="Host email"
                  className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
                />

                <input
                  type="password"
                  value={hostPasswordInput}
                  onChange={(event) => setHostPasswordInput(event.target.value)}
                  placeholder="Host password"
                  className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-brand-500 transition focus:ring-2"
                />

                <button
                  type="button"
                  onClick={handleHostAuthSubmit}
                  disabled={hostAuthBusy}
                  className="h-10 w-full rounded-lg bg-brand-500 text-sm font-semibold text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {hostAuthBusy ? 'Please wait...' : hostAuthMode === 'signup' ? 'Create Host Account' : 'Login Host'}
                </button>

                {hostAuthMessage ? <p className="text-xs text-slate-600">{hostAuthMessage}</p> : null}
              </div>
            )}
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
                  Meeting: <span className="font-semibold">{roomState?.currentMeetingName || 'Live session'}</span>
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
                  <li key={name} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="font-medium text-slate-700">{name}</span>
                    </div>
                    {isHost && name !== username.trim() ? (
                      <button
                        type="button"
                        onClick={() => handleRemoveParticipant(name)}
                        className="rounded-md border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Remove
                      </button>
                    ) : null}
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
