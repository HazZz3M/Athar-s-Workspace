import { createClient } from '@supabase/supabase-js';

// Fall back to the project's public values so `npm run dev` works without a .env file
const url = import.meta.env.VITE_SUPABASE_URL ?? 'https://bupgddkyfugczweqiotc.supabase.co';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_FXvXCDhHc6naRZvRsPHa6w_DcjwRyv-';

export const supabase = createClient(url, key);
