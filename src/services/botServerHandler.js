import { createClient } from '@supabase/supabase-js';
import { assignServerForUser } from './loadBalancer.js';
import fs from 'fs';
import path from 'path';
import { io as backendIO } from 'socket.io-client';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export async function getSessionsForServer(serverId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('serverId', serverId);

  if (error) throw error;
  return data;
}

function getServerIdByUrl(url) {
  const servers = JSON.parse(fs.readFileSync(path.resolve('src/config/botServers.json'), 'utf-8'));
  const s = servers.find(s => s.url === url);
  return s ? s.id : null;
}

export async function reassignSessions(sessions) {
  for (const session of sessions) {
    try {
      const newServerUrl = await assignServerForUser(session.authId, session.phoneNumber);
      const newServerId = getServerIdByUrl(newServerUrl);

      await supabase
        .from('sessions')
        .update({ serverId: newServerId })
        .eq('authId', session.authId)
        .eq('phoneNumber', session.phoneNumber);

      await triggerSessionLoad(newServerUrl, session.authId, session.phoneNumber);
      console.log(`[BOT HANDLER] Session ${session.authId}:${session.phoneNumber} reassigned to ${newServerId}`);
    } catch (err) {
      console.error(`[BOT HANDLER] Failed to reassign session ${session.authId}:${session.phoneNumber}:`, err.message);
    }
  }
}

export async function recoverSessionsFromDeadServer(deadServerId) {
  const sessions = await getSessionsForServer(deadServerId);
  if (!sessions.length) {
    console.log(`[BOT HANDLER] No sessions to recover for server ${deadServerId}`);
    return;
  }
  await reassignSessions(sessions);
}

import axios from 'axios';

export async function triggerSessionLoad(serverUrl, authId, phoneNumber) {
  try {
    await axios.post(`${serverUrl}/api/load-session`, { authId, phoneNumber });
    console.log(`[BOT HANDLER] Triggered session load for ${authId}:${phoneNumber} on ${serverUrl}`);
  } catch (err) {
    console.error(`[BOT HANDLER] Failed to trigger session load:`, err.message);
  }
}