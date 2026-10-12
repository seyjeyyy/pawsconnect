import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
type Auth = { user: User | null; profile?: { full_name: string }; roles: string[]; permissions: string[]; rolesLoading: boolean; rolesError: Error | null; configured: boolean; loading: boolean;
 signIn: (email: string,password: string) => Promise<void>; signUp: (name: string,email: string,password: string) => Promise<void>; signOut: () => Promise<void>; resetPassword: (email: string) => Promise<void>; updatePassword: (password: string) => Promise<void> };
const Context = createContext<Auth | null>(null);
function client() { if (!supabase) throw new Error('Accounts are unavailable until Supabase is connected.'); return supabase; }
export function AuthProvider({ children }: { children: ReactNode }) {
 const [user,setUser] = useState<User|null>(null), [loading,setLoading] = useState(!!supabase);
 const [sessionError,setSessionError] = useState<Error|null>(null);
 const cache = useQueryClient(); const previous = useRef<string | null | undefined>(undefined);
 useEffect(() => {
  if (!supabase) return; let active = true, observed = false;
  supabase.auth.getSession().then(({data,error}) => { if(active && !observed) { setUser(data.session?.user || null); setSessionError(error); setLoading(false); } }).catch(error => { if(active && !observed) {setSessionError(error);setLoading(false);} });
  const {data} = supabase.auth.onAuthStateChange((_event,session) => { observed=true;setUser(session?.user || null);setSessionError(null);setLoading(false); });
  return () => { active=false;data.subscription.unsubscribe(); };
 },[]);
 useLayoutEffect(() => {
  if(loading) return;
  const current=user?.id ?? null;
  // The first resolved session has nothing to clear; resetting here fetched every query twice.
  if(previous.current === undefined) { previous.current=current; return; }
  if(previous.current !== current) {
   // Leaving an account (sign-out or switch) clears everything it loaded.
   if(previous.current !== null) void cache.resetQueries();
   previous.current=current;
  }
 },[loading,user?.id,cache]);
 const identity = useQuery({ queryKey: ['identity',user?.id], enabled: !!user, queryFn: ({signal}) => api<{full_name:string;roles:string[];permissions:string[]}>('/auth/me',{signal}) });
 const value: Auth = { user,profile: user ? identity.data : undefined,roles: user && !identity.error ? identity.data?.roles || [] : [],permissions:user && !identity.error ? identity.data?.permissions || [] : [],loading,rolesLoading: !!user && identity.isPending,rolesError: sessionError || identity.error,configured: !!supabase,
  async signIn(email,password) { const {error}=await client().auth.signInWithPassword({email,password});if(error)throw error; },
  async signUp(name,email,password) { const {error}=await client().auth.signUp({email,password,options:{data:{full_name:name},emailRedirectTo:`${location.origin}/auth/callback`}});if(error)throw error; },
  async signOut() { const {error}=await client().auth.signOut();if(error)throw error; },
  async resetPassword(email) { const {error}=await client().auth.resetPasswordForEmail(email,{redirectTo:`${location.origin}/auth/reset`});if(error)throw error; },
  async updatePassword(password) { const {error}=await client().auth.updateUser({password});if(error)throw error; },
 };
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
// Private page state (open dialogs, drafts, carts) must never survive an account change.
// The stored session resolving on first load is not an account change: remounting then
// aborted and repeated every request the page had already started.
export function AccountBoundary({children}:{children:ReactNode}) {
 const {user,loading}=useAuth(); const seen=useRef<string|null|undefined>(undefined), generation=useRef(0);
 if(!loading) { const current=user?.id ?? null; if(seen.current !== undefined && seen.current !== current) generation.current+=1; seen.current=current; }
 return <div key={generation.current} style={{display:'contents'}}>{children}</div>;
}
export function useAuth() { const value=useContext(Context);if(!value)throw new Error('AuthProvider missing');return value; }
