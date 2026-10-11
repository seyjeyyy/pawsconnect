import { Compass, Heart, HeartHandshake, LayoutDashboard, MapPin, PawPrint, ShieldCheck, ShoppingBag, Sparkles, Truck, UserRound, Database, Activity, Settings, type LucideIcon } from 'lucide-react';
import { workspaceSections } from '../../lib/roles';
export type Step={route:string;targets?:string[];icon:LucideIcon;title:string;body:string};
const workspace=(section:string,title:string,body:string,icon:LucideIcon=LayoutDashboard):Step=>({route:`/admin/${section}`,targets:['.dashboard-main'],icon,title,body});
export function tourFor(roles:string[]) {
 const allowed=workspaceSections(roles);
 if(roles.includes('super_administrator'))return {key:'system-v2',steps:[
  workspace('security','Your system workspace','Manage accounts, access and platform security here. Shelter operations have their own separately authorized workspace.',ShieldCheck),
  workspace('users','People and permissions','Review real accounts and assigned roles. Elevated access requires a request and a different super administrator’s approval.',UserRound),
  workspace('operations','IT Operations','Inspect measured service health and integration configuration. Unavailable telemetry is labeled explicitly.',Activity),
  workspace('operations/backups','Backup coverage','Review provider inventory and verified worker reports. Database backups alone do not include uploaded Storage files.',Database),
  workspace('operations/recovery','Restore and recovery','Request a staging drill with a verified recovery point and independent approval. Production restore requires an external recovery coordinator.',ShieldCheck),
  workspace('operations/maintenance','Maintenance controls','Schedule read-only, partial, full or emergency maintenance. Every setting expires automatically within 24 hours.',Settings),
  workspace('operations/incidents','Incident response','Record investigations, assign responders, and keep a resolution timeline. Only actual records appear here.',Activity),
  workspace('audit_logs','A protected audit trail','Review account, configuration and recovery activity. Your account settings are available from the workspace sidebar.',ShieldCheck),
 ]};
 const privileged=roles.some(r=>['administrator','shelter_staff','veterinarian','rescue_personnel','shelter_driver'].includes(r));
 if(privileged){
  const candidates=[workspace('overview','Your operations workspace','Find live operational counts, export reports and manage the services your role is authorized to use.'),
   workspace('pets','Animals in care','Review recorded pet profiles and care needs. Behaviour assessments inform compatibility guidance.',PawPrint),
   workspace('health','Health records','Add verified medical observations. Saved medical history is permanent.',Heart),
   workspace('adoptions','Adoption reviews','Review applications, arrange interviews and complete authorized handovers. An application does not reserve a pet.',Heart),
   workspace('rescue',roles.includes('rescue_personnel')?'Your rescue assignments':'Rescue coordination','Review verified reports and authorized Bulacan coverage. Assigned responders update progress and record outcome notes.',MapPin),
   workspace('transport',roles.includes('shelter_driver')?'Your transport jobs':'Transport coordination','Review assignments and schedules. Drivers record pickup, travel and arrival; staff verify the handover.',Truck),
   workspace('orders','Orders and inventory','Follow recorded payments and order status. Test-mode payments remain separate from live revenue.',ShoppingBag)];
  return {key:`${roles.includes('administrator')?'administrator':roles.includes('shelter_staff')?'staff':roles.includes('veterinarian')?'veterinarian':roles.includes('rescue_personnel')?'rescuer':'driver'}-v2`,steps:candidates.filter(s=>allowed.includes(s.route.split('/').pop()!))};
 }
 return {key:roles.includes('volunteer')?'volunteer-v2':'community-v2',steps:[
  {route:'/',icon:PawPrint,title:'Welcome to PawsConnect',body:'Find a companion, shop for pet essentials and support rescue work in Bulacan. You can pause this tour and resume any time.'},
  {route:'/',targets:['.desktop-nav','.mobile-toggle'],icon:Compass,title:'Find your way',body:'Use this menu to browse services. Each service works independently, and your account keeps your records together.'},
  {route:'/adopt',targets:['.pet-filters','.page-intro'],icon:Heart,title:'Meet adoptable companions',body:'Filter available pets and open a profile to apply. Staff review every application; applying does not reserve a pet.'},
  {route:'/match',targets:['.quiz-options','.quiz-card'],icon:Sparkles,title:'Find a compatible companion',body:'Answer questions about your home and routine. Recommendations use available pets and their recorded care profiles. People make the adoption decision.'},
  {route:'/rescue',targets:['.location-picker','.page-intro'],icon:MapPin,title:'Report a stray',body:'Describe the animal and mark its location. Staff verify reports and approved Bulacan coverage before assigning a team.'},
  {route:'/transport',targets:['.tabs','.page-intro'],icon:Truck,title:'Plan a safe journey',body:'Request authorized transport in supported areas. Outside coverage, submit an alternative arrangement for manual review.'},
  {route:'/shop',targets:['.catalog-toolbar','.page-intro'],icon:ShoppingBag,title:'Shop and track orders',body:'Browse essentials and check stock. The server verifies prices and reserves inventory; Stripe confirms completed payments.'},
  {route:'/donate',targets:['.donation-amounts','.page-intro'],icon:HeartHandshake,title:'Support everyday care',body:'Offer supplies or make a one-time donation. Your account records confirmed support separately from shop purchases.'},
  {route:'/account',targets:['.account-sidebar','.account-gate'],icon:UserRound,title:'Your records and updates',body:'Sign in to track orders, applications, reports and notifications. Profile and account settings are available here.'},
  ...(roles.includes('volunteer')?[{route:'/account/volunteer',targets:['.dashboard-main'],icon:HeartHandshake,title:'Your volunteer tasks',body:'Review your assigned tasks and update progress. Rescue assignments, when authorized, have a separate workspace.'}]:[]),
 ] as Step[]};
}
