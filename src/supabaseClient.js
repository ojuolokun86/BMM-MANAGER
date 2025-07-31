import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://wjpelhrjclljpgqeavyp.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndqcGVsaHJqY2xsanBncWVhdnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDI4ODU5NjEsImV4cCI6MjA1ODQ2MTk2MX0.GYElBivNvVqO433WyV9zzPGsjj91axbY3CD8-eqOnCo';

if (!supabaseUrl) {
  throw new Error('SUPABASE_URL must be set in environment variables');
}
if (!supabaseKey) {
  throw new Error('SUPABASE_KEY must be set in environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Supabase client initialized successfully');
export default supabase;