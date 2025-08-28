import supabase from '../supabaseClient.js';


/**
 * Get user subscription info by user_auth_id
 * Returns: { subscription_level, bot_limit, expiration_date, daysLeft, token_id }
 */
export async function getUserSubscriptionInfo(user_auth_id) {
  const { data, error } = await supabase
    .from('subscription_tokens')
    .select('subscription_level, bot_limit, expiration_date, token_id')
    .eq('user_auth_id', user_auth_id)
    .single();

  if (error || !data) return null;

  // Calculate days left
  const expirationDate = new Date(data.expiration_date);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24)));

  return {
    subscription_level: data.subscription_level,
    bot_limit: data.bot_limit,
    expiration_date: data.expiration_date,
    daysLeft,
    token_id: data.token_id
  };
}