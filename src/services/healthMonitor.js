// healthMonitor.js
import axios from 'axios';
import backendIO from 'socket.io-client'; // Or your actual import
import fs from 'fs';
import path from 'path';
import { reassignSessionsFromSupabase, notifyServerToLoadSession } from './loadBalancer.js';

const botServers = JSON.parse(
  fs.readFileSync(path.resolve('src/config/botServers.json'), 'utf-8')
);

const serverStatus = {}; // { [serverId]: { healthy, load, lastSeen, ... } }
const wsClients = {};

export function setupAllWebSockets() {
  botServers.forEach(setupWebSocket);
}

function setupWebSocket(server) {
  if (wsClients[server.id]) return;

  const ws = backendIO(server.url, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000
  });

  ws.on('connect', () => {
    console.log(`[HEALTH][WS] Connected to ${server.id} (${server.url})`);
    serverStatus[server.id] = {
      ...(serverStatus[server.id] || {}),
      healthy: true,
      lastSeen: Date.now(),
      load: 0
    };
  });

  ws.on('disconnect', () => {
    console.log(`[HEALTH][WS] Disconnected from ${server.id}`);
    serverStatus[server.id] = {
      ...(serverStatus[server.id] || {}),
      healthy: false,
      lastSeen: Date.now()
    };
    // Immediately reassign all sessions from this server
    reassignSessionsFromSupabase(server.id);  
  });
  ws.on('status', (data) => {
    // Example: { load: 0.23, ... }
    serverStatus[server.id] = {
      ...(serverStatus[server.id] || {}),
      ...data,
      healthy: true,
      lastSeen: Date.now()
    };
  });

  wsClients[server.id] = ws;
}

// Helper: Get array of healthy servers with status info
export function getServerStatusArray() {
  return botServers.map(s => ({
    ...s,
    ...(serverStatus[s.id] || { healthy: false, load: 1 }),
  }));
}

// Helper: Is a server healthy?
export function isServerHealthy(serverId) {
  return serverStatus[serverId]?.healthy === true;
}

// Helper: Get only healthy servers
export function getHealthyServers() {
  return getServerStatusArray().filter(s => s.healthy);
}
export function getServerStatus() {
  return serverStatus;
}
// Export the status map for direct use
export { serverStatus };

