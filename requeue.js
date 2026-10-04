'use strict';
const fs = require('fs'), path = require('path'), net = require('net');
require('dotenv').config({path:path.join(__dirname,'.env'),quiet:true});
const barcode = process.argv[2];
if (!barcode) throw Error('Usage: node requeue.js "EXACT_BARCODE". Stop the worker first and verify no WhatsApp message arrived.');
const server=net.createServer();
server.on('error',()=>{console.error('Port occupied: stop the monitor and its child process first.');process.exit(1)});
server.listen(Number(process.env.DASHBOARD_PORT||8080),process.env.DASHBOARD_HOST||'127.0.0.1',()=>{
  try {
    const journal=path.join(__dirname,'data','notifications.jsonl');
    const raw=fs.readFileSync(journal,'utf8');
    if(raw&&!raw.endsWith('\n'))throw Error('Incomplete journal tail: start and stop the worker before retrying.');
    const records=new Map(raw.split('\n').filter(Boolean).map(line=>{const r=JSON.parse(line);return [r.key,r]}));
    const matches=[...records.values()].filter(r=>String(r.row.BARCODE_ID)===barcode&&r.status==='uncertain');
    const fd=fs.openSync(journal,'a');
    try {for(const r of matches){const bytes=Buffer.from(JSON.stringify({...r,status:'pending',error:null,manuallyRequeuedAt:new Date().toISOString()})+'\n');let i=0;while(i<bytes.length)i+=fs.writeSync(fd,bytes,i,bytes.length-i);}fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
    console.log(`Requeued ${matches.length} uncertain record(s). Restart the monitor.`);
  } finally {server.close()}
});
