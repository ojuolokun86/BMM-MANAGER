import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { assignServerForUser } from '../services/loadBalancer.js';
import supabase from '../supabaseClient.js';
const botServers = JSON.parse(
  fs.readFileSync(path.resolve('src/config/botServers.json'), 'utf-8')
);

export async function getAssignedServerUrl(authId, phoneNumber) {
  const { data, error } = await supabase
    .from('sessions')
    .select('server_id')
    .eq('authId', authId)
    .eq('phoneNumber', phoneNumber)
    .single();

  if (error || !data) {
    console.error('[ROUTER] Could not find assigned server for session:', error?.message);
    return null;
  }
  const server = botServers.find(s => s.id === data.server_id);
  return server ? server.url : null;
}


const router = express.Router();

router.post('/deploy-bot', async (req, res) => {
  console.log('📥 Deploy request received:', req.body);
  const { authId, phoneNumber } = req.body;
  const serverUrl = await assignServerForUser(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ error: 'No available bot server' });

  try {
    const response = await axios.post(`${serverUrl}/api/deploy-bot`, req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error deploying bot:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxy login
router.post('/login', async (req, res) => {
  console.log('📥 Login request received:', req.body);
  const { authId, phoneNumber } = req.body;
  const serverUrl = await assignServerForUser(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ error: 'No available bot server' });

  try {
    const response = await axios.post(`${serverUrl}/api/login`, req.body);
    console.log('🔗 Getting request result:', req.body);
    res.status(response.status).json(response.data);
    console.log('🔗 Response sent to client:', response.data);
  } catch (err) {
    console.error('❌ Error during login:', err.response?.data?.message || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || 'Failed to log in.' });
  }
});

// Proxy register
router.post('/register', async (req, res) => {
  const { authId, phoneNumber } = req.body;
  const serverUrl = await assignServerForUser(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ error: 'No available bot server' });

  try {
    const response = await axios.post(`${serverUrl}/api/register`, req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add more proxy endpoints as needed


router.get('/bots', async (req, res) => {
  console.log(' call all bot')
  const { authId } = req.query;
  if (!authId) return res.status(400).json({ error: 'authId is required' });

  try {
    const results = await Promise.allSettled(
      botServers.map(server =>
        axios.get(`${server.url}/api/bots`, { params: { authId } })
      )
    );
    console.log(` result ${results}`)

    // Aggregate all bots from fulfilled responses
    const allBots = [];
    results.forEach((result, idx) => {
      const serverUrl = botServers[idx].url;
      if (result.status === 'fulfilled') {
        const data = result.value.data;
        console.log(`[DEBUG] Response from ${serverUrl}:`, JSON.stringify(data));
        // Accept both { bots: [...] } and [...] as valid
        if (Array.isArray(data)) {
          allBots.push(...data);
        } else if (data && Array.isArray(data.bots)) {
          allBots.push(...data.bots);
        } else {
          console.warn(`[WARN] Unexpected response format from ${serverUrl}:`, data);
        }
      } else {
        console.error(`[ERROR] Failed to fetch from ${serverUrl}:`, result.reason?.message || result.reason);
      }
    });
    console.log(`all bot for user ${authId}:`, allBots);

    res.json({ success: true, bots: allBots });
  } catch (err) {
    console.error('❌ Error fetching bots from all servers:', err.message);
    res.status(500).json({ error: err.message });
  }
});


router.get('/bot-settings', async (req, res) => {
  const { authId, phoneNumber } = req.query;
  if (!authId || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'authId and phoneNumber are required.' });
  }

  try {
    const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
    if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

    const response = await axios.get(`${serverUrl}/api/bot-settings`, {
      params: { authId, phoneNumber }
    });

    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error fetching bot settings:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});
router.post('/bot-settings', async (req, res) => {
  //console.log('🌐 Proxying /bot-settings... setup');
  const { authId, phoneNumber, mode, prefix } = req.body;
  if (!authId || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'authId and phoneNumber are required.' });
  }

  try {
    const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
    if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

    // Forward the POST to the actual bot server
    const response = await axios.post(`${serverUrl}/api/bot-settings`, {
      authId,
      phoneNumber,
      mode,
      prefix
    });

    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error updating bot settings:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


router.delete('/bot', async (req, res) => {
  //console.log('🌐 Proxying /bot deletion...')
  const { authId, phoneNumber } = req.body;
  if (!authId || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'authId and phoneNumber are required.' });
  }

  const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

  try {
    const response = await axios.delete(`${serverUrl}/api/bot`, { data: { authId, phoneNumber } });
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error deleting bot:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bot/restart', async (req, res) => {
  //console.log('🌐 Proxying /bot/restart...');
  const { authId, phoneNumber } = req.body;
  if (!authId || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'authId and phoneNumber are required.' });
  }

  const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

  try {
    const response = await axios.post(`${serverUrl}/api/bot/restart`, { authId, phoneNumber });
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error restarting bot:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Proxy GET /bot-groups
router.get('/bot-groups', async (req, res) => {
  const { authId, phoneNumber } = req.query;
  if (!authId || !phoneNumber) {
    return res.status(400).json({ success: false, message: 'authId and phoneNumber are required.' });
  }
  const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

  try {
    const response = await axios.get(`${serverUrl}/api/bot-groups`, {
      params: { authId, phoneNumber }
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error fetching bot groups:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Proxy POST /set-antilink
router.post('/set-antilink', async (req, res) => {
  const { authId, phoneNumber, groupId } = req.body;
  if (!authId || !phoneNumber || !groupId) {
    return res.status(400).json({ success: false, message: 'authId, phoneNumber, and groupId are required.' });
  }
  const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

  try {
    const response = await axios.post(`${serverUrl}/api/set-antilink`, { authId, phoneNumber, groupId });
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error toggling antilink:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});
router.post('/set-antidelete', async (req, res) => {
  const { authId, phoneNumber, groupId, mode, excluded } = req.body;
  if (!authId || !phoneNumber || !groupId) {
    return res.status(400).json({ success: false, message: 'authId, phoneNumber, and groupId are required.' });
  }
  const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

  try {
    const response = await axios.post(`${serverUrl}/api/set-antidelete`, {
      authId,
      phoneNumber,
      groupId,
      mode,
      excluded
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error setting antidelete:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/group-settings', async (req, res) => {
  const { authId, phoneNumber, groupId } = req.query;
  if (!authId || !phoneNumber || !groupId) {
    return res.status(400).json({ success: false, message: 'authId, phoneNumber, and groupId are required.' });
  }
  const serverUrl = await getAssignedServerUrl(authId, phoneNumber);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No assigned bot server' });

  try {
    const response = await axios.get(`${serverUrl}/api/group-settings`, {
      params: { authId, phoneNumber, groupId }
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error fetching group settings:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;