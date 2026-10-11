import {useQuery} from '@tanstack/react-query';
import {api} from '../lib/api';
export function MaintenanceNotice(){
 const query=useQuery({queryKey:['operations-status'],queryFn:({signal})=>api<{active:boolean;mode:string;public_notice:string;ends_at?:string;modules?:string[]}>('/operations/status',{signal}),retry:false});
 if(!query.data?.active)return null;
 return <aside className="maintenance-banner" role="status"><strong>{query.data.mode==='read_only'?'Read-only mode':'Service maintenance'}</strong><span>{query.data.public_notice || 'Some services are temporarily paused.'}</span>{query.data.ends_at&&<small>Scheduled end: {new Date(query.data.ends_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'})} (Manila)</small>}</aside>;
}
