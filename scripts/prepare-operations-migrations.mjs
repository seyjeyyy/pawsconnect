import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../supabase/',import.meta.url);
const files=['202610110015_operations_center.sql','202610110016_session_and_alert_controls.sql','202610110017_remove_mfa_requirement.sql'];
for(const [name,selected] of [['APPLY_015_TO_017.sql',files],['APPLY_017.sql',files.slice(2)]]){
 const source=selected.map(file=>readFileSync(new URL(`migrations/${file}`,root),'utf8')).join('\n\n');
 writeFileSync(new URL(name,root),`-- PawsConnect upgrade: review and paste into the Supabase SQL editor.\n-- Use 015_TO_017 only if neither 015 nor 016 has been applied; otherwise use 017 after both.\n-- No connection or execution is performed by the generator.\nbegin;\n${source}\nnotify pgrst, 'reload schema';\ncommit;\n`,'utf8');
 console.info(`Prepared supabase/${name}. Nothing was applied.`);
}
