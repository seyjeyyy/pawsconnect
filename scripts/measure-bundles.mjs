import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
const files=readdirSync('client/dist/assets').filter(name=>name.endsWith('.js'));
const modules=files.map(name=>{const bytes=readFileSync(`client/dist/assets/${name}`);return {file:name,bytes:bytes.length,gzipBytes:gzipSync(bytes).length};});
const report={scope:'Local Vite production build; chunk sizes are not Core Web Vitals',baseline:{entry:{bytes:816640,gzipBytes:248560},account:{bytes:428220,gzipBytes:124530},note:'Rounded values captured from the original build before edits'},measuredAt:new Date().toISOString(),modules};
writeFileSync('docs/optimization-bundles.json',JSON.stringify(report,null,2)+'\n');
for(const row of modules.filter(row=>/^(index|Account|Auth|FinancialOverview)-/.test(row.file)))console.info(row);
