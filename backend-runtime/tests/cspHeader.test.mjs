import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { createApp } = req('../dist/app.js');

async function startServer(app){
  return new Promise(resolve=>{
    const server = app.listen(0, ()=> resolve(server));
  });
}

async function fetch(path, port){
  return new Promise((resolve,reject)=>{
    const r = http.request({ hostname:'127.0.0.1', port, path, method:'GET', headers:{ Accept:'text/html' }}, res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({res, body:Buffer.concat(chunks).toString('utf8')})); });
    r.on('error',reject); r.end();
  });
}

export async function test(){
  const app = createApp();
  const server = await startServer(app);
  const port = server.address().port;
  try {
    const { res } = await fetch('/health', port);
    const csp = res.headers['content-security-policy'];
    assert(csp, 'CSP header missing');
    assert(csp.includes("frame-ancestors 'none'"), 'frame-ancestors none missing');
    assert(/style-src [^;]*'unsafe-inline'/.test(csp), 'expected unsafe-inline in style-src when no hashes');
    assert(/script-src [^;]*'self'/.test(csp), 'script-src missing self');
  } finally { server.close(); }
}

export default async function(){ await test(); }
