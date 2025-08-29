
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

// Map of subscription plans to their bot limits
const PLAN_LIMITS = {
  'trier': 1,    // Free tier
  'basic': 1,    // Basic tier
  'gold': 3,     // Gold tier
  'premium': 5   // Premium tier
};

// Subscribe a user to a plan
router.post('/subscribe', async (req, res) => {
  console.log('📥 Subscribe request received:', req.body);
  let { user_auth_id, plan, duration_days, bot_limit } = req.body;
  
  if (!user_auth_id || !plan || !duration_days) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required fields: user_auth_id, plan, and duration_days are required' 
    });
  }

  // Map 'free' to 'trier' for DB
  if (plan === 'free') plan = 'trier';

  // Validate plan
  const validPlans = Object.keys(PLAN_LIMITS);
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ 
      success: false,
      error: `Invalid plan. Must be one of: ${validPlans.join(', ')}` 
    });
  }

  // Calculate expiration date
  const expiration_date = new Date();
  expiration_date.setDate(expiration_date.getDate() + parseInt(duration_days));

  try {
    // Get the bot limit for the plan (use provided bot_limit if it's less than plan's max)
    const planBotLimit = PLAN_LIMITS[plan];
    const finalBotLimit = bot_limit && bot_limit <= planBotLimit 
      ? parseInt(bot_limit) 
      : planBotLimit;

    // Check if a subscription already exists for this user
    const existingRes = await supabase
      .from('subscription_tokens')
      .select('id, token_id')
      .eq('user_auth_id', parseInt(user_auth_id))
      .maybeSingle();

    if (existingRes.error && existingRes.error.code !== 'PGRST116') throw existingRes.error; // propagate non-not-found errors

    let data, error;

    if (existingRes.data) {
      // Update existing row (keep original token_id)
      ({ data, error } = await supabase
        .from('subscription_tokens')
        .update({
          subscription_level: plan,
          expiration_date: expiration_date.toISOString(),
          bot_limit: finalBotLimit,
        })
        .eq('user_auth_id', parseInt(user_auth_id))
        .select());
    } else {
      // Insert new row with generated token_id (NOT NULL)
      const token_id = (crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex'));
      ({ data, error } = await supabase
        .from('subscription_tokens')
        .insert({
          user_auth_id: parseInt(user_auth_id),
          token_id,
          subscription_level: plan,
          expiration_date: expiration_date.toISOString(),
          bot_limit: finalBotLimit,
        })
        .select());
    }

    if (error) throw error;

    res.json({ 
      success: true, 
      subscription: {
        ...data[0],
        bot_limit: finalBotLimit
      } 
    });

  } catch (err) {
    console.error('❌ Error in subscribe:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process subscription',
      details: err.message 
    });
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