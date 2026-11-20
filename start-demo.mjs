import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const server=spawn(process.execPath,['server.mjs'],{cwd:root,stdio:'inherit'});
const worker=spawn(process.execPath,['worker.mjs','--mode=demo'],{cwd:root,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{server.kill(signal);worker.kill(signal);process.exit(0);});
server.on('exit',()=>worker.kill());
worker.on('exit',()=>server.kill());
