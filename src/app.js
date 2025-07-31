import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import apiRouter from './routes/api.js';
import adminApiRouter from './routes/adminApi.js';
import { assignServerForUser } from './services/loadBalancer.js';
import { io as backendIO } from 'socket.io-client';
import fs from 'fs';
import { setupAllWebSockets } from './services/healthMonitor.js';




const allowedOrigins = [
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:3000",
  "http://10.132.135.53:8080",
  "https://techitoon.netlify.app",
  "https://bmm-server.netlify.app"
];

const app = express();
app.set('trust proxy', true); // 👈 Ensure correct IP forwarding behind proxies

// ✅ FIRST: Allow all preflight OPTIONS
app.options('*', (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PUT, PATCH");
  return res.sendStatus(200);
});

// ✅ THEN: Use custom middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods",  "GET, POST, OPTIONS, DELETE, PUT, PATCH");
  }
  next();
});

// ✅ Now apply standard CORS
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use('/api', apiRouter);
app.use('/api/admin', adminApiRouter); // Serve admin static files

const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true
  }
});
setupAllWebSockets();
// --- Socket.IO Proxy ---
const sessionCache = new Map(); // Map<room, { qr, pairingCode }>

io.on('connection', (client) => {
    console.log(`[SOCKET] Client connected: ${client.id}`);
  let backendSocket = null;
  let currentRoom = null;

  client.on('join-session-room', ({ authId, phoneNumber }) => {
    console.log(`[SOCKET] Client ${client.id} joining session room: ${authId}:${phoneNumber}`);
    const room = `${authId}:${phoneNumber}`;
    currentRoom = room;
    client.join(room);

    // If we have a cached QR or pairing code, send it immediately
    const cached = sessionCache.get(room);
    if (cached?.qr) {
      console.log(`[SOCKET][${room}] Sending cached QR to frontend`);
      client.emit('qr', { qr: cached.qr });
    }
    if (cached?.pairingCode) {
      console.log(`[SOCKET][${room}] Sending cached pairing code to frontend`);
      client.emit('pairingCode', { code: cached.pairingCode });
    }
  });

  client.on('register-bot-session', async ({ authId, phoneNumber }) => {
    const serverUrl = await assignServerForUser(authId, phoneNumber);
    backendSocket = backendIO(serverUrl, {
      transports: ['polling', 'websocket'],
      withCredentials: true
    });

    backendSocket.on('connect', () => {
      console.log(`[SOCKET][${authId}:${phoneNumber}] Connected to backend server at ${serverUrl}`);
      backendSocket.emit('register-bot-session', { authId, phoneNumber });
    });

    backendSocket.onAny((event, ...args) => {
      if (currentRoom) {
        if (event === 'qr') {
          console.log(`[SOCKET][${currentRoom}] Received QR from backend, emitting to frontend`);
          sessionCache.set(currentRoom, { ...sessionCache.get(currentRoom), qr: args[0].qr });
        }
        if (event === 'pairingCode') {
          console.log(`[SOCKET][${currentRoom}] Received pairing code from backend, emitting to frontend`);
          sessionCache.set(currentRoom, { ...sessionCache.get(currentRoom), pairingCode: args[0].code });
        }
        io.to(currentRoom).emit(event, ...args);
      }
    });

    client.onAny((event, ...args) => {
      if (backendSocket?.connected) {
        console.log(`[SOCKET][${currentRoom}] Forwarding event "${event}" from frontend to backend`);
        backendSocket.emit(event, ...args);
      }
    });

    client.on('disconnect', () => {
      console.log(`[SOCKET][${currentRoom}] Frontend disconnected, closing backend socket`);
      backendSocket?.disconnect();
    });
  });

  // Accept backend emissions (from backend servers)
  client.on('backend-event', ({ authId, phoneNumber, event, payload }) => {
    const room = `${authId}:${phoneNumber}`;
    if (event === 'qr') {
      console.log(`[SOCKET][${room}] Received QR from backend-event, emitting to frontend`);
      sessionCache.set(room, { ...sessionCache.get(room), qr: payload.qr });
    }
    if (event === 'pairingCode') {
      console.log(`[SOCKET][${room}] Received pairing code from backend-event, emitting to frontend`);
      sessionCache.set(room, { ...sessionCache.get(room), pairingCode: payload.code });
    }
    io.to(room).emit(event, payload);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 BMM Manager running on port ${PORT}`);
});