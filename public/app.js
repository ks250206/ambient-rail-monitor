const $=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let data={jobs:[],events:[],stages:[]};
let selectedId=null;
let selectedStage=null;
let lastSeq=0;
let loading=false;
let refreshPending=false;
let toastTimer=null;
const statusText={queued:'Queued',running:'Running',review:'Needs review',done:'Completed',failed:'Failed'};
const cols=[{id:'queued',label:'Queued',hint:'Waiting for a worker'},{id:'running',label:'Running',hint:'Agent is processing'},{id:'review',label:'Review / blocked',hint:'Needs intervention'},{id:'done',label:'Completed',hint:'Finished workflows'}];
const NOW=()=>Date.now();
const dateMs=d=>d?new Date(d).getTime():null;
function elapsed(a,b=NOW()) {if(!a)return '—';let sec=Math.max(0,Math.floor((b-dateMs(a))/1000));let h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return h?`${h}h ${String(m).padStart(2,'0')}m`:m?`${m}m ${String(s).padStart(2,'0')}s`:`${s}s`;}
function axisTime(sec){return sec>=3600?`${(sec/3600).toFixed(sec%3600===0?0:1)}h`:sec>=60?`${Math.round(sec/60)}m`:`${Math.round(sec)}s`;}
function clock(t){return t?new Date(t).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';}
function bytes(n){return n>1000000?`${(n/1000000).toFixed(1)} MB`:n>1000?`${(n/1000).toFixed(1)} KB`:`${n} B`;}
function currentJob(){return data.jobs.find(j=>j.id===selectedId)||null;}
function showToast(text,error=false){const el=$('toast');el.textContent=text;el.className='toast visible'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='toast',3900);}
async function post(route,payload){const res=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const answer=await res.json();if(!res.ok)throw Error(answer.error||'Request failed');return answer;}
async function refresh(){
  if(loading){refreshPending=true;return;}
  loading=true;
  try{const response=await fetch('/api/state',{cache:'no-store'});if(!response.ok)throw Error(`${response.status}`);data=await response.json();$('serverLight').className='server-light connected';$('connectionLabel').textContent='Local server online';if(!currentJob())selectedId=data.jobs[0]?.id||null;if(!selectedStage){const j=currentJob();selectedStage=j?.stages.find(s=>['running','review','failed'].includes(s.status))?.key||j?.stages.find(s=>s.status==='success')?.key||'ingest';}render();}catch(err){$('connectionLabel').textContent='Disconnected';$('serverLight').className='server-light';}finally{loading=false;if(refreshPending){refreshPending=false;queueMicrotask(refresh);}}
}
function chooseJob(id){selectedId=id;actionsShowAllLogs=false;const j=currentJob();selectedStage=j?.stages.find(s=>['running','review','retry','failed'].includes(s.status))?.key||j?.stages.find(s=>s.status==='success')?.key||'ingest';render();}
function chooseStage(stage){selectedStage=stage;actionsShowAllLogs=false;renderPanels();renderActionsPanels();}
function metrics(){
 const jobs=data.jobs;
 const completed=jobs.filter(j=>j.status==='done');
 const avg=completed.length?completed.reduce((n,j)=>n+(dateMs(j.finishedAt)-dateMs(j.startedAt)),0)/completed.length:0;
 const entries=[
  {label:'Total workflows',value:jobs.length,foot:'All jobs from local event store',icon:'◈'},
  {label:'Active agents',value:jobs.filter(j=>j.status==='running').length,foot:'Currently claimed and executing',icon:'⌘',color:'green'},
  {label:'Awaiting review',value:jobs.filter(j=>['review','failed'].includes(j.status)).length,foot:'Manual checks or failed jobs',icon:'◷',color:'amber'},
  {label:'Avg. run duration',value:completed.length?axisTime(avg/1000):'—',foot:'From claim to completion',icon:'◴'}];
 $('metrics').innerHTML=entries.map(e=>`<div class="metric"><div class="metric-head"><span>${e.label}</span><span class="metric-icon">${e.icon}</span></div><div class="metric-val ${e.color||''}">${escapeHtml(e.value)}</div><div class="metric-foot">${e.foot}</div></div>`).join('');
}
function card(job){
  const done=job.stages.filter(s=>s.status==='success').length;
  const active=job.stages.find(s=>['running','review','failed','retry'].includes(s.status));
  const tag=job.status==='running'?active?.short||'Running':job.status==='review'?'Approval required':job.status==='failed'?'Failed':'6-stage pipeline';
  const start=job.startedAt||job.createdAt;
  return `<button class="job-card ${job.id===selectedId?'selected':''}" data-job="${escapeHtml(job.id)}" title="${escapeHtml(job.lastMessage)}"><span class="job-code">${escapeHtml(job.id)}</span><strong class="job-name">${escapeHtml(job.file)}</strong><span class="job-sub">${escapeHtml(tag)}</span><div class="mini-progress"><div class="mini-fill" style="width:${done/6*100}%"></div></div><span class="job-bottom"><span class="job-agent">${escapeHtml((job.agent||'unassigned').toUpperCase())}</span><span>${done}/6 · ${elapsed(start,job.finishedAt?dateMs(job.finishedAt):NOW())}</span></span></button>`;
}
function board(){
 $('kanban').innerHTML=cols.map(c=>{
   const jobs=data.jobs.filter(j=>c.id==='review'?['review','failed'].includes(j.status):j.status===c.id);
   return `<div class="kanban-column"><div class="column-head"><span class="column-dot ${c.id}"></span><b>${c.label}</b><span class="column-count">${jobs.length}</span></div>${jobs.length?jobs.slice(0,5).map(card).join(''):`<div class="empty-col">${c.hint}</div>`}</div>`;
 }).join('');
 document.querySelectorAll('[data-job]').forEach(el=>el.addEventListener('click',()=>chooseJob(el.dataset.job)));
}
// GitHub Actions-inspired view: one durable run, many observable stages, and one log stream.
let actionsFilter='all';
let actionsPage=0;
let actionsShowAllLogs=false;
const ACTIONS_PAGE_SIZE=7;
const expandedAttempts=new Map();
const actionIcons={queued:'○',running:'◉',review:'!',done:'✓',failed:'×'};
const actionLabels={queued:'Queued',running:'In progress',review:'Review needed',done:'Success',failed:'Failed'};
const actionStatus=(s)=>s==='success'?'done':s==='pending'?'queued':s==='retry'?'running':s;
const clockDate=t=>t?new Date(t).toLocaleString('ja-JP',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
function actionSeconds(total){
 total=Math.max(0,Math.floor(total));
 const hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;
 return hours?`${hours}h ${String(minutes).padStart(2,'0')}m ${String(seconds).padStart(2,'0')}s`:`${String(minutes).padStart(2,'0')}m ${String(seconds).padStart(2,'0')}s`;
}
function actionDuration(start,end){return start?actionSeconds(((end?dateMs(end):NOW())-dateMs(start))/1000):'—';}
function actionStatusMark(status){
 const state=actionStatus(status);
 return `<span class="actions-status-icon ${escapeHtml(state)}" aria-label="${escapeHtml(actionLabels[state]||state)}">${actionIcons[state]||'·'}</span>`;
}
function renderActionsList(){
 const query=$('actionsRunSearch').value.trim().toLowerCase();
 const all=data.jobs.filter(j=>{
  const match=actionsFilter==='all'||(actionsFilter==='running'?['queued','running'].includes(j.status):actionsFilter==='review'?['review','failed'].includes(j.status):j.status===actionsFilter);
  return match&&(!query||`${j.id} ${j.file} ${j.agent||''} ${j.worker||''}`.toLowerCase().includes(query));
 });
 const totalPages=Math.max(1,Math.ceil(all.length/ACTIONS_PAGE_SIZE));
 actionsPage=Math.min(actionsPage,totalPages-1);
 const page=all.slice(actionsPage*ACTIONS_PAGE_SIZE,(actionsPage+1)*ACTIONS_PAGE_SIZE);
 $('actionsRunCount').textContent=data.jobs.length;
 const list=$('actionsRunList'),priorScroll=list.scrollTop;
 list.innerHTML=page.length?page.map(j=>{
  const done=j.stages.filter(s=>s.status==='success').length;
  const completed=j.status==='done'?'Completed':j.status==='review'?'Attention required':j.status==='failed'?'Execution failed':j.status==='running'?'Processing':'Waiting for worker';
  const duration=j.startedAt?actionDuration(j.startedAt,j.finishedAt):'Queued';
  return `<button class="actions-run-row ${j.id===selectedId?'selected':''}" type="button" data-action-job="${escapeHtml(j.id)}" aria-pressed="${j.id===selectedId}">
   <span class="actions-run-state">${actionStatusMark(j.status)}</span>
   <span class="actions-run-info"><strong>${escapeHtml(j.file)}</strong><span class="actions-run-desc">Experiment analysis <span class="actions-middle-dot">·</span> ${escapeHtml((j.agent||'unassigned').toUpperCase())}</span><span class="actions-run-foot">${escapeHtml(j.id)} <span>·</span> ${clockDate(j.createdAt)}</span></span>
   <span class="actions-run-meta"><span class="actions-run-result ${escapeHtml(j.status)}">${completed}</span><span class="actions-run-runtime" ${j.startedAt&&!j.finishedAt?'data-live-elapsed="'+j.startedAt+'"':''}>${duration}</span><span class="actions-run-progress">${done}/${j.stages.length} steps</span></span>
  </button>`;
 }).join(''):`<div class="actions-empty"><span>⌕</span><strong>No matching runs</strong><small>${data.jobs.length?'Try another status or search term.':'Drop a file or start a demo run.'}</small></div>`;
 list.scrollTop=priorScroll;
 $('actionsPageInfo').textContent=all.length?`${actionsPage*ACTIONS_PAGE_SIZE+1}–${Math.min((actionsPage+1)*ACTIONS_PAGE_SIZE,all.length)} of ${all.length}`:'0 runs';
 $('actionsPrevious').disabled=actionsPage===0;
 $('actionsNext').disabled=actionsPage+1>=totalPages;
 document.querySelectorAll('[data-run-filter]').forEach(el=>{el.classList.toggle('active',el.dataset.runFilter===actionsFilter);el.setAttribute('aria-pressed',String(el.dataset.runFilter===actionsFilter));});
}
function renderActionsHeader(j){
 if(!j){$('actionsRunHeader').innerHTML='<div class="actions-empty">Select a workflow run to inspect its logs.</div>';return;}
 const completed=j.stages.filter(s=>s.status==='success').length;
 const queueTime=j.startedAt?actionDuration(j.createdAt,j.startedAt):actionDuration(j.createdAt);
 const runDuration=j.startedAt?actionDuration(j.startedAt,j.finishedAt):'—';
 const activeSeconds=getSpans(j).reduce((total,s)=>total+Math.max(0,((s.end||NOW())-s.start)/1000),0);
 const running=Number(j.status==='running');
 const label=j.demo?'Manual demo':'File detected';
 $('actionsRunHeader').innerHTML=`<div class="actions-header-eyebrow"><span class="actions-workflow-tag">⌁ &nbsp; Experiment analysis</span><span class="actions-run-reference">${escapeHtml(j.id)}</span></div>
  <div class="actions-run-heading"><div><h3>${escapeHtml(j.file)}</h3><p>${actionStatusMark(j.status)} <span>${escapeHtml(actionLabels[j.status]||j.status)}</span> <span class="actions-middle-dot">·</span> ${label} <span class="actions-middle-dot">·</span> ${clockDate(j.createdAt)}</p></div><div class="actions-run-header-buttons">${j.status==='review'?'<button class="actions-review-button" data-action-approve="true" type="button">✓ Approve & resume</button>':''}${j.artifacts.length?`<a class="actions-jump" href="${escapeHtml(j.artifacts[0].uri)}" target="_blank" rel="noopener noreferrer">${j.artifacts.length} artifacts ↗</a>`:''}<a class="actions-jump" href="#trace">Trace explorer ↗</a></div></div>
  <div class="actions-run-facts"><div><span>PROGRESS</span><strong>${completed}<small> / ${j.stages.length}</small> <span class="actions-fact-hint">${running?'Running':'steps'}</span></strong><div class="actions-micro-progress"><span style="width:${completed/j.stages.length*100}%"></span></div></div><div><span>RUN TIME</span><strong ${j.startedAt&&!j.finishedAt?'data-live-elapsed="'+j.startedAt+'"':''}>${runDuration}</strong><small>${actionSeconds(activeSeconds)} stage active</small></div><div><span>QUEUE WAIT</span><strong ${!j.startedAt?'data-live-queue="'+j.createdAt+'"':''}>${queueTime}</strong><small>from file event</small></div><div><span>RUNNER</span><strong class="actions-runner-name">${escapeHtml((j.agent||'unassigned').toUpperCase())}</strong><small title="${escapeHtml(j.worker||'Not claimed')}">${escapeHtml(j.worker||'Not claimed')}</small></div></div>`;
}
function renderActionsStages(j){
 $('actionsStepsCount').textContent=j?`${j.stages.length} steps`:'';
 if(!j){$('actionsStageList').innerHTML='<div class="actions-empty">No workflow selected.</div>';return;}
 const spans=getSpans(j);
 $('actionsStageList').innerHTML=j.stages.map((s,i)=>{
  const status=actionStatus(s.status);
  const duration=s.startedAt?actionDuration(s.startedAt,s.endedAt):'—';
  const retry=spans.filter(sp=>sp.stage===s.key).length;
  return `<button class="actions-step-row ${selectedStage===s.key&&!actionsShowAllLogs?'selected':''}" data-action-stage="${escapeHtml(s.key)}" type="button" aria-pressed="${selectedStage===s.key&&!actionsShowAllLogs}">
   ${actionStatusMark(status)}<span class="actions-step-body"><strong>${escapeHtml(s.short)}</strong><small>${escapeHtml(s.label)}</small></span>
   <span class="actions-step-side"><span class="actions-step-duration" ${s.status==='running'?'data-live-elapsed="'+s.startedAt+'"':''}>${duration}</span>${retry>1?`<span class="actions-attempt-count" title="${retry} attempts">↻ ${retry}</span>`:''}</span>
  </button>`;
 }).join('')+`<button class="actions-all-logs ${actionsShowAllLogs?'selected':''}" data-action-all="true" type="button">☷ &nbsp; All run events <span>${j.events.length} ↗</span></button>`;
}
function actionEventLevel(e){
 if(['stage.failed','job.failed'].includes(e.type))return 'error';
 if(['stage.retry','review.required'].includes(e.type))return 'warning';
 if(['stage.succeeded','job.completed','artifact.created','review.approved'].includes(e.type))return 'success';
 return 'normal';
}
function actionEventText(e){
 const name=e.type==='agent.event'?'agent':e.type;
 return `${e.message||name}${e.details?'\n'+e.details:''}`;
}
function actionMatchesSearch(e,q){
 return !q||`${e.message||''} ${e.details||''} ${e.type} ${e.stage||''}`.toLowerCase().includes(q);
}
function actionLogLine(e,query){
 if(!actionMatchesSearch(e,query))return '';
 const level=actionEventLevel(e);
 const stage=e.stage?`<span class="actions-log-stage">[${escapeHtml(e.stage)}]</span> `:'';
 return `<div class="actions-log-line ${level}"><span class="actions-log-timestamp">${clock(e.at)}</span><span class="actions-log-level">${level==='error'?'✗':level==='warning'?'!':level==='success'?'✓':'›'}</span><span class="actions-log-text">${stage}<span>${escapeHtml(e.message||e.type)}</span>${e.details?`<pre>${escapeHtml(e.details)}</pre>`:''}</span></div>`;
}
function renderActionsLogs(j){
 const box=$('actionsLogLines'),prevScroll=box.scrollTop;
 const query=$('actionsLogSearch').value.trim().toLowerCase();
 $('actionsDownload').href=j?`/api/jobs/${encodeURIComponent(j.id)}/logs`:'#actions';
 $('actionsDownload').setAttribute('aria-disabled',String(!j));
 $('actionsLogTitle').textContent=!j?'Step logs':actionsShowAllLogs?'All run logs':`${j.stages.find(s=>s.key===selectedStage)?.short||'Step'} / logs`;
 box.classList.toggle('hide-time',!$('actionsShowTimestamps').checked);
 if(!j){box.innerHTML='<div class="actions-logs-empty">Run a workflow to see step output.</div>';$('actionsConsoleBottom').textContent='No events';return;}
 const history=actionsShowAllLogs?j.events:j.events.filter(e=>e.stage===selectedStage);
 const found=history.filter(e=>actionMatchesSearch(e,query));
 let html='';
 if(actionsShowAllLogs){
  html=found.map(e=>actionLogLine(e,query)).join('');
 }else{
  const groups=[];let group=null;
  for(const e of history){
   if(e.type==='stage.started'||!group){
    group={number:groups.length+1,events:[],start:e.at,end:null};groups.push(group);
   }
   group.events.push(e);
   if(['stage.succeeded','stage.failed'].includes(e.type))group.end=e.at;
  }
  html=groups.map((g,index)=>{
   const lines=g.events.map(e=>actionLogLine(e,query)).filter(Boolean).join('');
   if(!lines)return '';
   const key=`${j.id}:${selectedStage}:${g.number}`;
   const expanded=query?true:expandedAttempts.has(key)?expandedAttempts.get(key):index===groups.length-1;
   const failure=g.events.some(e=>e.type==='stage.failed');
   return `<div class="actions-log-attempt"><button class="actions-attempt-bar" data-attempt-toggle="${escapeHtml(key)}" type="button" aria-expanded="${expanded}"><span class="actions-attempt-chevron">${expanded?'⌄':'›'}</span><span>Attempt ${String(g.number).padStart(2,'0')}</span>${failure?'<span class="actions-attempt-failure">FAILED</span>':''}<span class="actions-attempt-elapsed">${g.end?actionDuration(g.start,g.end):'—'}</span></button>${expanded?`<div class="actions-attempt-lines">${lines}</div>`:''}</div>`;
  }).join('');
 }
 box.innerHTML=html||`<div class="actions-logs-empty">${query?'No log lines match your filter.':'No log entries yet. Events will appear as the agent progresses.'}</div>`;
 $('actionsConsoleBottom').innerHTML=`<span>${found.length} / ${history.length} events</span><span>${escapeHtml(j.agent||'awaiting worker')} <span class="actions-middle-dot">·</span> <span class="actions-live-dot ${j.status==='running'?'active':''}"></span> ${j.status==='running'?'Streaming':'Saved history'}</span>`;
 box.scrollTop=Math.min(prevScroll,box.scrollHeight);
}
function renderActions(){const j=currentJob();renderActionsList();renderActionsHeader(j);renderActionsStages(j);renderActionsLogs(j);}
function renderActionsPanels(){const j=currentJob();renderActionsHeader(j);renderActionsStages(j);renderActionsLogs(j);}

function getSpans(j){
 const spans=[];
 for(const event of j.events){
  if(event.type==='stage.started')spans.push({stage:event.stage,start:dateMs(event.at),end:null,status:'running',attempt:spans.filter(s=>s.stage===event.stage).length+1,events:[]});
  if(['stage.succeeded','stage.failed'].includes(event.type)){
    const span=[...spans].reverse().find(s=>s.stage===event.stage&&s.end===null);
    if(span){span.end=dateMs(event.at);span.status=event.type==='stage.failed'?'failed':'success';}
  }
  if(event.type==='agent.event'){
    const span=[...spans].reverse().find(s=>s.stage===event.stage&&s.end===null);
    if(span)span.events.push(event);
  }
 }
 return spans;
}
function selectedSummary(j){
 const done=j.stages.filter(s=>s.status==='success').length;
 const started=j.startedAt||j.createdAt;
 $('selectedRunId').textContent=j.id;
 $('selectedSummary').innerHTML=`<div class="selected-info"><b>${escapeHtml(j.file)}</b><small>${escapeHtml((j.agent||'UNASSIGNED').toUpperCase())} / ${bytes(j.bytes)} / ${elapsed(started,j.finishedAt?dateMs(j.finishedAt):NOW())} elapsed / ${done} of 6 completed</small></div><span class="status-pill ${j.status}">${statusText[j.status]||j.status}</span>`;
}
function railway(j){
 const spans=getSpans(j);const bads=new Set(spans.filter(s=>s.status==='failed').map(s=>s.stage));
 const nodes=j.stages.map((s,i)=>{
  const status=s.status;
  const icon=status==='success'?'✓':status==='running'?'◉':status==='retry'?'↻':status==='failed'?'×':status==='review'?'!':String(i+1).padStart(2,'0');
  const display=s.startedAt?elapsed(s.startedAt,s.endedAt?dateMs(s.endedAt):NOW()):'—';
  return `<button class="rail-node ${status} ${selectedStage===s.key?'selected':''}" data-stage="${s.key}"><div class="rail-circle">${icon}</div><b class="rail-label">${escapeHtml(s.short)}</b><span class="rail-time">${display}</span></button>`;
 });
 const taps=j.stages.map(s=>`<div class="fail-tap ${bads.has(s.key)?'is-failure':''}">${bads.has(s.key)?'↻ Retried':''}</div>`).join('');
 $('railwayView').innerHTML=`<div class="rail-nodes"><div class="rail-line"></div>${nodes.join('')}</div><div class="rail-failure-title">FAILURE / RECOVERY RAIL</div><div class="rail-failure-lane"><div class="fail-line"></div>${taps}</div>`;
 document.querySelectorAll('[data-stage]').forEach(el=>el.addEventListener('click',()=>chooseStage(el.dataset.stage)));
}
function inspector(j){
 const s=j.stages.find(s=>s.key===selectedStage)||j.stages[0];
 if(!s)return;
 const history=j.events.filter(e=>e.stage===s.key);
 const relevant=history.filter(e=>['stage.failed','stage.progress','stage.retry','stage.succeeded','stage.started','review.required','agent.event'].includes(e.type));
 const spanHistory=getSpans(j).filter(p=>p.stage===s.key);
 const latest=relevant.at(-1);
 const statusMap={pending:'Not started',success:'Succeeded',running:'In progress',retry:'Retrying',failed:'Failed',review:'Human review'};
 $('stepInspector').innerHTML=`<div class="stage-head"><strong>${escapeHtml(s.label)}</strong><span class="subline"><span>${s.short} / ${s.key}</span><span class="status-pill ${s.status==='success'?'':s.status==='review'?'review':s.status==='failed'?'failed':'running'}">${statusMap[s.status]||s.status}</span></span></div>
 <div class="kv"><span>Attempts</span><strong>${s.attempts}</strong></div>
 <div class="kv"><span>Elapsed</span><strong>${s.startedAt?elapsed(s.startedAt,s.endedAt?dateMs(s.endedAt):NOW()):'—'}</strong></div>
 <div class="kv"><span>Started at</span><strong>${clock(s.startedAt)}</strong></div>
 <div class="kv"><span>Agent events</span><strong>${history.filter(e=>e.type==='agent.event').length}</strong></div>
 <div class="kv"><span>Failed attempts</span><strong>${spanHistory.filter(e=>e.status==='failed').length}</strong></div>
 <div class="step-message">${escapeHtml(latest?.message||'この工程はまだ開始していません。')}</div>
 ${j.status==='review'?`<button class="approve" id="approveButton">✓ Reviewを承認して再開</button>`:''}`;
 $('approveButton')?.addEventListener('click',async()=>{try{await post(`/api/jobs/${j.id}/approve`,{});showToast('承認しました。Workerの次回claimで再開します。');await refresh();}catch(e){showToast(e.message,true);}});
}
function traces(j){
 const spans=getSpans(j);
 const start=spans.length?Math.min(...spans.map(s=>s.start)):dateMs(j.createdAt);
 const max=Math.max(NOW(),...spans.map(s=>s.end||NOW()));
 const actualEnd=j.finishedAt?dateMs(j.finishedAt):spans.length?Math.max(...spans.map(s=>s.end||NOW())):start+12000;
 const duration=Math.max(12000,actualEnd-start);
 const ticks=Array.from({length:5},(_,i)=>axisTime(duration/1000*i/4));
 $('traceSummary').innerHTML=`${spans.length} spans · ${elapsed(j.startedAt||j.createdAt,j.finishedAt?dateMs(j.finishedAt):NOW())} total`;
 if(!spans.length){$('traceContent').innerHTML='<div class="output-empty">No trace data yet. Workerがジョブを取得すると表示されます。</div>';return;}
 $('traceContent').innerHTML=`<div class="trace-header"><span class="dim mono">SPAN / ATTEMPT</span><div class="trace-axis">${ticks.map(t=>`<span>${t}</span>`).join('')}</div></div><div class="trace-rows">${spans.map(sp=>{
   const x=Math.max(0,(sp.start-start)/duration*100);const length=Math.max(1.5,((sp.end||NOW())-sp.start)/duration*100);
   const stage=j.stages.find(s=>s.key===sp.stage);
   return `<div class="trace-row"><span class="trace-row-label"><span>↳</span>${escapeHtml(stage?.short||sp.stage)} <span>#${sp.attempt}</span></span><div class="trace-track"><button class="trace-bar ${sp.status==='failed'?'fail':sp.status==='running'?'active':''}" data-trace="${sp.stage}" style="left:${Math.min(99,x).toFixed(2)}%;width:${Math.min(length,100-x).toFixed(2)}%" title="${escapeHtml(sp.stage)} attempt ${sp.attempt}: ${elapsed(new Date(sp.start).toISOString(),sp.end||NOW())}">${length>9?elapsed(new Date(sp.start).toISOString(),sp.end||NOW()):''}</button></div></div>`;
 }).join('')}</div>`;
 document.querySelectorAll('[data-trace]').forEach(el=>el.addEventListener('click',()=>chooseStage(el.dataset.trace)));
}
function events(j){
 const eventList=j.events.slice(-35).reverse();
 $('eventsList').innerHTML=eventList.length?eventList.map(e=>`<div class="event-row"><span class="event-time">${clock(e.at)}</span><span class="event-type ${e.type.includes('failed')?'fail':''}" title="${escapeHtml(e.type)}">${escapeHtml(e.type)}</span><span class="event-msg" title="${escapeHtml(e.message||'')}">${escapeHtml(e.message||e.stage||'Event received')}</span></div>`).join(''):'<div class="output-empty">No events yet.</div>';
}
function artifacts(j){
 $('artifactList').innerHTML=j.artifacts.length?j.artifacts.map(f=>{
   const type=f.name.toLowerCase().endsWith('.pptx')?'pptx':'html';
   return `<a class="artifact-item" target="_blank" rel="noopener noreferrer" href="${f.uri}"><span class="file-icon ${type}">${type.toUpperCase()}</span><span class="file-body"><b>${escapeHtml(f.name)}</b><small>${bytes(f.bytes)} · Open artifact</small></span><span class="download-icon">↗</span></a>`;
 }).join(''):'<div class="output-empty">工程の完了後、HTML / PPTXがここに表示されます。</div>';
}
function renderPanels(){const j=currentJob();if(!j){$('selectedRunId').textContent='—';$('selectedSummary').innerHTML='';$('railwayView').innerHTML='<div class="output-empty">Start a demo run to inspect a workflow.</div>';$('stepInspector').innerHTML='<div class="output-empty">Select a workflow.</div>';$('traceContent').innerHTML='<div class="output-empty">No trace available</div>';$('eventsList').innerHTML='';$('artifactList').innerHTML='';$('traceSummary').textContent='';return;}
 selectedSummary(j);railway(j);inspector(j);traces(j);events(j);artifacts(j);
}
function render(){metrics();board();renderActions();renderPanels();}
async function newDemo(review=false){
 try{const answer=await post('/api/demo',{review});selectedId=answer.job.id;selectedStage='ingest';showToast(review?'デモジョブを追加しました（レビュー承認あり）':'デモジョブを追加しました');await refresh();}catch(e){showToast(e.message,true);}
}
async function upload(file){
 if(!file)return;
 try{const result=await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});const answer=await result.json();if(!result.ok)throw Error(answer.error||'Upload failed');selectedId=answer.job.id;selectedStage='ingest';showToast(`${file.name} を投入しました`);await refresh();}catch(err){showToast(err.message,true);}
}
$('newDemoButton').addEventListener('click',e=>newDemo(e.shiftKey));
$('uploadButton').addEventListener('click',()=>$('uploadInput').click());
$('uploadInput').addEventListener('change',e=>{upload(e.target.files?.[0]);e.target.value='';});
$('refreshButton').addEventListener('click',refresh);
$('actionsRunHeader').addEventListener('click',async e=>{if(!e.target.closest('[data-action-approve]'))return;const j=currentJob();if(!j||j.status!=='review')return;try{await post(`/api/jobs/${j.id}/approve`,{});showToast('レビュー承認済み。Workerが次回claimで再開します。');await refresh();}catch(error){showToast(error.message,true);}});
$('actionsRunSearch').addEventListener('input',()=>{actionsPage=0;renderActionsList();});
$('actionsLogSearch').addEventListener('input',()=>renderActionsLogs(currentJob()));
$('actionsShowTimestamps').addEventListener('change',()=>renderActionsLogs(currentJob()));
$('actionsFilterTabs').addEventListener('click',e=>{const target=e.target.closest('[data-run-filter]');if(!target)return;actionsFilter=target.dataset.runFilter;actionsPage=0;renderActionsList();});
$('actionsRunList').addEventListener('click',e=>{const button=e.target.closest('[data-action-job]');if(button)chooseJob(button.dataset.actionJob);});
$('actionsStageList').addEventListener('click',e=>{const target=e.target.closest('[data-action-stage]');if(target){chooseStage(target.dataset.actionStage);return;}if(e.target.closest('[data-action-all]')){actionsShowAllLogs=true;renderActionsPanels();}});
$('actionsLogLines').addEventListener('click',e=>{const button=e.target.closest('[data-attempt-toggle]');if(!button)return;const key=button.dataset.attemptToggle;expandedAttempts.set(key,button.getAttribute('aria-expanded')!=='true');renderActionsLogs(currentJob());});
$('actionsPrevious').addEventListener('click',()=>{actionsPage=Math.max(0,actionsPage-1);renderActionsList();});
$('actionsNext').addEventListener('click',()=>{actionsPage++;renderActionsList();});
$('actionsDownload').addEventListener('click',e=>{if(!currentJob())e.preventDefault();});
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;$('dropOverlay').classList.add('visible');}});
document.addEventListener('dragleave',e=>{e.preventDefault();dragDepth--;if(dragDepth<=0){dragDepth=0;$('dropOverlay').classList.remove('visible');}});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});
document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropOverlay').classList.remove('visible');upload(e.dataTransfer?.files[0]);});
const source=new EventSource('/api/stream');source.onmessage=()=>refresh();source.onerror=()=>{$('connectionLabel').textContent='Reconnecting…';$('serverLight').className='server-light';};
function tick(){
 const c=new Date();$('clock').textContent=c.toLocaleTimeString('ja-JP',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
 // Keep the log console, keyboard focus and scroll position stable while timers tick.
 document.querySelectorAll('[data-live-elapsed]').forEach(el=>{if(el.dataset.liveElapsed)el.textContent=actionDuration(el.dataset.liveElapsed);});
 document.querySelectorAll('[data-live-queue]').forEach(el=>{if(el.dataset.liveQueue)el.textContent=actionDuration(el.dataset.liveQueue);});
}
function syncNavigation(){const hash=location.hash||'#overview';document.querySelectorAll('.sidebar .nav-link').forEach(link=>link.classList.toggle('active',link.hash===hash));}
window.addEventListener('hashchange',syncNavigation);syncNavigation();
refresh();setInterval(tick,1000);
