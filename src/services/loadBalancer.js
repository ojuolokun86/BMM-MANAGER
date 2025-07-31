// loadBalancer.js
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getServerStatusArray, isServerHealthy } from './healthMonitor.js';
import supabase from '../supabaseClient.js'; // adjust path as needed
const botServers = JSON.parse(
  fs.readFileSync(path.resolve('src/config/botServers.json'), 'utf-8')
);

let lastIndex = 0;
const sessionAssignments = {}; // { sessionKey: serverId }

export async function assignServerForUser(authId, phoneNumber) {
  // 1. Get all sessions from Supabase
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('authId, phoneNumber, server_id');

  if (error) {
    console.error('[SUPABASE] Error fetching sessions:', error.message);
    return null;
  }

  // 2. Count sessions per server
  const loadMap = {};
  for (const s of sessions) {
    if (!loadMap[s.server_id]) loadMap[s.server_id] = 0;
    loadMap[s.server_id]++;
  }

  // 3. Get healthy servers
  const healthyServers = getServerStatusArray().filter(s => s.healthy);

  if (!healthyServers.length) {
    console.error('No healthy bot servers available');
    return null;
  }

  // 4. Check if session exists and is already assigned to a healthy server
  const session = sessions.find(
    s => s.authId === authId && s.phoneNumber === phoneNumber
  );
  if (session && healthyServers.some(s => s.id === session.server_id)) {
    // Session is already running on a healthy server, just return the server URL
    const assignedServer = healthyServers.find(s => s.id === session.server_id);
    console.log('[LOAD BALANCER] Session already running on healthy server:', assignedServer.id);
    return assignedServer.url;
  }

  // 5. Pick the least-loaded healthy server
  healthyServers.sort((a, b) => (loadMap[a.id] || 0) - (loadMap[b.id] || 0));
  const assignedServer = healthyServers[0];
  console.log('[LOAD BALANCER] Assigning session to:', assignedServer.id);

  // 6. Update Supabase to reflect assignment
  await supabase
    .from('sessions')
    .upsert([{ authId, phoneNumber, server_id: assignedServer.id }], { onConflict: ['authId', 'phoneNumber'] });


  return assignedServer.url;
}
export function getSessionAssignments() {
  return sessionAssignments; // Make sure this variable exists and is up-to-date
}
// ... keep your other code




export async function reassignSessionsFromSupabase(deadServerId) {
  console.log(`[REASSIGN] Reassigning sessions from dead server ${deadServerId}`);
  // 1. Get all sessions assigned to deadServerId
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('authId, phoneNumber')
    .eq('server_id', deadServerId);

  if (error) {
    console.error('[SUPABASE] Error fetching sessions:', error.message);
    return;
  }
  if (!sessions.length) {
    console.log(`[REASSIGN] No sessions found in Supabase for ${deadServerId}`);
    return;
  }

  // 2. Get healthy servers
  const healthyServers = getServerStatusArray().filter(s => s.healthy && s.id !== deadServerId);
  if (!healthyServers.length) {
    console.error('[LOAD BALANCER] No healthy servers available!');
    return;
  }

  // 3. Reassign each session to the least-loaded healthy server
  for (const { authId, phoneNumber } of sessions) {
    healthyServers.sort((a, b) => (a.load || 0) - (b.load || 0));
    const newServer = healthyServers[0];

    // 4. Update Supabase to reflect the new server assignment
    const { error: updateError } = await supabase
      .from('sessions')
      .update({ server_id: newServer.id })
      .eq('authId', authId)
      .eq('phoneNumber', phoneNumber);
    if (updateError) {
      console.error(`[SUPABASE] Failed to update session for ${authId}:${phoneNumber}:`, updateError.message);
      continue;
    }

    // 5. Notify the new server to load the session
    notifyServerToLoadSession(newServer, authId, phoneNumber);
    console.log(`[REASSIGN] Moved session ${authId}:${phoneNumber} from ${deadServerId} to ${newServer.id}`);
  }
}


export function notifyServerToLoadSession(server, authId, phoneNumber) {
  console.log(`[NOTIFY] Notifying ${server.id} to load session for ${authId}:${phoneNumber}`);
  // This endpoint should be implemented on your bot server backend
  axios.post(`${server.url}/api/admin/load-session`, { authId, phoneNumber })
    .then(() => {
      console.log(`✅ Session for ${authId}:${phoneNumber} loaded on server ${server.id}`);
    })
    .catch(err => {
      console.error(`❌ Failed to load session on server ${server.id}:`, err.message);
    });
}