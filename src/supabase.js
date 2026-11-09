import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://dfbapqhtxuklagjxlgra.supabase.co';
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_HJK323KTicVv4EMSeDaMRg_iLQ96fb-';

if (!url || !key) {
  console.warn('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
}

export const supabase = createClient(url, key, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
});
