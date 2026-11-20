import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=8000){const start=Date.now();while(Date.now()-start<ms){try{const v=await fn();if(v)return v;}catch{}await sleep(90);}throw Error('Timed out');}
test('API: file enqueue → pull claim → spans → review → artifact → replay',async()=>{
 const temp=mkdtempSync(path.join(os.tmpdir(),'railflow-test-'));
 const port=30000+Math.floor(Math.random()*25000);
 const api=`http://127.0.0.1:${port}`;
 const proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,RAILFLOW_HOME:temp,PORT:String(port)},stdio:'ignore'});
 const post=async(route,body={})=>{const r=await fetch(api+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
   await until(async()=>{const r=await fetch(api+'/api/state');return r.ok;});
   const init=await post('/api/demo',{review:true});assert.equal(init.status,201);
   const id=init.body.job.id;
   const claim=await post('/api/jobs/claim',{agent:'demo',worker:'test-worker'});
   assert.equal(claim.body.job.id,id);
   const second=await post('/api/jobs/claim',{agent:'demo'});assert.equal(second.body.job,null);
   const send=async(type,stage,message='')=>post(`/api/jobs/${id}/events`,{type,stage,message});
   await send('stage.started','ingest');await send('stage.succeeded','ingest');
   await send('stage.started','analysis');await send('stage.failed','analysis','failed once');await send('stage.retry','analysis');
   await send('stage.started','analysis');await send('stage.succeeded','analysis');
   await send('review.required','validate','please inspect');
   let state=await (await fetch(api+'/api/state')).json();
   assert.equal(state.jobs[0].status,'review');
   assert.equal(state.jobs[0].stages[2].attempts,2);
   assert.equal(state.events.filter(e=>e.type==='stage.failed').length,1);
   const approval=await post(`/api/jobs/${id}/approve`);assert.equal(approval.status,200);
   const resumed=await post('/api/jobs/claim',{agent:'demo'});assert.equal(resumed.body.job.id,id);
   const out=path.join(temp,'artifacts',id,'report.html');mkdirSync(path.dirname(out),{recursive:true});writeFileSync(out,'<h1>Hello</h1>');
   const artifact=await post(`/api/jobs/${id}/events`,{type:'artifact.created',stage:'publish',artifact:{name:'report.html'}});
   assert.equal(artifact.status,200);
   await send('job.completed',null,'done');
   const file=await fetch(`${api}/artifacts/${id}/report.html`);
   assert.equal(file.status,200);
   assert.match(file.headers.get('content-security-policy'),/sandbox/);
   state=await (await fetch(api+'/api/state')).json();
   assert.equal(state.jobs[0].status,'done');
   assert.equal(state.jobs[0].artifacts.length,1);
   const logs=await fetch(`${api}/api/jobs/${id}/logs`);
   assert.equal(logs.status,200);
   assert.match(logs.headers.get('content-disposition'),/attachment/);
   const logText=await logs.text();
   assert.match(logText,/stage.failed \[analysis\] failed once/);
   assert.match(logText,/review.approved/);
   const noLogs=await fetch(`${api}/api/jobs/run_deadbeef/logs`);
   assert.equal(noLogs.status,404);
   assert.ok(existsSync(path.join(temp,'data','events.jsonl')));
   const html=await fetch(api+'/');assert.equal(html.status,200);
   // Dashboard scripts and styles must be loadable; only generated artifacts get the sandbox CSP.
   assert.match(html.headers.get('content-security-policy'),/script-src 'self'/);
   assert.doesNotMatch(html.headers.get('content-security-policy'),/sandbox/);
   assert.match(await html.text(),/RAILFLOW/);
   // A filesystem event (without the upload API) should create a new queued job.
   writeFileSync(path.join(temp,'inbox','watch_test.csv'),'x,y\n1,2\n2,3\n');
   const watched=await until(async()=>{
     const result=await (await fetch(api+'/api/state')).json();
     return result.jobs.find(x=>x.file==='watch_test.csv');
   },6500);
   assert.equal(watched.status,'queued');
 }finally{proc.kill('SIGTERM');await sleep(200);rmSync(temp,{recursive:true,force:true});}
});
