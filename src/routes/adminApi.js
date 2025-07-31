
import express from 'express';
import axios from 'axios';
import { assignServerForUser, getSessionAssignments } from '../services/loadBalancer.js';
import { getServerStatus, getServerStatusArray} from '../services/healthMonitor.js'; // Make sure this function exists and is exported
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js'; 
import dotenv from 'dotenv';
dotenv.config();
import crypto from 'node:crypto';
const serversPath = path.resolve('src/config/botServers.json');
const botServers = JSON.parse(fs.readFileSync(serversPath, 'utf-8'));


import {
  getTotalUsers,
  getActiveSessions,
  getFailedLogins24h,
  getSubscriptionBreakdown,
  getHealthyServers,
  getTotalServers,
  getUsageOverTime,
  getServerLoad,
  getRecentUsers,
  getRecentBotActivity,
  getRecentFailedLogins
} from '../services/dashboardStats.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const router = express.Router();
// GET /admin/users-info
router.get('/users-info', async (req, res) => {
  const serverUrl = await assignServerForUser(); // Get any available server for admin actions
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No available bot server' });

  try {
    const response = await axios.get(`${serverUrl}/api/admin/users-info`);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error fetching users info:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/bots
router.get('/bots', async (req, res) => {
  try {
    const allBots = [];
    // Query each bot server in parallel
    const results = await Promise.allSettled(
      botServers.map(async (server) => {
        try {
          const response = await axios.get(`${server.url}/api/admin/bots`);
          if (Array.isArray(response.data.bots)) {
            // Optionally add server info to each bot
            response.data.bots.forEach(bot => {
              bot.server_id = server.id;
              bot.server_name = server.name;
            });
            return response.data.bots;
          }
        } catch (err) {
          console.error(`Failed to fetch bots from ${server.url}:`, err.message);
          return [];
        }
      })
    );
    // Flatten results
    results.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        allBots.push(...result.value);
      }
    });
    res.json({ success: true, bots: allBots });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/bots/:authId
router.get('/bots/:authId', async (req, res) => {
  console.log('🌐 Proxying /admin/bots/:authId...');
  const { authId } = req.params;
  if (!authId) return res.status(400).json({ success: false, message: 'authId is required.' });

  const serverUrl = await assignServerForUser(authId);
  if (!serverUrl) return res.status(503).json({ success: false, message: 'No available bot server' });

  try {
    const response = await axios.get(`${serverUrl}/api/admin/bots/${authId}`);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('❌ Error fetching bots for admin:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// GET /admin/servers
router.get('/servers', async (req, res) => {
  try {
    const statusArr = await getServerStatusArray(); // returns [{ id, healthy, ... }]
    const merged = botServers.map(server => {
      const live = statusArr.find(s => s.id === server.id) || {};
      return {
        ...server,
        healthy: live.healthy ?? false, // <-- This should match the in-memory status
        load: live.load ?? 0,
        userCount: live.userCount ?? 0,
        lastSeen: live.lastSeen ?? null
      };
    });
    //console.log('Merged servers sent to frontend:', merged);
    res.json({ success: true, servers: merged });
  } catch (err) {
    console.error('❌ Error fetching servers for admin:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});
// List all plans (static)
router.get('/subscriptions', async (req, res) => {
  //console.log('🌐 Admin subscriptions request received', req.body);
  try {
    const { data, error } = await supabase
      .from('subscription_tokens')
      .select('user_auth_id, subscription_level, expiration_date, created_at');
    if (error) throw error;
    //console.log('🌐 Admin subscriptions:', data);
    res.json({ success: true, subscriptions: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Subscribe a user to a plan
router.post('/subscribe', async (req, res) => {
  //console.log('📥 Subscribe request received');
  let { user_auth_id, plan, duration_days, bot_limit } = req.body;
  if (!user_auth_id || !plan || !duration_days) {
    //console.log('📥 Subscribe request received', req.body);
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Map 'free' to 'trier' for DB
  if (plan === 'free') plan = 'trier';

  // Validate plan
  const validPlans = ['trier', 'basic', 'gold', 'premium'];
  if (!validPlans.includes(plan)) {
    //console.log('Invalid plan', req.body);
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const expiration_date = new Date(Date.now() + duration_days * 24 * 60 * 60 * 1000);
  const token_id = crypto.randomBytes(16).toString('hex');

  try {
    // Remove any existing subscription for this user (enforce unique_user_auth_id)
    await supabase
      .from('subscription_tokens')
      .delete()
      .eq('user_auth_id', user_auth_id);

    // Insert new subscription
    const insertObj = {
      user_auth_id,
      subscription_level: plan,
      expiration_date: expiration_date.toISOString(),
      created_at: new Date().toISOString(),
      token_id,
    };
    if (bot_limit !== undefined) insertObj.bot_limit = bot_limit;

    const { data, error } = await supabase
      .from('subscription_tokens')
      .insert([insertObj])
      .select();
    if (error) throw error;
    //console.log('📤 Subscription created:', data[0]);
    res.json({ success: true, subscription: data[0] });
  } catch (err) {
    //console.error('📤 Subscription creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List all plans (static)
router.get('/plans', (req, res) => {
  res.json({ plans: ['free', 'basic', 'gold', 'premium'] });
});


router.get('/dashboard-stats', async (req, res) => {
  try {
    // Example: fetch from Supabase or your DBs
    // Replace with your actual DB queries!
    const totalUsers = await getTotalUsers();
    const activeSessions = await getActiveSessions();
    const failedLogins = await getFailedLogins24h();
    const subscriptionBreakdown = await getSubscriptionBreakdown();
    const healthyServers = await getHealthyServers();
    const totalServers = await getTotalServers();
    const usageOverTime = await getUsageOverTime();
    const serverLoad = await getServerLoad();
    const recentUsers = await getRecentUsers();
    const recentBotActivity = await getRecentBotActivity();
    const recentFailedLogins = await getRecentFailedLogins();
    //console.log('Active sessions:', activeSessions)
    res.json({
      totalUsers,
      activeSessions,
      failedLogins,
      subscriptionBreakdown,
      healthyServers,
      totalServers,
      usageOverTime,
      serverLoad,
      recentUsers,
      recentBotActivity,
      recentFailedLogins
    });
    //console.log('Active sessions:', activeSessions)
    console.log('📤 Getting dashboard stats:', serverLoad)
  } catch (err) {
    console.error('📤 Getting dashboard stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});




router.delete('/user/:authId', async (req, res) => {
  const { authId } = req.params;
  if (!authId) return res.status(400).json({ success: false, message: 'authId is required.' });

  // 1. Supabase deletion (always attempt)
  let supabaseResult = { success: true, errors: [] };
  try {
    await supabase.from('user_auth').delete().eq('auth_id', authId);
    await supabase.from('sessions').delete().eq('authId', authId);
    await supabase.from('subscriptions').delete().eq('user_auth_id', authId);
  } catch (err) {
    supabaseResult.success = false;
    supabaseResult.errors.push(err.message);
  }

  // 2. Local bot server deletion (parallel)
  const deleteResults = await Promise.allSettled(
    botServers.map(server =>
      axios.delete(`${server.url}/api/admin/user/${encodeURIComponent(authId)}`)
        .then(r => ({ server: server.name, success: true, message: r.data.message }))
        .catch(e => ({
          server: server.name,
          success: false,
          message: e.response?.data?.message || e.message
        }))
    )
  );
  const summary = deleteResults.map(r =>
    r.status === 'fulfilled' ? r.value : { server: 'unknown', success: false, message: r.reason?.message }
  );

  res.json({
    supabase: supabaseResult,
    botServers: summary,
    success: supabaseResult.success && summary.some(r => r.success),
    message: 'User deleted from Supabase and all bot servers (where found).'
  });
});
export default router;