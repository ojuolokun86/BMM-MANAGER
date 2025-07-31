import fs from 'fs';
import path from 'path';
import { isServerHealthy, getHealthyServers } from './healthMonitor.js';

const botServers = JSON.parse(
  fs.readFileSync(path.resolve('src/config/botServers.json'), 'utf-8')
);

let lastIndex = 0;
const sessionAssignments = {}; // { sessionKey: serverId }

export async function assignServerForUser(authId, phoneNumber) {
  // Only use healthy servers
  const healthyServers = getHealthyServers();
  if (!healthyServers.length) {
    console.error('No healthy bot servers available');
    return null; // instead of throw new Error(...)
  }

  // Sticky assignment if exists
  const sessionKey = `${authId}:${phoneNumber}`;
  if (sessionAssignments[sessionKey] && isServerHealthy(sessionAssignments[sessionKey])) {
    const server = botServers.find(s => s.id === sessionAssignments[sessionKey]);
    return server.url;
  }

  // Otherwise, round-robin assign
  const server = healthyServers[lastIndex % healthyServers.length];
  lastIndex++;
  sessionAssignments[sessionKey] = server.id;
  return server.url;
}

// Reassign all sessions from a dead server
export function reassignSessionsFromDeadServer(deadServerId) {
  const healthyServers = getHealthyServers();
  if (!healthyServers.length) {
    console.error('[LOAD BALANCER] No healthy servers available!');
    return null;
  }
  for (const [sessionKey, serverId] of Object.entries(sessionAssignments)) {
    if (serverId === deadServerId) {
      // Pick a new healthy server
      const newServer = healthyServers[lastIndex % healthyServers.length];
      lastIndex++;
      sessionAssignments[sessionKey] = newServer.id;
      // Optionally, trigger reconnection logic here
    }
  }
}

// Example: If you have a sessionAssignments object that tracks session<->server mapping
export function getSessionAssignments() {
  return sessionAssignments; // Make sure this variable exists and is up-to-date
}