import { createClient } from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL;
const key=import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = url && key ? createClient(url,key,{global:{fetch:(input,init)=>fetch(input,{...init,signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})}}) : null;
