import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Writable } from "node:stream";
import { once } from "node:events";
import { createUpstreamSession, createHandler } from "../api/proxy.js";
import { signTarget, verifyTarget } from "../lib/proxy-sign.js";

process.env.TMDB_API_KEY = "test-only-signing-key";

test("HTML-labelled transport stream is forwarded intact with video MIME", async () => {
  const bytes = Buffer.alloc(752, 0xff);
  for (let i = 0; i < bytes.length; i += 188) bytes[i] = 0x47;
  let calls = 0;
  const handler = createHandler({ sessionFactory: () => ({ close() {}, fetch: async () => ++calls === 1
    ? new Response('"token"')
    : new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 100));
      controller.enqueue(bytes.subarray(100));
      controller.close();
    } }), { headers: { "Content-Type": "text/html" } }) }), log() {} });
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.headers = {};
  res.setHeader = (key, value) => res.headers[key] = value;
  res.status = code => { res.statusCode = code; return res; };
  const finished = once(res, "finish");
  const url = "https://cdn.example/page-0.html";
  await handler({ ...req, query: { url, sig: signTarget(url) } }, res);
  await finished;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "video/mp2t");
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test("actual HTML segment is rejected as a video error", async () => {
  let calls = 0;
  const handler = createHandler({ sessionFactory: () => ({ close() {}, fetch: async () => new Response(++calls === 1 ? '"token"' : '<html>error</html>', { headers: { "Content-Type": "text/html" } }) }), log() {} });
  const url = "https://cdn.example/page-0.html";
  const res = response();
  await handler({ ...req, query: { url, sig: signTarget(url) } }, res);
  assert.equal(res.statusCode, 502);
});

test("video starts before the HTML-labelled upstream stream finishes", async () => {
  const bytes = Buffer.alloc(752, 0xff);
  for (let i = 0; i < bytes.length; i += 188) bytes[i] = 0x47;
  let calls = 0, controller;
  const body = new ReadableStream({ start(value) { controller = value; value.enqueue(bytes); } });
  const handler = createHandler({ sessionFactory: () => ({ close() {}, fetch: async () => ++calls === 1 ? new Response('"token"') : new Response(body, { headers: { "Content-Type": "text/html" } }) }), log() {} });
  let received;
  const firstWrite = new Promise(resolve => received = resolve);
  const res = new Writable({ write(chunk, _encoding, done) { received(chunk); done(); } });
  res.setHeader = () => {};
  res.status = () => res;
  const url = "https://cdn.example/page-0.html";
  const pending = handler({ ...req, query: { url, sig: signTarget(url) } }, res);
  let timer;
  try {
    const chunk = await Promise.race([firstWrite, new Promise((_, reject) => timer = setTimeout(() => reject(new Error("playback waits for upstream completion")), 500))]);
    assert.equal(chunk[0], 0x47);
  } finally {
    clearTimeout(timer);
    controller.close();
    await pending;
  }
});

test("closing playback cancels the upstream and releases its session", async () => {
  const bytes=Buffer.alloc(752,0xff);
  for(let i=0;i<bytes.length;i+=188)bytes[i]=0x47;
  let calls=0, released=0, cancelled;
  const cancellation=new Promise(resolve=>cancelled=resolve);
  const body=new ReadableStream({start(controller){controller.enqueue(bytes);},cancel(){cancelled();}});
  const handler=createHandler({sessionFactory:()=>({close(){released++;},fetch:async()=>++calls===1?new Response('"token"'):new Response(body,{headers:{"Content-Type":"text/html"}})}),log(){}});
  const res=new Writable({write(_chunk,_encoding,done){done();this.destroy();}});
  res.setHeader=()=>{};res.status=()=>res;
  const url="https://cdn.example/page-0.html";
  await handler({...req,query:{url,sig:signTarget(url)}},res);
  let timer;
  try {await Promise.race([cancellation,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error("upstream leaked after disconnect")),500))]);}
  finally {clearTimeout(timer);}
  assert.ok(released>=1);
});

test("token and media requests reuse a socket; concurrent sessions remain isolated", async () => {
  const seen = new Map();
  const server = http.createServer((req, res) => {
    seen.set(req.url, req.socket);
    res.end(req.url.endsWith("token") ? "fresh-token" : "#EXTM3U");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = createUpstreamSession(), b = createUpstreamSession();
  try {
    await Promise.all([a.fetch(base + "/a-token").then(r => r.text()), b.fetch(base + "/b-token").then(r => r.text())]);
    await Promise.all([a.fetch(base + "/a-media").then(r => r.text()), b.fetch(base + "/b-media").then(r => r.text())]);
    assert.equal(seen.get("/a-token"), seen.get("/a-media"));
    assert.equal(seen.get("/b-token"), seen.get("/b-media"));
    assert.notEqual(seen.get("/a-token"), seen.get("/b-token"));
  } finally {
    a.close(); b.close();
    await new Promise(resolve => server.close(resolve));
  }
});

function response() {
  return { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(s) { this.statusCode=s; return this; }, send(text) { this.text=text; return this; }, end() {} };
}
const target = "https://cdn.example/master.m3u8";
const req = { method: "GET", query: { url: target, sig: signTarget(target) }, headers: { host: "addon.example" } };

test("HLS token is issued and consumed through the same private session", async () => {
  const calls=[], logs=[]; let closed = false;
  const handler=createHandler({
    sessionFactory: () => ({close(){closed=true;}, async fetch(url,options) {
      calls.push({url,options});
      if(calls.length===1) return new Response(JSON.stringify({token:"test-secret-token"}),{headers:{"Content-Type":"application/json"}});
      return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n720/index.m3u8\n',{headers:{"Content-Type":"application/vnd.apple.mpegurl"}});
    }}),
    log: message => logs.push(message),
  });
  const res=response(); await handler(req,res);
  assert.equal(res.statusCode,200);
  assert.equal(calls[0].url,"https://cdn.example/generate.php");
  assert.equal(calls[0].options.headers["Cache-Control"],"no-cache, no-store");
  assert.equal(new URL(calls[1].url).searchParams.get("token"),"test-secret-token");
  const child=new URL(res.text.split('\n')[2]);
  assert.equal(child.origin,"https://addon.example");
  assert.equal(child.searchParams.get("url"),"https://cdn.example/720/index.m3u8");
  assert.ok(verifyTarget(child.searchParams.get("url"),child.searchParams.get("sig")));
  assert.ok(!res.text.includes("test-secret-token"));
  assert.ok(!logs.join('').includes("test-secret-token"));
  assert.equal(closed,true);
});

test("invalid HLS content is rejected instead of returning HTML as a playlist", async () => {
  let n=0;
  const handler=createHandler({sessionFactory:()=>({close(){},fetch:async()=>new Response(++n===1?'"token"':'<html>Unavailable</html>')}),log:()=>{}});
  const res=response();await handler(req,res);
  assert.equal(res.statusCode,502);
});

test("upstream 401 logs a bounded reason without leaking response content", async () => {
  let n=0;const logs=[];
  const handler=createHandler({sessionFactory:()=>({close(){},fetch:async()=>new Response(++n===1?'"token"':'Invalid token: do-not-log-this',{status:n===1?200:401})}),log:s=>logs.push(s)});
  const res=response();await handler(req,res);
  assert.equal(res.statusCode,401);
  assert.ok(logs.some(s=>s.includes('reason=invalid')));
  assert.ok(!logs.join('').includes('do-not-log-this'));
});

test("unsigned requests cannot allocate a network session", async () => {
  const handler=createHandler({sessionFactory:()=>assert.fail('must not contact upstream')});
  const res=response(); await handler({...req,query:{url:target,sig:'bad'}},res);
  assert.equal(res.statusCode,403);
});

test("concurrent playlists share one token issuance on their origin session", async () => {
  let issued=0, media=0;
  const fetchSession=async url => {
    if(new URL(url).pathname==='/generate.php') {
      issued++;
      await new Promise(resolve=>setTimeout(resolve,10));
      return new Response('"shared-fresh-token"');
    }
    assert.equal(new URL(url).searchParams.get('token'),'shared-fresh-token');
    media++;
    return new Response('#EXTM3U\nsegment.ts\n');
  };
  const handler=createHandler({sessionFactory:()=>({fetch:fetchSession,close(){}}),log:()=>{}});
  const responses=[response(),response(),response()];
  await Promise.all(responses.map(res=>handler(req,res)));
  assert.equal(issued,1);
  assert.equal(media,3);
  assert.ok(responses.every(res=>res.statusCode===200));
});

test("issuer 429 is respected and does not become an unauthorized media request", async () => {
  let calls=0;
  const fetchSession=async()=>{calls++;return new Response('Too many requests',{status:429,headers:{'Retry-After':'120'}});};
  const handler=createHandler({sessionFactory:()=>({fetch:fetchSession,close(){}}),log:()=>{}});
  const first=response(),second=response();
  await handler(req,first);await handler(req,second);
  assert.equal(first.statusCode,503);
  assert.equal(second.statusCode,503);
  assert.equal(first.headers['Retry-After'],'120');
  assert.equal(calls,1);
});
