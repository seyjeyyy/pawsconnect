import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
type Auth = { user: User | null; profile?: { full_name: string }; roles: string[]; rolesLoading: boolean; rolesError: Error | null; configured: boolean; loading: boolean;
 signIn: (email: string,password: string) => Promise<void>; signUp: (name: string,email: string,password: string) => Promise<void>; signOut: () => Promise<void>; resetPassword: (email: string) => Promise<void>; updatePassword: (password: string) => Promise<void> };
const Context = createContext<Auth | null>(null);
function client() { if (!supabase) throw new Error('Accounts are unavailable until Supabase is connected.'); return supabase; }
export function AuthProvider({ children }: { children: ReactNode }) {
 const [user,setUser] = useState<User|null>(null), [loading,setLoading] = useState(!!supabase);
 const [sessionError,setSessionError] = useState<Error|null>(null);
 const cache = useQueryClient(); const previous = useRef<string | undefined>(undefined);
 useEffect(() => {
  if (!supabase) return; let active = true;
  supabase.auth.getSession().then(({data,error}) => { if(active) { setUser(data.session?.user || null); setSessionError(error); setLoading(false); } }).catch(error => { if(active) {setSessionError(error);setLoading(false);} });
  const {data} = supabase.auth.onAuthStateChange((_event,session) => { setUser(session?.user || null);setSessionError(null);setLoading(false); });
  return () => { active=false;data.subscription.unsubscribe(); };
 },[]);
 useEffect(() => {
  if(previous.current !== user?.id) {
   if(previous.current !== undefined || user) void cache.resetQueries();
   previous.current=user?.id;
  }
 },[user?.id,cache]);
 const identity = useQuery({ queryKey: ['identity',user?.id], enabled: !!user, queryFn: () => api<{full_name:string;roles:string[]}>('/auth/me') });
 const value: Auth = { user,profile: user ? identity.data : undefined,roles: user && !identity.error ? identity.data?.roles || [] : [],loading,rolesLoading: !!user && identity.isPending,rolesError: sessionError || identity.error,configured: !!supabase,
  async signIn(email,password) { const {error}=await client().auth.signInWithPassword({email,password});if(error)throw error; },
  async signUp(name,email,password) { const {error}=await client().auth.signUp({email,password,options:{data:{full_name:name},emailRedirectTo:`${location.origin}/auth/callback`}});if(error)throw error; },
  async signOut() { const {error}=await client().auth.signOut();if(error)throw error; },
  async resetPassword(email) { const {error}=await client().auth.resetPasswordForEmail(email,{redirectTo:`${location.origin}/auth/reset`});if(error)throw error; },
  async updatePassword(password) { const {error}=await client().auth.updateUser({password});if(error)throw error; },
 };
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
// Private page state (open dialogs, drafts, carts) must never survive an account change.
export function AccountBoundary({children}:{children:ReactNode}) { const {user}=useAuth(); return <div key={user?.id || 'anonymous'} style={{display:'contents'}}>{children}</div>; }
export function useAuth() { const value=useContext(Context);if(!value)throw new Error('AuthProvider missing');return value; }
