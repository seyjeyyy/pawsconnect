import { spawn } from 'node:child_process';
// Empty process values take precedence over both workspaces' .env files.
// Never reuse the developer's API, which may point at the live database.
const env={...process.env,NODE_ENV:'test',SUPABASE_URL:'',SUPABASE_ANON_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',ASSISTANT_API_KEY:'',RESEND_API_KEY:'',RESEND_FROM:'',OPERATIONS_WORKER_SECRET:'',OPERATIONS_WORKER_KINDS:'',SUPABASE_MANAGEMENT_TOKEN:'',SUPABASE_PROJECT_REF:'',VITE_SUPABASE_URL:'',VITE_SUPABASE_ANON_KEY:'',VITE_API_URL:'/api',PORT:'4100',CLIENT_URL:'http://localhost:4173',API_PROXY_TARGET:'http://127.0.0.1:4100'};
const children=[
 spawn(process.execPath,['--import','tsx','server/src/index.ts'],{env,stdio:'inherit',windowsHide:true}),
 spawn(process.execPath,['node_modules/vite/bin/vite.js','client','--port','4173','--host','localhost'],{env,stdio:'inherit',windowsHide:true}),
];
const stop=()=>children.forEach(child=>child.kill());
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('exit',stop);
for(const child of children)child.on('exit',code=>{stop();process.exit(code||0);});
