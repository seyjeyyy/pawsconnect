import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../supabase/',import.meta.url);
const files=['202610110015_operations_center.sql','202610110016_session_and_alert_controls.sql'];
const source=files.map(file=>readFileSync(new URL(`migrations/${file}`,root),'utf8')).join('\n\n');
writeFileSync(new URL('APPLY_015_TO_016.sql',root),`-- PawsConnect operations upgrade: review and paste into the Supabase SQL editor.\n-- No connection or execution is performed by the generator.\nbegin;\n${source}\nnotify pgrst, 'reload schema';\ncommit;\n`,'utf8');
console.info('Prepared supabase/APPLY_015_TO_016.sql. Nothing was applied.');
