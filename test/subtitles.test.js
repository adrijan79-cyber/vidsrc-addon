import test from "node:test";
import assert from "node:assert/strict";
import { buildSubtitleList } from "../lib/subtitles.js";
import { createSubtitleHandler } from "../api/subtitle.js";
import { signTarget, verifyTarget } from "../lib/proxy-sign.js";

process.env.TMDB_API_KEY = "test-only-signing-key";
const url = "https://vidapi.cloud/subs/example/Croatian.hrv.srt";
const req = { method: "GET", query: { url, sig: signTarget(url) }, headers: { host: "addon.example" } };
function response() { return { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.statusCode=code; return this; }, send(text) { this.text=text; return this; } }; }

test("Croatian and duplicate English variants have valid distinct subtitle objects", () => {
  const list = buildSubtitleList([{url,lang:"Croatian",code:"hr"},{url:"https://vidapi.cloud/subs/example/English.eng.srt",lang:"English",code:"en"},{url:"https://vidapi.cloud/subs/example/English-SDH.eng.srt",lang:"English-SDH",code:"en"},{url,lang:"duplicate"},{url:"https://other.example/subs/file.srt"}],req);
  assert.equal(list.length,3);
  assert.equal(list[0].lang,"hrv");
  assert.equal(list[0].label,"Croatian");
  assert.notEqual(list[1].id,list[2].id);
  const signed=new URL(list[0].url);
  assert.equal(signed.pathname,"/subtitle/caption.srt");
  assert.ok(verifyTarget(signed.searchParams.get("url"),signed.searchParams.get("sig")));
});

test("subtitle proxy forwards valid UTF-8 text without requesting a media token", async () => {
  let calls=0;
  const srt="1\n00:00:01,000 --> 00:00:02,000\nČ ć ž š đ\n";
  const handler=createSubtitleHandler(async target=>{calls++;assert.equal(target,url);return new Response(srt);});
  const res=response();await handler(req,res);
  assert.equal(calls,1);assert.equal(res.statusCode,200);assert.equal(res.text,srt);
  assert.equal(res.headers["Content-Type"],"application/x-subrip; charset=utf-8");
});

test("subtitle proxy rejects HTML and oversized bodies", async () => {
  for (const text of ["<html>error</html>","x".repeat(2*1024*1024+1)]) {
    const handler=createSubtitleHandler(async()=>new Response(text));
    const res=response();await handler(req,res);assert.equal(res.statusCode,502);
  }
});

test("unsigned and foreign-host subtitle requests cannot contact an upstream", async () => {
  const handler=createSubtitleHandler(()=>assert.fail("network must not be called"));
  for (const query of [{url,sig:"bad"},{url:"https://other.example/subs/test.srt",sig:signTarget("https://other.example/subs/test.srt")}]) {
    const res=response();await handler({...req,query},res);assert.equal(res.statusCode,403);
  }
});
