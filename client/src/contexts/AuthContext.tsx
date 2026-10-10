import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {User} from '@supabase/supabase-js';
import {useQueryClient} from '@tanstack/react-query';
import {supabase} from '../lib/supabase';
import {api} from '../lib/api';
type Auth = {user:User|null;roles:string[];configured:boolean;loading:boolean;signIn:(email:string,password:string)=>Promise<void>;signUp:(name:string,email:string,password:string)=>Promise<void>;signOut:()=>Promise<void>;resetPassword:(email:string)=>Promise<void>;updatePassword:(password:string)=>Promise<void>};
const Context=createContext<Auth|null>(null);
function client(){if(!supabase)throw new Error('Accounts are not connected yet. Configure Supabase to enable secure sign-in.');return supabase;}
export function AuthProvider({children}:{children:ReactNode}){
 const [user,setUser]=useState<User|null>(null),[roles,setRoles]=useState<string[]>([]),[loading,setLoading]=useState(!!supabase);const queryClient=useQueryClient();const previousUserId=useRef<string|undefined>(undefined);
 useEffect(()=>{if(!supabase)return;let active=true;supabase.auth.getSession().then(({data})=>{if(active){setUser(data.session?.user||null);setLoading(false);}});const {data}=supabase.auth.onAuthStateChange((_event,session)=>{setUser(session?.user||null);setLoading(false);});return()=>{active=false;data.subscription.unsubscribe();};},[]);
 // Cached data belongs to one account: reset it when the signed-in user changes. Not on mount, and never clear(), which would orphan queries that are already in flight.
 useEffect(()=>{setRoles([]);if(previousUserId.current!==user?.id){if(previousUserId.current!==undefined||user)void queryClient.resetQueries();previousUserId.current=user?.id;}if(!user)return;let active=true;api<{roles:string[]}>('/auth/me').then(result=>{if(active)setRoles(result.roles||[]);}).catch(()=>{});return()=>{active=false;};},[user?.id,queryClient]);
 const value:Auth={user,roles,loading,configured:!!supabase,
 async signIn(email,password){const {error}=await client().auth.signInWithPassword({email,password});if(error)throw error;},
 async signUp(name,email,password){const {error}=await client().auth.signUp({email,password,options:{data:{full_name:name},emailRedirectTo:`${location.origin}/auth/callback`}});if(error)throw error;},
 async signOut(){const {error}=await client().auth.signOut();if(error)throw error;setRoles([]);},
 async resetPassword(email){const {error}=await client().auth.resetPasswordForEmail(email,{redirectTo:`${location.origin}/auth/reset`});if(error)throw error;},
 async updatePassword(password){const {error}=await client().auth.updateUser({password});if(error)throw error;}};
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAuth(){const context=useContext(Context);if(!context)throw new Error('AuthProvider is missing');return context;}
