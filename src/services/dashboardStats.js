import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const serversPath = path.resolve('src/config/botServers.json');
const botServers = JSON.parse(fs.readFileSync(serversPath, 'utf-8'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export async function getTotalUsers() {
  const { count } = await supabase
    .from('user_auth')
    .select('*', { count: 'exact', head: true });
  return count || 0;
}

export async function getActiveSessions() {
  let total = 0;
  await Promise.all(botServers.map(async (server) => {
    try {
      const res = await axios.get(`${server.url}/api/admin/load`);
      total += res.data.userCount || 0;
    } catch (e) {
      console.error(`Failed to fetch user count from ${server.url}:`, e.message);
    }
  }));
  return total;
}

export async function getFailedLogins24h() {
  // Example: count failed logins in last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('login_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('success', false)
    .gte('timestamp', since);
  return count || 0;
}

// ...implement the rest similarly
export async function getSubscriptionBreakdown() {
    const plans = ['trier', 'basic', 'gold', 'premium'];
    // Always initialize all keys to 0
    const breakdown = { free: 0, basic: 0, gold: 0, premium: 0 };
  
    for (const plan of plans) {
      try {
        const { count, error } = await supabase
          .from('subscription_tokens')
          .select('*', { count: 'exact', head: true })
          .eq('subscription_level', plan);
        if (error) {
          console.error(`Error counting ${plan} subscriptions:`, error);
          continue;
        }
        breakdown[plan === 'trier' ? 'free' : plan] = count || 0;
      } catch (err) {
        console.error(`Exception counting ${plan} subscriptions:`, err);
        // continue, key remains 0
      }
    }
    return breakdown;
  }
export async function getUsageOverTime() {
    // We'll aggregate logins per day for the last 7 days
    const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since = sinceDate.toISOString().slice(0, 10); // YYYY-MM-DD
  
    // Adjust this query to your real table and timestamp column!
    // Here, we assume you have a 'login_attempts' table with a 'timestamp' column and 'success' boolean.
    const { data, error } = await supabase
      .from('login_attempts')
      .select('timestamp')
      .eq('success', true)
      .gte('timestamp', since);
  
    if (error) {
      // Return empty data on error
      return { labels: [], sessions: [] };
    }
  
    // Count logins per day
    const counts = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000);
      const day = d.toISOString().slice(0, 10);
      counts[day] = 0;
    }
  
    data.forEach(row => {
      const day = row.timestamp.slice(0, 10);
      if (counts[day] !== undefined) counts[day]++;
    });
  
    const labels = Object.keys(counts);
    const sessions = Object.values(counts);
  
    return { labels, sessions };
  }

  export async function getRecentUsers() {
    const { data, error } = await supabase
      .from('user_auth')
      .select('email, subscription_level, created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) return [];
    return data.map(row => ({
      email: row.email,
      plan: row.subscription_level,
      dateJoined: row.created_at
    }));
  }
// For server health, usage, load, recent users, etc. use your actual tables and logic
import { getServerStatusArray } from './healthMonitor.js';

export async function getHealthyServers() {
    const servers = await getServerStatusArray();
    // Defensive: always return a number
    if (!Array.isArray(servers)) return 0;
    //console.log('Healthy servers:', servers.filter(s => s.healthy).length);
    return servers.filter(s => s.healthy).length;
  }
  
  export async function getTotalServers() {
    const servers = await getServerStatusArray();
    // Defensive: always return a number
    if (!Array.isArray(servers)) return 0;
    //console.log('Total servers:', servers.length);
    return servers.length;
  }
  export async function getServerLoad() {
    const servers = await getServerStatusArray();
    if (!Array.isArray(servers)) return { labels: [], load: [] };
  
    // Collect server names and their load values
    const labels = servers.map(s => s.id || s.name || 'Unknown');
    const load = servers.map(s => typeof s.load === 'number' ? s.load : 0);
  
    return { labels, load };
  }
  export async function getRecentBotActivity() {
    let allActivity = [];
    await Promise.all(botServers.map(async (server) => {
        try {
            const res = await axios.get(`${server.url}/api/admin/bot-activity`);
            if (Array.isArray(res.data.activity)) {
                allActivity = allActivity.concat(res.data.activity);
            }
        } catch (e) {
            console.error(`Failed to fetch bot activity from ${server.url}:`, e.message);
        }
    }));
    allActivity.sort((a, b) => b.time - a.time);
    //console.log(allActivity);
    return allActivity.slice(0, 10);
}
export async function getRecentFailedLogins() {
    const { data, error } = await supabase
      .from('login_attempts')
      .select('email, timestamp, reason')
      .eq('success', false)
      .order('timestamp', { ascending: false })
      .limit(5);
    if (error) return [];
    return data.map(row => ({
      user: row.email,
      time: row.timestamp,
      reason: row.reason
    }));
  }