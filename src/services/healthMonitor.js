import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { io as backendIO } from 'socket.io-client';

const botServers = JSON.parse(
  fs.readFileSync(path.resolve('src/config/botServers.json'), 'utf-8')
);

const serverStatus = {};
const wsClients = {};
const HEALTH_INTERVAL = 10000; // 10 second

async function pingServer(server) {
  try {
    const res = await axios.get(`${server.url}/api/health`, { timeout: 2000 });
    //console.log(`[HEALTH][API] ${server.id} (${server.url}) responded:`, res.data);
    return res.status === 200;
  } catch (err) {
    //console.log(`[HEALTH][API] ${server.id} (${server.url}) API check failed:`, err.message);
    return false;
  }
}
function setupWebSocket(server) {
  if (wsClients[server.id]) return; // Already connected

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
      wsHealthy: true,
      lastSeen: Date.now()
    };
  });

  ws.on('disconnect', () => {
    console.log(`[HEALTH][WS] Disconnected from ${server.id} (${server.url})`);
    serverStatus[server.id] = {
      ...(serverStatus[server.id] || {}),
      wsHealthy: false,
      lastSeen: serverStatus[server.id]?.lastSeen || 0
    };
  });

  wsClients[server.id] = ws;
}

for (const server of botServers) {
  setupWebSocket(server);
}

// Then start your health poll:
setInterval(checkAllServers, HEALTH_INTERVAL);

async function checkAllServers() {
  for (const server of botServers) {
    const healthy = await pingServer(server);
    const wsHealthy = serverStatus[server.id]?.wsHealthy ?? false;
    console.log(`[HEALTH][WS] ${server.id} wsHealthy:`, serverStatus[server.id]?.wsHealthy);
    //console.log(`[HEALTH][WS] ${server.id} healthy:`, serverStatus[server.id]?.healthy);

    // Fetch userCount from this server
    let userCount = 0;
    try {
      const res = await axios.get(`${server.url}/api/admin/load`);
      userCount = res.data.userCount ?? 0;
    } catch (err) {
      // If error, leave userCount as 0
      userCount = 0;
    }
    const load = server.maxLoad > 0 ? userCount / server.maxLoad : 0;

    serverStatus[server.id] = {
      userCount,
      load,
      id: server.id,
      name: server.name,
      url: server.url,
      maxLoad: server.maxLoad,
      healthy: healthy && wsHealthy,
      wsHealthy,
      lastSeen: healthy && wsHealthy ? Date.now() : serverStatus[server.id]?.lastSeen || 0
    };
    console.log(`[HEALTH][COMBINED] ${server.id}: API=${healthy} | WS=${wsHealthy} | OVERALL=${serverStatus[server.id].healthy}`);
  }
}

setInterval(checkAllServers, HEALTH_INTERVAL);

export function isServerHealthy(serverId) {
  return serverStatus[serverId]?.healthy;
}

export function getHealthyServers() {
  return botServers.filter(s => serverStatus[s.id]?.healthy);
}
export function getServerStatus() {
  return serverStatus;
}

export function getServerStatusArray() {
  //console.log('Status array from health monitor:', Object.values(serverStatus));
  return Object.values(serverStatus);
}