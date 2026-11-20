import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync, readdirSync, watch, createReadStream } from 'node:fs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.RAILFLOW_HOME ? path.resolve(process.env.RAILFLOW_HOME) : ROOT;
const INBOX = path.join(HOME, 'inbox');
const DATA = path.join(HOME, 'data');
const ARTIFACTS = path.join(HOME, 'artifacts');
const WORK = path.join(HOME, 'work');
const EVENTS = path.join(DATA, 'events.jsonl');
const MAX_UPLOAD = 20 * 1024 * 1024;
for (const dir of [INBOX,DATA,ARTIFACTS,WORK]) mkdirSync(dir,{recursive:true});

const STAGES = [
  { key:'ingest', label:'取込・形式検証', short:'Ingest' },
  { key:'preprocess', label:'前処理・校正', short:'Preprocess' },
  { key:'analysis', label:'データ解析', short:'Analysis' },
  { key:'validate', label:'科学的妥当性確認', short:'Validation' },
  { key:'visualize', label:'図表・可視化', short:'Visualization' },
  { key:'publish', label:'HTML / PPTX生成', short:'Publish' }
];
const jobs = new Map();
const allEvents = [];
const subscribers = new Set();
const observed = new Map();
let eventSerial = 0;

function rebuild(event) {
  allEvents.push(event);
  eventSerial = Math.max(eventSerial, Number(event.sequence)||0);
  if (event.type === 'job.created') {
    if (jobs.has(event.jobId)) return;
    jobs.set(event.jobId, {
      id:event.jobId, file:event.file, bytes:event.bytes, hash:event.hash, createdAt:event.at,
      demo:event.demo||false, needsReview:!!event.needsReview, status:'queued',
      agent:null, worker:null, startedAt:null, finishedAt:null, stages:STAGES.map(s=>({...s,status:'pending',attempts:0,startedAt:null,endedAt:null})),
      artifacts:[], events:[event], reviewApproved:false, lastMessage:'新しいファイルを検出'
    });
    return;
  }
  const j = jobs.get(event.jobId);
  if (!j) return;
  j.events.push(event);
  if (event.message) j.lastMessage = event.message;
  const step = j.stages.find(s=>s.key===event.stage);
  switch(event.type) {
    case 'job.claimed': j.status='running'; j.startedAt ||=event.at; j.agent=event.agent||'demo'; j.worker=event.worker; break;
    case 'stage.started':
      if(step){step.status='running'; step.attempts++; step.startedAt=event.at; step.endedAt=null;}
      break;
    case 'stage.succeeded': if(step){step.status='success';step.endedAt=event.at;} break;
    case 'stage.failed': if(step){step.status='failed';step.endedAt=event.at;} break;
    case 'stage.retry': if(step){step.status='retry';} break;
    case 'review.required': j.status='review'; if(step) step.status='review'; break;
    case 'review.approved': j.reviewApproved=true; j.status='queued'; if(step) step.status='success'; break;
    case 'artifact.created':
      if(event.artifact && !j.artifacts.some(a=>a.name===event.artifact.name)) j.artifacts.push(event.artifact);
      break;
    case 'job.completed': j.status='done';j.finishedAt=event.at; break;
    case 'job.failed': j.status='failed';j.finishedAt=event.at; break;
  }
}
if(existsSync(EVENTS)) {
  for(const line of readFileSync(EVENTS,'utf8').split(/\r?\n/).filter(Boolean)) {
    try{ rebuild(JSON.parse(line)); }catch(err){console.error('Skipping broken event:',err.message);}
  }
}
function appendEvent(data){
  const event={...data,at:new Date().toISOString(),sequence:++eventSerial};
  appendFileSync(EVENTS,JSON.stringify(event)+'\n');
  rebuild(event);
  const payload=`data: ${JSON.stringify({sequence: event.sequence})}\n\n`;
  for(const res of subscribers){try{res.write(payload);}catch{subscribers.delete(res);}}
  return event;
}
function cleanName(value){
  const normalized=String(value||'').replaceAll('\\','/').split('/').at(-1);
  return (normalized||'data.csv').replace(/[^\p{L}\p{N}_.()\- ]/gu,'_').slice(0,110).replace(/^\.+/,'_');
}
function deliverJSON(res,data,code=200){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
function readBody(req,limit=100000){return new Promise((resolve,reject)=>{
  let size=0; const parts=[];
  req.on('data',c=>{size+=c.length;if(size>limit){reject(new Error('Payload too large'));req.destroy();}else parts.push(c);});
  req.on('end',()=>resolve(Buffer.concat(parts)));
  req.on('error',reject);
});}
function enqueue(file,{demo=false,needsReview=false}={}){
  const basename=cleanName(file);
  const absolute=path.join(INBOX,basename);
  const bytes=readFileSync(absolute);
  const hash=createHash('sha256').update(bytes).digest('hex');
  // Deduplicate file arrivals; new content (including a corrected file) becomes a new job.
  const existing=Array.from(jobs.values()).find(j=>j.file===basename&&j.hash===hash);
  if(existing)return existing;
  const id='run_'+randomUUID().slice(0,8);
  appendEvent({type:'job.created',jobId:id,file:basename,bytes:bytes.length,hash,demo,needsReview});
  mkdirSync(path.join(WORK,id),{recursive:true});
  mkdirSync(path.join(ARTIFACTS,id),{recursive:true});
  return jobs.get(id);
}
function scanInbox(){
  let names=[];
  try{ names=readdirSync(INBOX); }catch{return;}
  for(const name of names){
    if(!/\.(csv|tsv|json|txt|dat)$/i.test(name))continue;
    try{
      const st=statSync(path.join(INBOX,name)); if(!st.isFile()||st.size>MAX_UPLOAD)continue;
      const signature=`${st.size}:${st.mtimeMs}`;
      const previous=observed.get(name);
      if(previous?.signature===signature){
        // Require a stable fingerprint across more than one scan before ingesting.
        if(!previous.ingested && Date.now()-previous.seenAt>1200 && Date.now()-st.mtimeMs>700){
          observed.set(name,{signature,seenAt:previous.seenAt,ingested:true}); enqueue(name);
        }
      }else{ observed.set(name,{signature,seenAt:Date.now(),ingested:false}); }
    }catch{}
  }
}
// Native file event for responsiveness; the timer handles missed/coalesced events and partial writes.
try { const watcher=watch(INBOX,{persistent:false},()=>{const timer=setTimeout(scanInbox,350);timer.unref();});watcher.on('error',err=>console.warn('Inbox watcher:',err.message)); }
catch(err){console.warn('FS watch unavailable; using polling fallback:',err.message);}
setInterval(scanInbox,1000).unref();
scanInbox();

function makeSample(review=false){
  const id=randomUUID().slice(0,6);
  const name=`LiMg_XPS_${id}.csv`;
  const rows=['BindingEnergy_eV,Intensity_a_u'];
  for(let i=0;i<=140;i++){
    const x=50+i*.08;
    const y=140+650*Math.exp(-(((x-54.1)/.48)**2))+370*Math.exp(-(((x-56.4)/.7)**2))+Math.sin(i*1.7)*9;
    rows.push(`${x.toFixed(3)},${y.toFixed(2)}`);
  }
  writeFileSync(path.join(INBOX,name),rows.join('\n'));
  return enqueue(name,{demo:true,needsReview:review});
}
function serveFile(res, filepath, type, method='GET', artifact=false){
  if(!existsSync(filepath)||!statSync(filepath).isFile()){res.writeHead(404);res.end('Not found');return;}
  const headers={'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'};
  if(artifact && type.startsWith('text/html')) headers['content-security-policy']="sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'";
  else if(type.startsWith('text/html')) headers['content-security-policy']="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  res.writeHead(200,headers);
  if(method==='HEAD'){res.end();return;}
  createReadStream(filepath).pipe(res);
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json; charset=utf-8','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.csv':'text/csv; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  const pathname=decodeURIComponent(url.pathname);
  try{
    if(pathname==='/api/state'&&req.method==='GET') return deliverJSON(res,{jobs:[...jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),events:allEvents.slice(-300),stages:STAGES,updatedAt:new Date().toISOString()});
    if(pathname==='/api/stream'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
      res.write('retry: 1500\n\n'); subscribers.add(res);
      const keep=setInterval(()=>{try{res.write(': ping\n\n');}catch{}},12000);
      req.on('close',()=>{clearInterval(keep);subscribers.delete(res);});return;
    }
    if(pathname==='/api/demo'&&req.method==='POST'){
      const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');
      return deliverJSON(res,{job:makeSample(!!body.review)},201);
    }
    if(pathname==='/api/upload'&&req.method==='POST'){
      const name=cleanName(url.searchParams.get('filename'));
      if(!/\.(csv|tsv|txt|json|dat)$/i.test(name))return deliverJSON(res,{error:'Supported extensions: csv,tsv,txt,json,dat'},400);
      const body=await readBody(req,MAX_UPLOAD);
      if(!body.length)return deliverJSON(res,{error:'Empty file'},400);
      const safe=`${path.parse(name).name.slice(0,70)}_${randomUUID().slice(0,5)}${path.extname(name)}`;
      writeFileSync(path.join(INBOX,safe),body,{flag:'wx'});
      return deliverJSON(res,{job:enqueue(safe)},201);
    }
    if(pathname==='/api/jobs/claim'&&req.method==='POST'){
      const body=JSON.parse((await readBody(req)).toString('utf8')||'{}');
      const j=[...jobs.values()].filter(x=>x.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
      if(!j)return deliverJSON(res,{job:null});
      appendEvent({type:'job.claimed',jobId:j.id,agent:String(body.agent||'demo').slice(0,30),worker:String(body.worker||os.hostname()).slice(0,80)});
      return deliverJSON(res,{job:jobs.get(j.id),paths:{input:path.join(INBOX,j.file),work:path.join(WORK,j.id),artifacts:path.join(ARTIFACTS,j.id)}});
    }
    // GitHub Actions-style raw run logs. They come from the same durable event store.
    const logMatch=pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/logs$/);
    if(logMatch&&(req.method==='GET'||req.method==='HEAD')){
      const j=jobs.get(logMatch[1]);
      if(!j)return deliverJSON(res,{error:'Job not found'},404);
      const output=[`Railflow run ${j.id}`,`File: ${j.file}`,`Status: ${j.status}`,`Agent: ${j.agent||'unassigned'}`,`Created: ${j.createdAt}`,'',
        ...j.events.map(e=>`[${e.at}] ${e.type}${e.stage?' ['+e.stage+']':''} ${e.message||''}${e.details?'\n  '+e.details.replace(/\n/g,'\n  '):''}`)].join('\n')+'\n';
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename="${j.id}.log"`,'cache-control':'no-store','x-content-type-options':'nosniff'});
      res.end(req.method==='HEAD'?'':output);return;
    }
    const eventMatch=pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/events$/);
    if(eventMatch&&req.method==='POST'){
      const j=jobs.get(eventMatch[1]);if(!j)return deliverJSON(res,{error:'Job not found'},404);
      const input=JSON.parse((await readBody(req,100000)).toString('utf8')||'{}');
      const types=new Set(['stage.started','stage.progress','stage.succeeded','stage.failed','stage.retry','review.required','artifact.created','job.completed','job.failed','agent.event']);
      if(!types.has(input.type))return deliverJSON(res,{error:'Unsupported event'},400);
      if(input.stage&&!STAGES.some(s=>s.key===input.stage))return deliverJSON(res,{error:'Unsupported stage'},400);
      if(input.type==='artifact.created'){
        const n=String(input.artifact?.name||'');
        if(!n||n!==path.basename(n)||!existsSync(path.join(ARTIFACTS,j.id,n)))return deliverJSON(res,{error:'Artifact not found'},400);
        input.artifact={name:n,uri:`/artifacts/${j.id}/${encodeURIComponent(n)}`,bytes:statSync(path.join(ARTIFACTS,j.id,n)).size};
      }
      appendEvent({type:input.type,jobId:j.id,stage:input.stage||null,message:String(input.message||'').slice(0,600),artifact:input.artifact,details:input.details?String(input.details).slice(0,1300):undefined});
      return deliverJSON(res,{ok:true});
    }
    const reviewMatch=pathname.match(/^\/api\/jobs\/(run_[a-f0-9]{8})\/approve$/);
    if(reviewMatch&&req.method==='POST'){
      const j=jobs.get(reviewMatch[1]);if(!j)return deliverJSON(res,{error:'Job not found'},404);
      if(j.status!=='review')return deliverJSON(res,{error:'Not in review'},409);
      appendEvent({type:'review.approved',jobId:j.id,stage:'validate',message:'人間がレビューを承認'});
      return deliverJSON(res,{ok:true});
    }
    if(pathname.startsWith('/artifacts/')&&(req.method==='GET'||req.method==='HEAD')){
      const m=pathname.match(/^\/artifacts\/(run_[a-f0-9]{8})\/([^/]+)$/);
      if(!m||!jobs.has(m[1]))return deliverJSON(res,{error:'Not found'},404);
      const artifact=decodeURIComponent(m[2]);
      if(artifact!==path.basename(artifact))return deliverJSON(res,{error:'Invalid path'},400);
      const file=path.join(ARTIFACTS,m[1],artifact);
      return serveFile(res,file,mime[path.extname(file)]||'application/octet-stream',req.method,true);
    }
    if(req.method==='GET'||req.method==='HEAD'){
      const segment=pathname==='/'?'index.html':pathname.slice(1);
      if(segment.includes('..')||segment.startsWith('.'))return deliverJSON(res,{error:'Invalid path'},400);
      const file=path.resolve(ROOT,'public',segment);
      if(!file.startsWith(path.join(ROOT,'public')+path.sep))return deliverJSON(res,{error:'Invalid path'},400);
      return serveFile(res,file,mime[path.extname(file)]||'application/octet-stream',req.method,false);
    }
    deliverJSON(res,{error:'Unknown route'},404);
  }catch(err){console.error('Request error:',err);if(!res.headersSent)deliverJSON(res,{error:err.message||'Unexpected error'},500);}
});
const PORT=Number(process.env.PORT||4173);
server.listen(PORT,process.env.HOST||'127.0.0.1',()=>{
  const addr=server.address(); console.log(`Railflow monitor listening on http://127.0.0.1:${addr.port}`);
});
