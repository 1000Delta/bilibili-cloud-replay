// Synthetic fixtures only. No user account records or live network calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../bilibili-cloud-replay.user.js');
const clone=x=>structuredClone(x);
const REPLAY={live_key:'900000000000001002',start_time:1792760794,end_time:1792777734,live_info:{title:'测试主题',cover:'https://i0.hdslb.com/bfs/live/test.jpg'},video_info:{replay_status:2},alarm_info:{is_ban_publish:false}};
const STREAM={list:[{start_time:1792760796,end_time:1792777734,stream:'not-exported'}],ban_list:null};
function fixture(options={}) {
  const calls=[],store={}, e={now:()=>1792860000,sleep:async()=>{},csrf:()=> 'a'.repeat(32),read:async uid=>clone(store[uid]||{version:1,tasks:{}}),write:async(uid,l)=>{store[uid]=clone(l);},lock:async(uid,f)=>f()};
  let engine;
  const replays=options.replays||[REPLAY],published=options.published||[];
  e.request=async(url,p,method,transport)=>{
    const route=Object.keys(C.ROUTES).find(k=>C.ROUTES[k]===url);calls.push({route,p:clone(p),method,transport});
    const overridden=await options.onRequest?.(route,p,method,e,engine);
    if(overridden!==undefined)return overridden;
    let data;
    if(route==='nav')data={mid:123,isLogin:true};
    if(route==='replays')data={replay_info:replays.slice((p.page-1)*p.page_size,p.page*p.page_size),pagination:{total:replays.length}};
    if(route==='published')data={list:published.slice((p.page-1)*p.page_size,p.page*p.page_size),total:published.length};
    if(route==='streams')data=options.streamMap?options.streamMap[p.live_key]:STREAM;
    if(route==='publish')data={video_slice_id:444};
    if(route==='frames')data={list:[{ts:Number(p.time_list),url:'https://i0.hdslb.com/bfs/live/frame-'+p.time_list+'.jpg'}]};
    return {http:200,json:{code:0,data}};
  };
  engine=new C.Engine(e);return {e,engine,calls,store,published};
}
const posts=f=>f.calls.filter(c=>c.method==='POST');
function withCache(f){const cache={};f.e.cacheRead=async uid=>clone(cache[uid]||{});f.e.cacheWrite=async(uid,value)=>{cache[uid]=clone(value);};return cache;}

test('editable titles trim edges, reject empty/control/overlong text and support Unicode',()=>{
  const clips=[{key:'a',title:'默认 01'}];assert.equal(C.validateTitleDrafts(clips).titles.a,'默认 01');
  assert.equal(C.validateTitleDrafts(clips,{a:'  本段主题  '}).titles.a,'本段主题');
  for(const text of ['   ','长'.repeat(81),'不允许\n换行','\u0000无效'])assert(C.validateTitleDrafts(clips,{a:text}).errors.a);
  assert(!C.validateTitleDrafts(clips,{a:'😀'.repeat(40)}).errors.a);assert(C.validateTitleDrafts(clips,{a:'😀'.repeat(41)}).errors.a);
});
test('batch and known publication title conflicts are shown against the edited titles',()=>{
  const clips=[{key:'a',title:'自动 01'},{key:'b',title:'自动 02'}];
  const duplicate=C.validateTitleDrafts(clips,{a:'同名',b:' 同名 '});assert(duplicate.errors.a);assert(duplicate.errors.b);
  const known=C.validateTitleDrafts(clips,{a:'已经投稿',b:'新主题'},[{title:'已经投稿',state:'已投稿'}]);assert(known.errors.a);assert(!known.errors.b);
});
test('confirmed custom title is sent and recorded without rewriting the scanned automatic title',async()=>{
  const f=fixture(),p=await f.engine.scan(),c=p.clips[0],automatic=c.title,edited=automatic+' · 初见Boss';
  await f.engine.publish([c.key],p.token,undefined,{[c.key]:edited});
  assert.equal(f.calls.find(c=>c.route==='publish').p.av_title,edited);assert.equal(c.title,automatic);
  assert.equal(f.store['123'].tasks[c.key].approvedTitle,edited);assert.equal(f.store['123'].tasks[c.key].automaticTitle,automatic);
});
test('invalid, repeated, missing and unrelated title approvals cannot reach any POST',async()=>{
  for(const kind of ['empty','long','duplicate','missing','outside']){
    const f=fixture(),p=await f.engine.scan(),keys=p.clips.slice(0,2).map(c=>c.key),edits=Object.fromEntries(p.clips.slice(0,2).map(c=>[c.key,c.title]));
    if(kind==='empty')edits[keys[0]]=' ';if(kind==='long')edits[keys[0]]='长'.repeat(81);if(kind==='duplicate')edits[keys[1]]=edits[keys[0]];if(kind==='missing')delete edits[keys[1]];if(kind==='outside')edits.other='其他标题';
    await assert.rejects(f.engine.publish(keys,p.token,undefined,edits));assert.equal(posts(f).length,0,kind);
  }
});
test('an explicitly refreshed collision is checked against the confirmed custom title',async()=>{
  const f=fixture(),p=await f.engine.scan(),c=p.clips[0],edited='另一个已用标题';
  f.published.push({slice_id:999,av_status:2,av_title:edited,start_tm:C.stamp(c.end+100),end_tm:C.stamp(c.end+200)});
  await f.engine.reconcile();await f.engine.publish([c.key],p.token,undefined,{[c.key]:edited});assert.equal(posts(f).length,0);assert.equal(f.store['123'].tasks[c.key].state,'duplicate');
});
test('title approval is frozen before async preflight even if the input object later changes',async()=>{
  let changed=false,edits;const f=fixture({onRequest:async route=>{if(changed&&route==='streams')edits[Object.keys(edits)[0]]='确认之后被改动';}}),p=await f.engine.scan(),c=p.clips[0];
  edits={[c.key]:'确认时的主题'};changed=true;const originalLock=f.e.lock;f.e.lock=async(uid,fn)=>{edits[c.key]='确认之后被改动';return originalLock(uid,fn);};await f.engine.publish([c.key],p.token,undefined,edits);assert.equal(f.calls.find(c=>c.route==='publish').p.av_title,'确认时的主题');
});
test('rescan preserves confirmed custom titles and keeps daily numbering based on the automatic title',async()=>{
  const f=fixture(),p=await f.engine.scan(),c=p.clips[0],automatic=c.title,edited=automatic+' · 补充主题 99';
  await f.engine.publish([c.key],p.token,undefined,{[c.key]:edited});
  f.published.push({slice_id:444,av_status:2,av_title:edited,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
  const next=await f.engine.scan(),restored=next.clips.find(x=>x.key===c.key);
  assert.equal(restored.title,edited);assert.equal(restored.automaticTitle,automatic);assert.deepEqual(next.clips.map(c=>c.sequence),[1,2,3]);
  assert.equal(Object.keys(f.store['123'].numbering.groups).length,1);assert.equal(f.store['123'].tasks[c.key].clip.title,edited);
});

test('published cards use publication ctime and encoded duration, never broadcast start or source span',()=>{
  const p=C.publicationInfo({slice_id:1,av_title:'人工改过的标题',ctime:'2026-10-25 19:25:23',start_tm:'2026-10-24 20:42:12',end_tm:'2026-10-24 22:26:38',av_duration:6270});
  assert.equal(C.matchPublishedCard([p],{title:p.title,created:'2026-10-25 19:25:23',duration:'104:30'}),p);
  assert.equal(C.matchPublishedCard([p],{title:p.title,created:'2026-10-24 20:42',duration:'104:30'}),null);
  assert.equal(C.parseCardDuration('120:02'),7202);assert.equal(C.parseCardDuration('2:00:02'),7202);assert.equal(C.parseCardDuration('10:99'),null);
});
test('duplicate publication titles are resolved by ctime/encoded duration and ambiguous identities stay unmatched',()=>{
  const a=C.publicationInfo({slice_id:1,av_title:'同名',ctime:'2026-10-25 10:00:01',av_duration:100}),b=C.publicationInfo({slice_id:2,av_title:'同名',ctime:'2026-10-25 11:00:01',av_duration:200});
  assert.equal(C.matchPublishedCard([a,b],{title:'同名',created:'2026-10-25 11:00:01',duration:'3:20'}),b);
  assert.equal(C.matchPublishedCard([a,{...a,sliceId:'3'}],{title:'同名',created:'2026-10-25 10:00:01',duration:'1:40'}),null);
  assert.equal(C.matchPublishedCard([a,b],{sliceId:'2'}),b);assert.equal(C.matchPublishedCard([a,b],{sliceId:'missing',title:'同名',created:'2026-10-25 11:00:01'}),null);
});
test('reverse matching uses the entire cut interval across midnight and the original broadcast date',()=>{
  const sessions=[{liveKey:'one',topic:'原直播主题',start:C.time('2026-10-23 21:00:00'),end:C.time('2026-10-24 02:00:00')},{liveKey:'two',topic:'同日另一场',start:C.time('2026-10-23 18:00:00'),end:C.time('2026-10-23 20:00:00')}];
  const p=C.publicationInfo({av_title:'完全不同的投稿标题',ctime:'2026-10-25 19:00:00',start_tm:'2026-10-24 00:01:00',end_tm:'2026-10-24 01:00:00'}),origin=C.reversePublication(p,sessions);
  assert.equal(origin.kind,'matched');assert.equal(origin.session.liveKey,'one');assert.equal(C.date(origin.session.start),'2026-10-23');
});
test('expired/invalid/cross-session/overlapping sources are distinguished without guessing from titles',()=>{
  const a={liveKey:'a',topic:'相同标题',start:100,end:200},b={liveKey:'b',topic:'相同标题',start:200,end:300};
  assert.equal(C.reversePublication({title:'相同标题',start:1,end:50},[a,b]).kind,'missing');
  assert.equal(C.reversePublication({title:'相同标题',start:null,end:null},[a,b]).kind,'invalid');
  assert.equal(C.reversePublication({start:190,end:210},[a,b]).kind,'partial');
  assert.equal(C.reversePublication({start:120,end:150},[a,{...b,start:110,end:190}]).kind,'ambiguous');
  assert.equal(C.reversePublication({liveKey:'b',start:120,end:150},[a,b]).session.liveKey,'b');
  assert.equal(C.reversePublication({liveKey:'expired',start:120,end:150},[a,b]).kind,'missing');
});
test('full publication index including expired-source records is cached and refreshed without any POST',async()=>{
  const row={slice_id:1,av_title:'历史投稿',ctime:'2026-10-25 19:00:00',start_tm:'2025-01-01 10:00:00',end_tm:'2025-01-01 11:00:00',av_status:1},f=fixture({published:[row]}),cache=withCache(f);
  const p=await f.engine.scan();assert.equal(p.published.length,1);assert.equal(p.published[0].origin.kind,'missing');assert.equal(cache['123'].plan.published.length,1);assert.doesNotThrow(()=>JSON.stringify(p));
  row.av_status=2;await f.engine.reconcile();assert.equal(p.published[0].state,'已投稿');assert.equal(posts(f).length,0);
});
test('published details include every overlapping/title-conflicting record and only build trusted video links',()=>{
  const c=C.makeClips(REPLAY,STREAM).clips[0],rows=[
    {slice_id:1,av_title:'人工投稿',start_tm:C.stamp(c.start),end_tm:C.stamp(c.start+10),av_status:2,avid:'900000000000001000',url:'javascript:alert(1)'},
    {slice_id:2,av_title:c.title,start_tm:C.stamp(c.end+100),end_tm:C.stamp(c.end+200),av_status:1,bvid:'BV1AA411A7AA'},
    {slice_id:3,av_title:'无关',start_tm:C.stamp(c.end+300),end_tm:C.stamp(c.end+400),av_status:2}];
  const info=C.relatedPublications(c,rows);assert.equal(info.length,2);assert.equal(info[0].href,'https://www.bilibili.com/video/av900000000000001000');
  assert.equal(info[1].href,'https://www.bilibili.com/video/BV1AA411A7AA/');assert.equal(info[1].match,'同名标题');
  assert.equal(C.remoteConflict(c,rows).publications.length,2);assert.equal(C.publicationInfo({avid:'javascript:evil'}).direct,false);
});
test('status tones distinguish posted green, unposted red, and partial amber',()=>{
  assert.equal(C.statusTone('已投稿'),'tone-green');assert.equal(C.statusTone('未投稿'),'tone-red');assert.equal(C.statusTone('部分已投稿'),'tone-amber');
});
test('random timestamps stay inside each approved clip, avoid edges and avoid the previous pick',()=>{
  for(const seconds of [1,2,19,7190]){
    const c={start:1000,end:1000+seconds};for(const u of [0,.5,.999999]){const ts=C.randomFrameTimestamp(c,undefined,()=>u);assert(ts>=c.start&&ts<c.end);if(seconds>1)assert.notEqual(C.randomFrameTimestamp(c,ts,()=>u),ts);}
  }
  assert.equal(C.randomFrameTimestamp({start:0,end:7190},undefined,()=>0),15);assert.throws(()=>C.randomFrameTimestamp({start:0,end:1},null,()=>1),/随机数/);
});
test('reading a random cover uses the official JSON key-frame POST and never publishes or modifies a plan',async()=>{
  const f=fixture();f.e.random=()=>.5;await f.engine.scan();const c=f.engine.snapshot.clips[0],original=c.cover,before=clone(f.store);
  const cover=await f.engine.randomCover(c.key);assert(cover.ts>=c.start&&cover.ts<c.end);assert.equal(cover.source,'random');assert.equal(c.cover,original);
  const request=f.calls.find(c=>c.route==='frames');assert.equal(request.method,'POST');assert.deepEqual(request.transport,{json:true});assert.equal(request.p.live_key,c.liveKey);
  assert.equal(f.calls.filter(c=>c.route==='publish').length,0);assert.deepEqual(f.store,before);assert(!JSON.stringify(f.engine.events).includes('a'.repeat(32)));
});
test('confirmed random cover is sent exactly once; its default and timestamp remain traceable',async()=>{
  const f=fixture();const p=await f.engine.scan(),c=p.clips[0],cover=await f.engine.randomCover(c.key);await f.engine.publish([c.key],p.token,{[c.key]:cover});
  assert.equal(f.calls.find(c=>c.route==='publish').p.av_cover,cover.url);assert.notEqual(c.cover,cover.url);assert.equal(f.store['123'].tasks[c.key].approvedCover.ts,cover.ts);
  assert.equal(f.calls.filter(c=>c.route==='publish').length,1);
});
test('unread, expired-plan, outside-clip and foreign-host random covers cannot be submitted',async()=>{
  for(const kind of ['unread','rescan','range','origin']){
    const f=fixture();let p=await f.engine.scan();const c=p.clips[0];let cover=kind==='unread'?{source:'random',ts:c.start,url:'https://i0.hdslb.com/bfs/live/not-issued.jpg'}:await f.engine.randomCover(c.key);
    if(kind==='rescan')p=await f.engine.scan();if(kind==='range')cover={...cover,ts:c.end};if(kind==='origin')cover={...cover,url:'https://evil.example/x.jpg'};
    await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:cover}));assert.equal(f.calls.filter(c=>c.route==='publish').length,0,kind);
  }
});
test('default cover must match that clip and confirmation cannot include another clip',async()=>{
  const f=fixture(),p=await f.engine.scan(),c=p.clips[0],choice={source:'default',url:c.cover,ts:null};
  await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:{...choice,url:'https://i0.hdslb.com/wrong.jpg'}}),/默认封面/);
  await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:choice,other:choice}),/封面确认/);
  assert.equal(f.calls.filter(c=>c.route==='publish').length,0);
});
test('key-frame failure, missing CSRF and changed account never cause a publication or blind retry',async()=>{
  for(const kind of ['api','csrf','account','bad-frame']){
    let changed=false;const f=fixture({onRequest:async route=>changed&&route==='frames'&&kind==='api'?{http:200,json:{code:-500,message:'frame not ready'}}:changed&&route==='frames'&&kind==='bad-frame'?{http:200,json:{code:0,data:{list:[{ts:0,url:'https://i0.hdslb.com/x.jpg'}]}}}:changed&&route==='nav'&&kind==='account'?{http:200,json:{code:0,data:{mid:999,isLogin:true}}}:undefined});
    const p=await f.engine.scan();changed=true;if(kind==='csrf')f.e.csrf=()=>'';if(kind==='account')await f.engine.prepareScan();
    await assert.rejects(f.engine.randomCover(p.clips[0].key));assert.equal(f.calls.filter(c=>c.route==='publish').length,0);assert(f.calls.filter(c=>c.route==='frames').length<=1);
  }
});
test('cover confirmation freezes selected image even if its input object changes during preflight',async()=>{
  let choice,mutate=false;const f=fixture({onRequest:async route=>{if(mutate&&route==='streams')choice.url='https://i0.hdslb.com/changed-after-confirm.jpg';}});
  const p=await f.engine.scan(),c=p.clips[0];choice={source:'default',url:c.cover,ts:null};mutate=true;const originalLock=f.e.lock;f.e.lock=async(uid,fn)=>{choice.url='https://i0.hdslb.com/changed-after-confirm.jpg';return originalLock(uid,fn);};
  await f.engine.publish([c.key],p.token,{[c.key]:choice});assert.equal(f.calls.find(c=>c.route==='publish').p.av_cover,c.cover);
});

test('warm scans reuse sanitized ranges and initial publication records',async()=>{
  const f=fixture(),cache=withCache(f);await f.engine.scan();await f.engine.scan();
  assert.equal(f.calls.filter(c=>c.route==='streams').length,1);
  assert.equal(f.calls.filter(c=>c.route==='published').length,1);
  assert.equal(f.calls.filter(c=>c.route==='replays').length,2);
  assert(!JSON.stringify(cache).includes('not-exported'));assert.equal(cache['123'].policy,C.CACHE_POLICY);
  assert(cache['123'].plan.sessions[0].coverage);assert.equal(posts(f).length,0);
});
test('expired, changed, force-refreshed, mismatched-account and incompatible caches are bypassed',async()=>{
  for(const kind of ['expired','changed','force','account','policy']){
    const r=clone(REPLAY),f=fixture({replays:[r]}),cache=withCache(f);await f.engine.scan();
    if(kind==='expired'){const now=f.e.now();f.e.now=()=>now+21600;}
    if(kind==='changed')r.video_info.replay_status=10;
    if(kind==='account')cache['123'].uid='999';
    if(kind==='policy')cache['123'].policy='older-grid';
    await f.engine.scan({}, {force:kind==='force'});
    assert.equal(f.calls.filter(c=>c.route==='streams').length,2,kind);
  }
});
test('newly ended replay metadata expires after sixty seconds',async()=>{
  const f=fixture();withCache(f);let now=REPLAY.end_time+600;f.e.now=()=>now;
  await f.engine.scan();now+=59;await f.engine.scan();assert.equal(f.calls.filter(c=>c.route==='streams').length,1);
  now+=1;await f.engine.scan();assert.equal(f.calls.filter(c=>c.route==='streams').length,2);
});
test('switching authenticated accounts cannot read another account scan cache',async()=>{
  let account='123';const f=fixture({onRequest:async route=>route==='nav'?{http:200,json:{code:0,data:{mid:account,isLogin:true}}}:undefined}),cache=withCache(f);
  await f.engine.scan();account='456';const p=await f.engine.scan();
  assert.equal(p.uid,'456');assert.equal(cache['123'].uid,'123');assert.equal(cache['456'].uid,'456');
  assert.equal(f.calls.filter(c=>c.route==='streams').length,2);assert.equal(posts(f).length,0);
});
test('new replays require only their own stream lookup; cached plans preserve topic and numbering',async()=>{
  const replays=[clone(REPLAY)],f=fixture({replays});withCache(f);await f.engine.scan();
  const r={...clone(REPLAY),live_key:'900000000000001004'};replays.push(r);
  const plan=await f.engine.scan({[r.live_key]:'另一主题'});
  assert.equal(f.calls.filter(c=>c.route==='streams').length,2);assert.equal(plan.sessions.length,2);
  assert(plan.clips.filter(c=>c.liveKey===r.live_key).every(c=>c.title.startsWith('另一主题 ')));
});
test('publishing reuses initial publication records and scanned ranges',async()=>{
  const f=fixture();withCache(f);await f.engine.scan();const p=await f.engine.scan(),before=f.calls.length;
  await f.engine.publish([p.clips[0].key],p.token);
  assert.equal(f.calls.slice(before).filter(c=>c.route==='streams').length,0);
  assert.equal(f.calls.slice(before).filter(c=>c.route==='published').length,0);assert.equal(posts(f).length,1);
});
test('partial, processing and complete publication coverage use the union of actual intervals',()=>{
  const s=REPLAY.start_time,range=[[s,s+100],[s+200,s+300]],row=(a,b,status)=>({start_tm:C.stamp(a),end_tm:C.stamp(b),av_status:status});
  assert.equal(C.sessionCoverage(range,[]).status,'未投稿');
  assert.deepEqual(C.sessionCoverage(range,[row(s,s+60,2),row(s+30,s+80,2)]),{total:200,posted:80,covered:80,status:'部分已投稿'});
  assert.equal(C.sessionCoverage(range,[row(s,s+300,1)]).status,'处理中');
  assert.equal(C.sessionCoverage(range,[row(s,s+300,2)]).status,'已投稿');
  assert.equal(C.sessionCoverage(range,[row(s,s+300,3)]).status,'未投稿');
});
test('official visible card identity is title plus original display minute; ambiguity has no action',()=>{
  const s={originalTopic:'测试主题',start:REPLAY.start_time,displayStart:REPLAY.start_time+120,liveKey:REPLAY.live_key};
  const minute=C.stamp(s.displayStart).slice(0,16);
  assert.equal(C.matchSession([s],'测试主题',minute),s);
  assert.equal(C.matchSession([s,{...s,liveKey:'999'}],'测试主题',minute),null);
  assert.equal(C.matchSession([s],'其他主题',minute),null);
  assert.equal(C.matchSession([s],'测试主题',C.stamp(s.start).slice(0,16)),null);
});
test('status reconciliation updates cached card coverage and excludes new manual uploads',async()=>{
  const f=fixture();const p=await f.engine.scan();const clip=p.clips[0];
  f.published.push({slice_id:9,av_title:'手动上传',start_tm:C.stamp(clip.start),end_tm:C.stamp(clip.end),av_status:2});
  await f.engine.reconcile();assert.equal(p.sessions[0].coverage.status,'部分已投稿');assert.equal(f.store['123'].tasks[clip.key].state,'duplicate');
});

test('cross-midnight: date is derived from original broadcast; contiguous <=7200-second coverage',()=>{
  const {clips}=C.makeClips(REPLAY,STREAM);
  assert.deepEqual(clips.map(c=>c.title),['测试主题 2026-10-23 01','测试主题 2026-10-23 02','测试主题 2026-10-23 03']);
  assert.equal(clips[2].end-clips[0].start,16938);
  assert.deepEqual(clips.map(c=>c.end-c.start),[7190,7190,2558]);
  assert.equal(clips[0].end,clips[1].start);assert.equal(clips[1].end,clips[2].start);
});
test('exact boundary and one-second tail; 64-bit JSON identifiers remain lossless',()=>{
  for(const seconds of [C.CHUNK,C.CHUNK+1,C.CHUNK*2]){
    const r={...REPLAY,end_time:REPLAY.start_time+seconds};
    const c=C.makeClips(r,{list:[{start_time:r.start_time,end_time:r.end_time}]}).clips;
    assert.equal(c.length,Math.ceil(seconds/C.CHUNK));assert.equal(c.reduce((n,c)=>n+c.end-c.start,0),seconds);
  }
  assert.equal(C.parseJSON('{"live_key":900000000000001003,"title":"900000000000001003"}').live_key,'900000000000001003');
  assert.equal(C.parseJSON('{"s":"a\\\"12", "n":2}').s,'a"12');
});
test('title truncation preserves date, two-digit suffix, and Unicode characters',()=>{
  const t=C.title('😀'.repeat(80),REPLAY.start_time,2);
  assert(t.length<=80);assert(t.endsWith(' 2026-10-23 02'));assert(!/\ud83d$/.test(t.split(' ')[0]));
});
test('stream gaps are not submitted as available video; banned ranges stop the whole session',()=>{
  const s=REPLAY.start_time;
  const c=C.makeClips(REPLAY,{list:[{start_time:s+2,end_time:s+100},{start_time:s+200,end_time:s+500}]}).clips;
  assert.equal(c.length,2);assert.equal(c[0].end,s+100);assert.equal(c[1].start,s+200);
  assert.throws(()=>C.makeClips(REPLAY,{...STREAM,ban_list:[{start_time:s+10,end_time:s+20}]}),/不可发布/);
  assert.throws(()=>C.makeClips(REPLAY,{list:[]}),/暂无/);
});
test('old manual uploads block overlapping intervals even when titles differ',()=>{
  const clip=C.makeClips(REPLAY,STREAM).clips[0];
  assert.equal(C.remoteConflict(clip,[{slice_id:1,av_title:'different title',av_status:2,start_tm:C.stamp(clip.start+300),end_tm:C.stamp(clip.end+20)}]).state,'duplicate');
});
test('same-day same-topic broadcasts share a continuous sequence in start-time order',async()=>{
  const r2={...REPLAY,live_key:'900000000000001001',start_time:REPLAY.start_time-3600,end_time:REPLAY.start_time-1800};
  const f=fixture({replays:[REPLAY,r2],streamMap:{[REPLAY.live_key]:STREAM,[r2.live_key]:{list:[{start_time:r2.start_time,end_time:r2.end_time}]}}});
  const p=await f.engine.scan();
  assert.deepEqual(p.clips.map(c=>c.sequence),[1,2,3,4]);
  assert.equal(p.clips[0].liveKey,r2.live_key);assert(p.clips.every(c=>!c.blocked));
  assert.equal(new Set(p.clips.map(c=>c.title)).size,p.clips.length);
  assert(p.clips.every(c=>c.title.includes('2026-10-23')));
});
test('discovery retries network GETs, never POSTs',async()=>{
  let n=0;const f=fixture({onRequest:async(route)=>{if(route==='nav'&&n++<2)throw Error('offline');}});
  await f.engine.scan();assert.equal(f.calls.filter(x=>x.route==='nav').length,3);assert.equal(posts(f).length,0);
});
test('incomplete pagination aborts discovery',async()=>{
  const f=fixture({onRequest:async route=>route==='published'?{http:200,json:{code:0,data:{list:[],total:3}}}:undefined});
  await assert.rejects(f.engine.scan(),/分页提前/);assert.equal(posts(f).length,0);
});
test('manual uploads after the initial check are discovered only by explicit refresh',async()=>{
  const f=fixture();const p=await f.engine.scan(),c=p.clips[0];
  f.published.push({slice_id:2,av_title:'manual',av_status:2,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
  await f.engine.reconcile();await f.engine.publish([c.key],p.token);assert.equal(posts(f).length,0);
});
test('timeout after POST is persisted as unknown, cannot be automatically resubmitted',async()=>{
  const f=fixture({onRequest:async route=>{if(route==='publish')throw Error('timeout');}});const p=await f.engine.scan(),c=p.clips[0];
  await assert.rejects(f.engine.publish([c.key],p.token),/timeout/);
  assert.equal(f.store['123'].tasks[c.key].state,'unknown');
  await f.engine.publish([c.key],p.token);assert.equal(posts(f).length,1);
  await assert.rejects(f.engine.allowRetry([c.key]),/明确失败/);
});
test('accepted is distinct from published; CSRF and POST data are not stored in logs or ledger',async()=>{
  const f=fixture(),p=await f.engine.scan(),c=p.clips[0];await f.engine.publish([c.key],p.token);
  assert.equal(posts(f).length,1);assert.equal(posts(f)[0].p.csrf,'a'.repeat(32));assert.equal(posts(f)[0].p.end_ts-posts(f)[0].p.start_ts,C.CHUNK);
  assert.equal(f.store['123'].tasks[c.key].state,'accepted');
  assert(!JSON.stringify(f.store).includes('a'.repeat(32)));assert(!JSON.stringify(f.engine.events).includes('a'.repeat(32)));
  f.published.push({slice_id:444,av_status:1,av_title:c.title,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
  await f.engine.reconcile();assert.equal(f.store['123'].tasks[c.key].state,'processing');
  f.published[0].av_status=2;f.published[0].avid=555;await f.engine.reconcile();assert.equal(f.store['123'].tasks[c.key].state,'posted');
});
test('missing CSRF and changed account prevent any POST',async()=>{
  const f=fixture(),p=await f.engine.scan();f.e.csrf=()=>'';
  await assert.rejects(f.engine.publish([p.clips[0].key],p.token),/CSRF/);assert.equal(posts(f).length,0);
  const original=f.e.request;f.e.request=async(url,...args)=>url===C.ROUTES.nav?{http:200,json:{code:0,data:{isLogin:true,mid:456}}}:original(url,...args);await f.engine.prepareScan();
  await assert.rejects(f.engine.publish([p.clips[0].key],p.token),/确认当前账号|账号已改变/);
});
test('durable-write failure prevents POST',async()=>{
  const f=fixture(),p=await f.engine.scan();f.e.write=async()=>{throw Error('disk full');};
  await assert.rejects(f.engine.publish([p.clips[0].key],p.token),/disk full/);assert.equal(posts(f).length,0);
});
test('stop during the pre-submit interval prevents the pending POST',async()=>{
 const f=fixture(),p=await f.engine.scan();f.e.sleep=async ms=>{if(ms===100)f.engine.stop();};await f.engine.publish([p.clips[0].key],p.token);assert.equal(posts(f).length,0);
});

test('crashed sending task becomes unknown after restart',async()=>{
  const f=fixture(),p=await f.engine.scan(),c=p.clips[0];f.store['123'].tasks[c.key]={state:'sending',clip:c};
  const next=await f.engine.scan();assert.equal(next.clips[0].state,'unknown');assert(next.clips[0].blocked);assert.equal(posts(f).length,0);
});
test('explicit rejection has no automatic retry; manual reset still requires a new approval',async()=>{
  let reject=true;const f=fixture({onRequest:async route=>route==='publish'&&reject?{http:200,json:{code:4001,message:'操作太快'}}:undefined});
  let p=await f.engine.scan(),c=p.clips[0];await assert.rejects(f.engine.publish([c.key],p.token),/4001/);
  assert.equal(posts(f).length,1);assert.equal(f.store['123'].tasks[c.key].state,'rejected');
  await f.engine.allowRetry([c.key]);assert.equal(posts(f).length,1);
  p=await f.engine.scan();assert(!p.clips[0].blocked);reject=false;await f.engine.publish([p.clips[0].key],p.token);assert.equal(posts(f).length,2);
});
test('malformed success response remains unknown',async()=>{
  const f=fixture({onRequest:async route=>route==='publish'?{http:200,json:{code:0,data:{}}}:undefined});const p=await f.engine.scan(),c=p.clips[0];
  await assert.rejects(f.engine.publish([c.key],p.token),/缺少切片ID/);assert.equal(f.store['123'].tasks[c.key].state,'unknown');assert.equal(posts(f).length,1);
});
test('wrong approval token prevents POST',async()=>{
  const f=fixture(),p=await f.engine.scan();await assert.rejects(f.engine.publish([p.clips[0].key],'stale'),/计划已改变/);assert.equal(posts(f).length,0);
});

test('encoder headroom covers the observed 3-4 second overhang without exceeding two hours',()=>{
  assert.equal(C.MAX,7200);assert.equal(C.CHUNK,7190);
  for(const observedOverhang of [3,4])assert(C.CHUNK+observedOverhang<C.MAX);
});
test('stopping after one accepted segment prevents the remaining batch and reports stopped progress',async()=>{
  const f=fixture(),progress=[];f.e.progress=e=>{progress.push(e);if(e.stage==='accepted')f.engine.stop();};
  const p=await f.engine.scan();await f.engine.publish(p.clips.map(c=>c.key),p.token);
  assert.equal(posts(f).length,1);assert.equal(progress.at(-1).stage,'stopped');
  assert(progress.some(e=>e.stage==='submit'&&e.total===3));
});
test('overlap-only dedup records never become our submitted tasks merely because their remote ID was remembered',()=>{
  const clip=C.makeClips(REPLAY,STREAM).clips[0];
  const row={slice_id:77,av_title:'old manual title',av_status:2,start_tm:C.stamp(clip.start+30),end_tm:C.stamp(clip.end+30)};
  const first=C.remoteConflict(clip,[row]);assert.equal(first.state,'duplicate');
  assert.equal(C.remoteConflict(clip,[row],first).state,'duplicate');
});

function shortScene(start,key,topic='同日主题'){
  return {...REPLAY,live_key:key,start_time:start,end_time:start+120,live_info:{...REPLAY.live_info,title:topic}};
}
const morning=Date.parse('2026-10-23T08:00:00+08:00')/1000;
const streamFor=r=>({list:[{start_time:r.start_time,end_time:r.end_time}]});
test('rescanning preserves daily numbers when an earlier replay disappears, and a later broadcast continues numbering',async()=>{
  const a=shortScene(morning,'100'),b=shortScene(morning+3600,'101'),c=shortScene(morning+7200,'102');
  const replays=[b,a],f=fixture({replays,streamMap:{100:streamFor(a),101:streamFor(b),102:streamFor(c)}});
  let p=await f.engine.scan();assert.deepEqual(p.clips.map(c=>c.sequence),[1,2]);
  replays.splice(replays.indexOf(a),1);p=await f.engine.scan();assert.equal(p.clips[0].sequence,2);
  replays.push(c);p=await f.engine.scan();assert.deepEqual(p.clips.map(c=>c.sequence),[2,3]);assert.equal(posts(f).length,0);
});
test('different topics and different broadcast start dates have independent daily sequences',async()=>{
  const a=shortScene(morning,'110','甲'),b=shortScene(morning+3600,'111','乙'),c=shortScene(morning+86400,'112','甲');
  const f=fixture({replays:[c,b,a],streamMap:{110:streamFor(a),111:streamFor(b),112:streamFor(c)}});
  const p=await f.engine.scan();assert.deepEqual(p.clips.map(c=>c.sequence),[1,1,1]);
  assert.deepEqual(p.clips.map(c=>c.title),['甲 2026-10-23 01','乙 2026-10-23 01','甲 2026-10-24 01']);
});
test('existing server numbers are adopted by overlap and new clips continue after the highest used daily number',async()=>{
  const a=shortScene(morning,'120'),b=shortScene(morning+3600,'121');
  const rows=[{slice_id:1,av_status:2,av_title:'同日主题 2026-10-23 03',start_tm:C.stamp(a.start_time),end_tm:C.stamp(a.end_time)},
    {slice_id:2,av_status:2,av_title:'同日主题 2026-10-23 05',start_tm:C.stamp(morning-3600),end_tm:C.stamp(morning-3500)}];
  const f=fixture({replays:[b,a],published:rows,streamMap:{120:streamFor(a),121:streamFor(b)}});
  const p=await f.engine.scan();assert.deepEqual(p.clips.map(c=>c.sequence),[3,6]);assert(p.clips[0].blocked);assert(!p.clips[1].blocked);
});
test('whitespace normalization shares the same rendered topic counter',async()=>{
  const a=shortScene(morning,'130','同日   主题'),b=shortScene(morning+3600,'131',' 同日 主题 ');
  const f=fixture({replays:[b,a],streamMap:{130:streamFor(a),131:streamFor(b)}});
  const p=await f.engine.scan();assert.deepEqual(p.clips.map(c=>c.title),['同日 主题 2026-10-23 01','同日 主题 2026-10-23 02']);
});
test('legacy rejected duplicate titles are not frozen and no longer block daily planning',async()=>{
  const a=shortScene(morning,'140'),b=shortScene(morning+3600,'141'),f=fixture({replays:[a,b],streamMap:{140:streamFor(a),141:streamFor(b)}});
  const old=C.makeClips(b,streamFor(b)).clips[0];f.store['123']={version:1,tasks:{[old.key]:{state:'rejected',attempts:1,clip:old,apiCode:4006}}};
  let p=await f.engine.scan();assert.deepEqual(p.clips.map(c=>c.sequence),[1,2]);
  await f.engine.allowRetry([old.key]);p=await f.engine.scan();assert.equal(p.clips[1].title,'同日主题 2026-10-23 02');assert(!p.clips[1].blocked);assert.equal(posts(f).length,0);
});
test('malformed numbering reservations abort a scan instead of silently reusing titles',async()=>{
  const a=shortScene(morning,'150'),f=fixture({replays:[a],streamMap:{150:streamFor(a)}});
  f.store['123']={version:1,tasks:{},numbering:{version:1,groups:{'同日主题 2026-10-23':{last:1,byClip:{x:1,y:1}}}}};
  await assert.rejects(f.engine.scan(),/编号账本/);assert.equal(posts(f).length,0);
});
test('legacy already-submitted numbers stay fixed when an older replay is discovered later',async()=>{
  const a=shortScene(morning,'160'),b=shortScene(morning+3600,'161');
  const f=fixture({replays:[a,b],streamMap:{160:streamFor(a),161:streamFor(b)}}),old=C.makeClips(b,streamFor(b)).clips[0];
  f.store['123']={version:1,tasks:{[old.key]:{state:'accepted',attempts:1,sliceId:'44',clip:old}}};
  const p=await f.engine.scan();assert.equal(p.clips.find(c=>c.liveKey==='161').title,'同日主题 2026-10-23 01');
  assert.equal(p.clips.find(c=>c.liveKey==='160').title,'同日主题 2026-10-23 02');assert.equal(posts(f).length,0);
});

test('4001 persists a 60-second cooldown across separate publishing calls without automatic resend',async()=>{
 let rejected=true;const f=fixture({onRequest:async route=>route==='publish'&&rejected?{http:200,json:{code:4001,message:'操作太快'}}:undefined});
 const p=await f.engine.scan(),[a,b]=p.clips,sleeps=[];f.e.sleep=async ms=>sleeps.push(ms);
 await assert.rejects(f.engine.publish([a.key],p.token),/4001/);assert.equal(f.store['123'].nextSubmitAt,f.e.now()+60);assert.equal(posts(f).length,1);
 rejected=false;const restart=new C.Engine(f.e);await restart.scan();await restart.publish([b.key],p.token);
 assert.equal(sleeps.filter(n=>n===1000).length,60);assert.equal(posts(f).length,2);assert.equal(f.store['123'].tasks[a.key].state,'rejected');
});
test('normal spacing is shared by independent single-segment calls',async()=>{
 const f=fixture(),p=await f.engine.scan(),sleeps=[];f.e.sleep=async ms=>sleeps.push(ms);
 await f.engine.publish([p.clips[0].key],p.token);await f.engine.publish([p.clips[1].key],p.token);
 assert.equal(sleeps.filter(n=>n===1000).length,30);assert.equal(posts(f).length,2);
});
test('stopping during cooldown prevents a pending POST',async()=>{
 const f=fixture(),p=await f.engine.scan();await f.engine.publish([p.clips[0].key],p.token);
 f.e.sleep=async ms=>{if(ms===1000)f.engine.stop();};await f.engine.publish([p.clips[1].key],p.token);assert.equal(posts(f).length,1);
});
test('cooldown and publication reuse the scanned account; the next scan detects an account switch',async()=>{
 let changed=false;const f=fixture({onRequest:async route=>changed&&route==='nav'?{http:200,json:{code:0,data:{mid:456,isLogin:true}}}:undefined}),p=await f.engine.scan();
 await f.engine.publish([p.clips[0].key],p.token);f.e.sleep=async ms=>{if(ms===1000)changed=true;};await f.engine.publish([p.clips[1].key],p.token);assert.equal(posts(f).length,2);assert.equal(f.calls.filter(c=>c.route==='nav').length,1);const next=await f.engine.scan();assert.equal(next.uid,'456');assert.equal(f.calls.filter(c=>c.route==='nav').length,2);
});
test('open review preserves consent beyond 15 minutes using scanned ranges; closing expires it',async()=>{
 const f=fixture(),p=await f.engine.scan(),keys=p.clips.map(c=>c.key),session=f.engine.beginReview(p.token,keys);f.e.now=()=>p.created+3600;
 await f.engine.randomCover(keys[0]);await f.engine.publish([keys[0]],p.token);assert.equal(posts(f).filter(c=>c.route==='publish').length,1);
 f.engine.endReview(session);await assert.rejects(f.engine.publish([keys[1]],p.token),/15分钟/);
});
test('review consent does not extend to unselected clips or a replacement snapshot',async()=>{
 const f=fixture(),p=await f.engine.scan();f.engine.beginReview(p.token,[p.clips[0].key]);f.e.now=()=>p.created+3600;
 await assert.rejects(f.engine.publish([p.clips[1].key],p.token),/15分钟/);assert.equal(posts(f).length,0);
 const next=await f.engine.scan();assert.equal(f.engine.reviewCurrent(next,next.clips[0].key),false);
});
test('explicit refresh discovers a hidden successful request before manual reset',async()=>{
 const f=fixture({onRequest:async route=>route==='publish'?{http:200,json:{code:4001,message:'操作太快'}}:undefined}),p=await f.engine.scan(),c=p.clips[0];
 await assert.rejects(f.engine.publish([c.key],p.token));f.published.push({slice_id:987,av_status:1,av_title:c.title,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
 await f.engine.reconcile();await assert.rejects(f.engine.allowRetry([c.key]),/明确失败|不能重试/);assert.equal(posts(f).length,1);
});

test('native transport uses credentialed page fetch with form body; never extension or websocket',async()=>{
 const calls=[];const request=C.createRequestTransport({mode:()=> 'page-fetch',controller:()=>new AbortController(),fetch:async(url,init)=>{calls.push({url,init});return {status:200,url,headers:{get:()=> 'trace-123'},text:async()=>'{"code":4001,"message":"操作太快"}'};},gm:()=>assert.fail('must not fall back')});
 const result=await request(C.ROUTES.publish,{live_key:'123',csrf:'a'.repeat(32),av_title:'主题'},'POST');
 assert.equal(result.json.code,4001);assert.equal(result.transport,'page-fetch');assert.equal(result.traceId,'trace-123');assert.equal(calls.length,1);assert.equal(calls[0].init.credentials,'include');assert.equal(calls[0].init.redirect,'error');assert.equal(new URL(calls[0].url).searchParams.has('csrf'),false);assert.equal(new URLSearchParams(calls[0].init.body).get('csrf'),'a'.repeat(32));assert.equal(calls[0].init.headers['Content-Type'],'application/x-www-form-urlencoded');assert(!('Origin' in calls[0].init.headers));assert(!('Referer' in calls[0].init.headers));
});
test('native transport keeps frames JSON and csrf in query, GET params in URL',async()=>{
 const calls=[];const request=C.createRequestTransport({mode:()=> 'page-fetch',controller:()=>new AbortController(),fetch:async(url,init)=>{calls.push({url,init});return {status:200,url,headers:{get:()=>null},text:async()=>'{"code":0,"data":{}}'};}});
 await request(C.ROUTES.frames,{live_key:'123',time_list:'100',csrf:'a'.repeat(32)},'POST',{json:true});assert.equal(new URL(calls[0].url).searchParams.get('csrf'),'a'.repeat(32));assert.deepEqual(JSON.parse(calls[0].init.body),{live_key:'123',time_list:'100'});
 await request(C.ROUTES.published,{page:1,page_size:20},'GET');assert.equal(new URL(calls[1].url).searchParams.get('page_size'),'20');assert.equal(calls[1].init.body,undefined);
});
test('CORS/network errors never fall back after POST, timeout aborts with unknown outcome',async()=>{
 let native=0,extension=0;const options={mode:()=> 'page-fetch',controller:()=>new AbortController(),gm:()=>extension++,fetch:async()=>{native++;throw Error('CORS');}};
 await assert.rejects(C.createRequestTransport(options)(C.ROUTES.publish,{},'POST'),/不会自动切换/);assert.equal(native,1);assert.equal(extension,0);
 options.timeoutMs=5;options.fetch=async(_,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'}))));
 await assert.rejects(C.createRequestTransport(options)(C.ROUTES.publish,{},'POST'),/超时/);assert.equal(extension,0);
});
test('extension mode is explicit and preserves cookies; forbidden URLs and redirects stop',async()=>{
 let called=0;const options={mode:()=> 'extension-http',gm:details=>{called++;assert.equal(details.anonymous,false);details.onload({status:200,finalUrl:details.url,responseText:'{"code":0,"data":{}}',responseHeaders:'x-bili-trace-id: trace-123'});}};
 const request=C.createRequestTransport(options);assert.equal((await request(C.ROUTES.nav,{},'GET')).transport,'extension-http');assert.equal(called,1);await assert.rejects(request('https://evil.example/',{},'GET'),/白名单/);
 options.gm=details=>details.onload({status:200,finalUrl:'https://evil.example/',responseText:'{"code":0}'});await assert.rejects(request(C.ROUTES.nav,{},'GET'),/其它来源/);
});
test('request diagnostics contain method, transport, business code and duration without CSRF values',async()=>{
 const f=fixture(),p=await f.engine.scan();await f.engine.publish([p.clips[0].key],p.token);
 const event=f.engine.events.find(e=>e.route==='publish'&&e.phase==='start');assert.equal(event.method,'POST');assert.equal(event.transport,'custom');assert(!event.fields.includes('csrf'));assert(!JSON.stringify(f.engine.events).includes('a'.repeat(32)));
});

test('reset rejected task immediately unblocks the original numbered clip without publishing or renumbering',async()=>{
 let reject=true;const f=fixture({onRequest:async route=>route==='publish'&&reject?{http:200,json:{code:4001,message:'操作太快'}}:undefined}),p=await f.engine.scan(),c=p.clips[0],keys=p.clips.map(c=>c.key),titles=p.clips.map(c=>c.title);
 await assert.rejects(f.engine.publish([c.key],p.token));const numbering=clone(f.store['123'].numbering),cooldown=f.store['123'].nextSubmitAt;c.blocked=true;c.state='rejected';
 await f.engine.allowRetry([c.key]);assert(!c.blocked);assert.equal(c.state,'retry_ready');assert.equal(posts(f).length,1);assert.equal(f.store['123'].nextSubmitAt,cooldown);assert.deepEqual(f.store['123'].numbering,numbering);assert.deepEqual(p.clips.map(c=>c.title),titles);assert.deepEqual(p.clips.map(c=>c.key),keys);
 reject=false;await f.engine.publish([c.key],p.token);assert.equal(posts(f).length,2);assert.equal(f.calls.filter(c=>c.route==='publish').at(-1).p.av_title,titles[0]);
});
test('a failed own server ID cannot hide another successful overlapping record when resetting',async()=>{
 const f=fixture(),p=await f.engine.scan(),c=p.clips[0];f.store['123'].tasks[c.key]={clip:c,state:'remote_failed',attempts:1,sliceId:'100'};
 f.published.push({slice_id:100,av_status:3,av_title:c.title,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)},{slice_id:101,av_status:1,av_title:c.title,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
 f.engine.rememberPublications('123',f.published);await assert.rejects(f.engine.allowRetry([c.key]),/不能重试/);assert.equal(f.store['123'].tasks[c.key].state,'remote_failed');assert.equal(posts(f).length,0);
});
test('reset ignores confirmed failed server IDs only and retains failure history and numbering',async()=>{
 const f=fixture(),p=await f.engine.scan(),c=p.clips[0];f.store['123'].tasks[c.key]={clip:c,state:'remote_failed',attempts:1,sliceId:'100',message:'failed'};f.published.push({slice_id:100,av_status:3,av_title:c.title,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
 f.engine.rememberPublications('123',f.published);await f.engine.allowRetry([c.key]);const task=f.store['123'].tasks[c.key];assert.equal(task.state,'retry_ready');assert.equal(task.sliceId,'');assert.deepEqual(task.ignoreFailedIDs,['100']);assert.equal(task.history[0].message,'failed');assert(!C.remoteConflict(c,f.published,task));
});
test('unknown and accepted tasks cannot be reset; no local-only clear bypasses their evidence',async()=>{
 for(const state of ['unknown','sending','accepted','processing','posted']){const f=fixture(),p=await f.engine.scan(),c=p.clips[0];f.store['123'].tasks[c.key]={clip:c,state,attempts:1};await assert.rejects(f.engine.allowRetry([c.key]));assert.equal(f.store['123'].tasks[c.key].state,state);assert.equal(posts(f).length,0);}
});
test('explicit duplicate rejection is resettable only when all current server conflicts are gone',async()=>{
 const f=fixture({onRequest:async route=>route==='publish'?{http:200,json:{code:4006,message:'title used'}}:undefined}),p=await f.engine.scan(),c=p.clips[0];await assert.rejects(f.engine.publish([c.key],p.token));assert.equal(f.store['123'].tasks[c.key].state,'duplicate');await f.engine.allowRetry([c.key]);assert.equal(f.store['123'].tasks[c.key].state,'retry_ready');assert.equal(posts(f).length,1);
});
test('saved cover timestamps survive a new engine and scan; reread is at exactly the selected timestamp',async()=>{
 const f=fixture(),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key);await f.engine.saveCoverChoice(c.key,choice);
 const second=new C.Engine(f.e),next=await second.scan(),saved=await second.savedCoverChoices([c.key]);assert.equal(saved[c.key].ts,choice.ts);const restored=await second.randomCover(c.key,undefined,saved[c.key].ts);assert.equal(restored.ts,choice.ts);assert.equal(f.calls.filter(c=>c.route==='frames').at(-1).p.time_list,String(choice.ts));assert.equal(f.calls.filter(c=>c.route==='publish').length,0);assert(!JSON.stringify(f.store['123'].coverDrafts).includes('https://'));assert(!JSON.stringify(f.store['123'].coverDrafts).includes('a'.repeat(32)));
});
test('simultaneous cover saves merge independent clips without losing task or numbering data',async()=>{
 const f=fixture(),p=await f.engine.scan(),[a,b]=p.clips,ca=await f.engine.randomCover(a.key),cb=await f.engine.randomCover(b.key),numbering=clone(f.store['123'].numbering);f.store['123'].tasks.keep={state:'unknown'};
 await Promise.all([f.engine.saveCoverChoice(a.key,ca),f.engine.saveCoverChoice(b.key,cb)]);assert.equal(Object.keys(f.store['123'].coverDrafts).length,2);assert.equal(f.store['123'].tasks.keep.state,'unknown');assert.deepEqual(f.store['123'].numbering,numbering);
});
test('default cover choice persists and corrupt, out-of-range or mismatched timestamp drafts are ignored',async()=>{
 const f=fixture(),p=await f.engine.scan(),[a,b]=p.clips;await f.engine.saveCoverChoice(a.key,{source:'default',url:a.defaultCover,ts:null});assert.equal((await f.engine.savedCoverChoices([a.key]))[a.key].source,'default');
 f.store['123'].coverDrafts[b.key]={source:'random',ts:b.end,liveKey:b.liveKey,start:b.start,end:b.end};assert(!Object.hasOwn(await f.engine.savedCoverChoices([b.key]),b.key));await assert.rejects(f.engine.randomCover(b.key,undefined,b.end),/时间/);
 assert.throws(()=>f.engine.saveCoverChoice(b.key,{source:'random',url:b.cover,ts:b.start}),/未经当前计划读取/);
});
test('saved cover choices are isolated by logged-in account',async()=>{
 let uid=123;const f=fixture({onRequest:async route=>route==='nav'?{http:200,json:{code:0,data:{mid:uid,isLogin:true}}}:undefined}),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key);await f.engine.saveCoverChoice(c.key,choice);uid=456;assert.equal((await f.engine.savedCoverChoices([c.key]))[c.key].ts,choice.ts);await f.engine.scan();assert.deepEqual(await f.engine.savedCoverChoices([c.key]),{});
});

test('old rejected tasks can reuse their already-recorded approved cover timestamp, newer draft wins',async()=>{
 const f=fixture(),p=await f.engine.scan(),c=p.clips[0];f.store['123'].tasks[c.key]={clip:c,state:'rejected',attempts:1,approvedCover:{source:'random',ts:c.start+100,url:'https://i0.hdslb.com/bfs/live/old.jpg'}};
 assert.equal((await f.engine.savedCoverChoices([c.key]))[c.key].ts,c.start+100);f.store['123'].coverDrafts={[c.key]:{liveKey:c.liveKey,start:c.start,end:c.end,source:'default',ts:null}};assert.equal((await f.engine.savedCoverChoices([c.key]))[c.key].source,'default');assert.equal(posts(f).length,0);
});

test('a three-clip batch and later automatic scans reuse one complete initial publication pagination',async()=>{
 const rows=Array.from({length:45},(_,i)=>({slice_id:10000+i,av_status:2,av_title:'历史'+i,start_tm:C.stamp(1000000000+i*200),end_tm:C.stamp(1000000100+i*200)})),f=fixture({published:rows});withCache(f);const p=await f.engine.scan(),initial=f.calls.filter(c=>c.route==='published').length;
 assert.equal(initial,3);await f.engine.publish(p.clips.map(c=>c.key),p.token);assert.equal(f.calls.filter(c=>c.route==='publish').length,3);assert.equal(f.calls.filter(c=>c.route==='published').length,initial);await f.engine.scan();assert.equal(f.calls.filter(c=>c.route==='published').length,initial);
});
test('manual rejection reset and one-segment retries add zero publication list requests',async()=>{
 let reject=true;const f=fixture({onRequest:async route=>route==='publish'&&reject?{http:200,json:{code:4001,message:'too fast'}}:undefined}),p=await f.engine.scan(),c=p.clips[0],initial=f.calls.filter(c=>c.route==='published').length;
 await assert.rejects(f.engine.publish([c.key],p.token));await f.engine.allowRetry([c.key]);reject=false;await f.engine.publish([c.key],p.token);assert.equal(f.calls.filter(c=>c.route==='published').length,initial);assert.equal(f.calls.filter(c=>c.route==='publish').length,2);
});
test('local accepted titles block a later same-title clip without consulting the server list',async()=>{
 const f=fixture(),p=await f.engine.scan(),[a,b]=p.clips,initial=f.calls.filter(c=>c.route==='published').length;
 await f.engine.publish([a.key],p.token,undefined,{[a.key]:'本批次同名'});await assert.rejects(f.engine.publish([b.key],p.token,undefined,{[b.key]:'本批次同名'}),/本地已有/);assert.equal(f.calls.filter(c=>c.route==='publish').length,1);assert.equal(f.calls.filter(c=>c.route==='published').length,initial);
 await f.engine.publish([b.key],p.token,undefined,{[b.key]:'修改后不同名'});assert.equal(f.calls.filter(c=>c.route==='publish').length,2);
});
test('new external uploads are intentionally not fetched before submission until an explicit refresh',async()=>{
 const f=fixture(),p=await f.engine.scan(),c=p.clips[0],initial=f.calls.filter(c=>c.route==='published').length;f.published.push({slice_id:999,av_status:2,av_title:c.title,start_tm:C.stamp(c.start),end_tm:C.stamp(c.end)});
 await f.engine.publish([c.key],p.token);assert.equal(f.calls.filter(c=>c.route==='published').length,initial);assert.equal(f.calls.filter(c=>c.route==='publish').length,1);await f.engine.reconcile();assert.equal(f.calls.filter(c=>c.route==='published').length,initial+1);
});
test('manual force refresh and account switch each obtain one complete list; unverified plans cannot publish',async()=>{
 const f=fixture();await f.engine.scan();assert.equal(f.calls.filter(c=>c.route==='published').length,1);await f.engine.scan({}, {force:true});assert.equal(f.calls.filter(c=>c.route==='published').length,2);
 const second=new C.Engine(f.e);second.snapshot=f.engine.snapshot;await assert.rejects(second.publish([second.snapshot.clips[0].key],second.snapshot.token),/初始投稿检查|扫描以确认当前账号/);assert.equal(f.calls.filter(c=>c.route==='publish').length,0);
});

test('one prepared account ticket supplies startup and scan with exactly one nav; tickets cannot be reused',async()=>{
 const f=fixture(),ticket=await f.engine.prepareScan();await f.engine.scan({}, {accountTicket:ticket});assert.equal(f.calls.filter(c=>c.route==='nav').length,1);await assert.rejects(f.engine.scan({}, {accountTicket:ticket}),/失效/);assert.equal(f.calls.filter(c=>c.route==='nav').length,1);await f.engine.scan();assert.equal(f.calls.filter(c=>c.route==='nav').length,2);
});
test('covers, save, reset, publish retry and manual status refresh add no nav after scanning',async()=>{
 let reject=true;const f=fixture({onRequest:async route=>route==='publish'&&reject?{http:200,json:{code:4001,message:'too fast'}}:undefined}),p=await f.engine.scan(),c=p.clips[0];const cover=await f.engine.randomCover(c.key);await f.engine.saveCoverChoice(c.key,cover);await f.engine.savedCoverChoices([c.key]);await assert.rejects(f.engine.publish([c.key],p.token));await f.engine.allowRetry([c.key]);reject=false;await f.engine.publish([c.key],p.token);await f.engine.reconcile();assert.equal(f.calls.filter(c=>c.route==='nav').length,1);assert.equal(f.calls.filter(c=>c.route==='publish').length,2);
});
test('default interval waits 100ms before publish without another streams request',async()=>{
 const f=fixture(),p=await f.engine.scan(),sleeps=[];f.e.sleep=async ms=>sleeps.push(ms);await f.engine.publish([p.clips[0].key],p.token);assert.deepEqual(sleeps,[100]);assert.deepEqual(f.engine.events.filter(e=>e.phase==='interval'&&e.route==='publish').map(e=>e.intervalMs),[100]);
});
test('custom request interval including zero applies to publish without rereading streams',async()=>{
 for(const value of [0,275,1500]){
  const f=fixture(),p=await f.engine.scan();let elapsed=0;const stamps=[];f.e.interval=()=>value;f.e.sleep=async ms=>{elapsed+=ms;};const original=f.e.request;f.e.request=async(url,...args)=>{stamps.push({url,at:elapsed});return original(url,...args);};
  await f.engine.publish([p.clips[0].key],p.token);assert(!stamps.some(s=>s.url===C.ROUTES.streams));assert.equal(stamps.find(s=>s.url===C.ROUTES.publish).at,value);
 }
});
test('invalid intervals are rejected before any streams or publish network request',async()=>{
 for(const value of [-1,60001,1.5,'',null,'bad']){assert.throws(()=>C.requestIntervalMs(value));const f=fixture(),p=await f.engine.scan(),before=f.calls.length;f.e.interval=()=>value;await assert.rejects(f.engine.publish([p.clips[0].key],p.token),/间隔/);assert(!f.calls.slice(before).some(c=>c.route==='streams'||c.route==='publish'));}
});
test('stopping during the publish-specific interval prevents POST and leaves no sending task',async()=>{
 const f=fixture(),p=await f.engine.scan();let sleeps=0;f.e.sleep=async ms=>{if(ms===100&&++sleeps===1)f.engine.stop();};await f.engine.publish([p.clips[0].key],p.token);assert.equal(f.calls.filter(c=>c.route==='publish').length,0);assert(!f.store['123'].tasks[p.clips[0].key]);
});

test('covers, failed submission, retry and batch continuation add no streams/nav/publication-list requests',async()=>{
 let reject=true;const f=fixture({onRequest:async route=>route==='publish'&&reject?{http:200,json:{code:4001,message:'too fast'}}:undefined}),p=await f.engine.scan(),[a,b]=p.clips,before=f.calls.length;
 const cover=await f.engine.randomCover(a.key);await f.engine.saveCoverChoice(a.key,cover);await assert.rejects(f.engine.publish([a.key],p.token));reject=false;await f.engine.publish([b.key],p.token);await f.engine.allowRetry([a.key]);await f.engine.publish([a.key],p.token);
 assert(!f.calls.slice(before).some(c=>['nav','published','streams'].includes(c.route)));assert.equal(f.calls.filter(c=>c.route==='publish').length,3);
});
test('an interval outside the scanned ranges is locally rejected without fetching streams or submitting',async()=>{
 const f=fixture(),p=await f.engine.scan(),c=p.clips[0],before=f.calls.length;p.sessions[0].ranges=[[c.start+1,c.end]];
 await assert.rejects(f.engine.publish([c.key],p.token),/扫描确认的录像范围/);assert.equal(f.calls.length,before);
});

test('temporary signed covers cannot enter publish payload; uploaded HTTP BFS location is preserved',()=>{
 const c=C.makeClips(REPLAY,STREAM).clips[0];assert.throws(()=>C.payload({...c,cover:'https://jssz-boss.hdslb.com/live2arc_anchor_video/frame.jpg?X-Amz-Signature=SYNTHETIC'},'a'.repeat(32)),/稳定图片/);
 assert.equal(C.payload({...c,cover:'http://i0.hdslb.com/bfs/live/uploaded.jpg'},'a'.repeat(32)).av_cover,'http://i0.hdslb.com/bfs/live/uploaded.jpg');assert.equal(C.payload(c,'a'.repeat(32)).with_reserve,0);
});
function uploadFixture(settings={}){
 let rejected=settings.rejectFirst===true,reads=0;const location=settings.location||'http://i0.hdslb.com/bfs/live/uploaded.jpg';
 const f=fixture({onRequest:async(route,p)=>{
  if(route==='frames')return {http:200,json:{code:0,data:{list:[{ts:Number(p.time_list),url:'https://jssz-boss.hdslb.com/live2arc_anchor_video/frame-'+p.time_list+'.jpg?X-Amz-Signature=SYNTHETIC'}]}}};
  if(route==='upload')return {http:200,json:settings.uploadFail?{code:500,message:'upload failed'}:{code:0,data:{location}}};
  if(route==='publish'&&rejected){rejected=false;return {http:200,json:{code:4001,message:'synthetic error'}};}
 }});
 f.e.readImage=async()=>{reads++;if(settings.readFail)throw Error('synthetic image read failure');if(settings.stopRead)f.engine.stop();return new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});};return {...f,reads:()=>reads};
}
test('signed-frame publication uploads selected image before publish and passes only returned stable URL',async()=>{
 const f=uploadFixture(),p=await f.engine.scan(),c=p.clips[0],cover=await f.engine.randomCover(c.key),before=f.calls.length;await f.engine.publish([c.key],p.token,{[c.key]:cover});
 const after=f.calls.slice(before);assert.deepEqual(after.map(c=>c.route),['upload','publish']);assert.equal(after[0].p.bucket,'live');assert.equal(after[0].p.file.type,'image/jpeg');assert.equal(after[1].p.av_cover,'http://i0.hdslb.com/bfs/live/uploaded.jpg');assert.equal(f.reads(),1);assert.equal(f.store['123'].tasks[c.key].approvedCover.url,after[1].p.av_cover);
 assert(!JSON.stringify(f.store).includes('X-Amz-Signature'));assert(!JSON.stringify(f.engine.events).includes('X-Amz-Signature'));assert(!JSON.stringify(f.engine.events).includes('a'.repeat(32)));
});
test('manual retry reuses the successful stable upload rather than uploading or reading the image again',async()=>{
 const f=uploadFixture({rejectFirst:true}),p=await f.engine.scan(),c=p.clips[0],cover=await f.engine.randomCover(c.key);await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:cover}),/4001/);await f.engine.allowRetry([c.key]);await f.engine.publish([c.key],p.token,{[c.key]:cover});assert.equal(f.calls.filter(c=>c.route==='upload').length,1);assert.equal(f.calls.filter(c=>c.route==='publish').length,2);assert.equal(f.reads(),1);
});
test('failed image read, failed upload or unstable upload response never sends publish or leaves sending task',async()=>{
 for(const settings of [{readFail:true},{uploadFail:true},{location:'https://jssz-boss.hdslb.com/frame.jpg?signature=SYNTHETIC'}]){
  const f=uploadFixture(settings),p=await f.engine.scan(),c=p.clips[0],cover=await f.engine.randomCover(c.key);await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:cover}));assert.equal(f.calls.filter(c=>c.route==='publish').length,0);assert(!f.store['123'].tasks[c.key]);
 }
});
test('default stable covers need no image fetch or upload, stopping after image read prevents both writes',async()=>{
 const f=fixture(),p=await f.engine.scan();f.e.readImage=async()=>assert.fail('unneeded image fetch');await f.engine.publish([p.clips[0].key],p.token);assert.equal(f.calls.filter(c=>c.route==='upload').length,0);
 const g=uploadFixture({stopRead:true}),q=await g.engine.scan(),c=q.clips[0],cover=await g.engine.randomCover(c.key);await g.engine.publish([c.key],q.token,{[c.key]:cover});assert.equal(g.calls.filter(c=>['upload','publish'].includes(c.route)).length,0);
});
test('image upload uses browser multipart boundary with bucket/file and csrf only in query',async()=>{
 let sent;const file=new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'}),request=C.createRequestTransport({mode:()=> 'page-fetch',controller:()=>new AbortController(),fetch:async(url,init)=>{sent={url,init};return {status:200,url,headers:{get:()=>null},text:async()=>'{"code":0,"data":{"location":"http://i0.hdslb.com/bfs/live/test.jpg"}}'};}});
 await request(C.ROUTES.upload,{csrf:'a'.repeat(32),bucket:'live',file},'POST',{multipart:true});assert.equal(new URL(sent.url).searchParams.get('csrf'),'a'.repeat(32));assert.deepEqual(Object.keys(sent.init.headers),[]);assert.equal(sent.init.body.get('bucket'),'live');assert.equal(sent.init.body.has('csrf'),false);assert.equal(sent.init.body.get('file').type,'image/jpeg');assert.equal(sent.init.credentials,'include');
});
test('image reader uses selected URL without account cookies and rejects unsupported image content',async()=>{
 let sent;const read=C.createImageReader({mode:()=> 'page-fetch',controller:()=>new AbortController(),fetch:async(url,init)=>{sent={url,init};return {status:200,blob:async()=>new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'})};}});await read('https://jssz-boss.hdslb.com/live2arc_anchor_video/frame.jpg?X-Amz-Signature=SYNTHETIC');assert.equal(sent.init.credentials,'omit');assert.equal(sent.init.referrerPolicy,'no-referrer');assert.equal(sent.init.redirect,'error');assert.throws(()=>C.checkedImage(new Blob(['svg'],{type:'image/svg+xml'})));assert.throws(()=>C.checkedImage(new Blob([],{type:'image/jpeg'})));
});
function renewalFixture(options={}){
 let frameCalls=0,reads=0;const f=fixture({onRequest:async(route,p,method,e,engine)=>{
  if(route==='frames'){frameCalls++;if(frameCalls===2&&options.frameFail)return {http:200,json:{code:500,message:'frame unavailable'}};if(frameCalls===2&&options.stopRefresh)engine.stop();return {http:200,json:{code:0,data:{list:[{ts:Number(p.time_list)+(frameCalls===2&&options.differentTime?1:0),url:'https://jssz-boss.hdslb.com/live2arc_anchor_video/same-frame.jpg?X-Amz-Signature=SYNTHETIC-'+frameCalls}]}}};}
  if(route==='upload')return {http:200,json:{code:0,data:{location:'http://i0.hdslb.com/bfs/live/renewed.jpg'}}};
 }});f.e.readImage=async()=>{reads++;if(options.alwaysFail||reads===1)throw Error('expired or CORS');return new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});};return {...f,reads:()=>reads,frameCount:()=>frameCalls};
}
test('expired image is reissued once at exactly the chosen timestamp before upload and publication',async()=>{
 const f=renewalFixture(),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key),refreshed=[];f.e.coverRefresh=(key,cover)=>refreshed.push({key,cover});const before=f.calls.length;await f.engine.publish([c.key],p.token,{[c.key]:choice});
 assert.deepEqual(f.calls.slice(before).map(c=>c.route),['frames','upload','publish']);assert.equal(f.reads(),2);assert.deepEqual(f.calls.filter(c=>c.route==='frames').map(c=>c.p.time_list),[String(choice.ts),String(choice.ts)]);assert.equal(refreshed[0].cover.ts,choice.ts);assert.notEqual(refreshed[0].cover.url,choice.url);assert.equal(f.calls.find(c=>c.route==='publish').p.av_cover,'http://i0.hdslb.com/bfs/live/renewed.jpg');
});
test('persistent image failures stop after one timestamp refresh, without upload or publish',async()=>{
 const f=renewalFixture({alwaysFail:true}),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key);await f.engine.saveCoverChoice(c.key,choice);await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:choice}),/重新取图一次/);assert.equal(f.frameCount(),2);assert.equal(f.reads(),2);assert.equal(f.calls.filter(c=>['upload','publish'].includes(c.route)).length,0);assert.equal(f.store['123'].coverDrafts[c.key].ts,choice.ts);assert(!f.store['123'].tasks[c.key]);
});
test('frame refresh API failure does not trigger another image read or publication',async()=>{
 const f=renewalFixture({frameFail:true}),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key);await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:choice}),/500/);assert.equal(f.reads(),1);assert.equal(f.frameCount(),2);assert.equal(f.calls.filter(c=>['upload','publish'].includes(c.route)).length,0);
});
test('a changed returned timestamp cannot silently replace the approved frame',async()=>{
 const f=renewalFixture({differentTime:true}),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key);await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:choice}),/不同时间/);assert.equal(f.reads(),1);assert.equal(f.calls.filter(c=>['upload','publish'].includes(c.route)).length,0);
});
test('stopping during timestamp refresh prevents image upload and publication',async()=>{
 const f=renewalFixture({stopRefresh:true}),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key);await f.engine.publish([c.key],p.token,{[c.key]:choice});assert.equal(f.reads(),1);assert.equal(f.calls.filter(c=>['upload','publish'].includes(c.route)).length,0);
});

test('actual JPEG/PNG/WebP headers override octet-stream, missing or incorrect MIME without changing bytes',async()=>{
 const formats=[{type:'image/jpeg',bytes:[255,216,255,224,0,16,74,70,73,70]},{type:'image/png',bytes:[137,80,78,71,13,10,26,10,0,0,0,0]},{type:'image/webp',bytes:[82,73,70,70,0,0,0,0,87,69,66,80]}];
 for(const {type,bytes}of formats)for(const responseType of ['application/octet-stream','','text/plain',type]){const blob=new Blob([new Uint8Array(bytes)],{type:responseType}),normalized=await C.normalizeImage(blob);assert.equal(normalized.type,type);assert.deepEqual(new Uint8Array(await normalized.arrayBuffer()),new Uint8Array(bytes));}
});
test('valid octet-stream download reports success with detected MIME and is not treated as CORS',async()=>{
 const reports=[];const reader=C.createImageReader({mode:()=> 'page-fetch',controller:()=>new AbortController(),report:meta=>reports.push(meta),fetch:async()=>({status:200,blob:async()=>new Blob([new Uint8Array([255,216,255,217])],{type:'application/octet-stream'})})});const blob=await reader('https://jssz-boss.hdslb.com/frame.jpg');assert.equal(blob.type,'image/jpeg');assert.deepEqual(reports,[{http:200,sourceType:'application/octet-stream',detectedType:'image/jpeg',imageBytes:4}]);
});
test('HTTP and network errors are distinct from downloaded non-image content',async()=>{
 const options={mode:()=> 'page-fetch',controller:()=>new AbortController(),fetch:async()=>({status:403})};await assert.rejects(C.createImageReader(options)('https://i0.hdslb.com/x.jpg'),e=>e.imageStage==='download'&&e.imageHTTP===403&&e.message.includes('HTTP 403'));
 options.fetch=async()=>{throw Error('fetch failure');};await assert.rejects(C.createImageReader(options)('https://i0.hdslb.com/x.jpg'),e=>e.imageStage==='download'&&e.message.includes('未取得图片字节'));
 options.fetch=async()=>({status:200,blob:async()=>new Blob(['<html>not image</html>'],{type:'image/jpeg'})});await assert.rejects(C.createImageReader(options)('https://i0.hdslb.com/x.jpg'),e=>e.imageStage==='format'&&e.message.includes('已下载')&&!e.message.includes('CORS'));
});
test('extension reader also recognizes octet-stream by bytes and keeps anonymous image GET',async()=>{
 let details;const reader=C.createImageReader({mode:()=> 'extension-http',gm:d=>{details=d;d.onload({status:200,finalUrl:d.url,response:new Blob([new Uint8Array([255,216,255,217])],{type:'application/octet-stream'})});}});assert.equal((await reader('https://jssz-boss.hdslb.com/frame.jpg')).type,'image/jpeg');assert.equal(details.anonymous,true);assert.equal(details.responseType,'blob');
});
test('octet-stream image continues to upload and publish without an unnecessary frame refresh',async()=>{
 const f=uploadFixture(),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key),before=f.calls.length;f.e.readImage=async()=>new Blob([new Uint8Array([255,216,255,217])],{type:'application/octet-stream'});await f.engine.publish([c.key],p.token,{[c.key]:choice});assert.deepEqual(f.calls.slice(before).map(c=>c.route),['upload','publish']);assert.equal(f.calls.find(c=>c.route==='upload').p.file.type,'image/jpeg');
});
test('downloaded HTML or oversized bodies stop at validation without re-fetching frames or publishing',async()=>{
 for(const data of [new Blob(['<html>not an image</html>'],{type:'image/jpeg'}),new Blob([new Uint8Array(10*1024*1024+1)],{type:'application/octet-stream'})]){const f=uploadFixture(),p=await f.engine.scan(),c=p.clips[0],choice=await f.engine.randomCover(c.key),before=f.calls.length;f.e.readImage=async()=>data;await assert.rejects(f.engine.publish([c.key],p.token,{[c.key]:choice}),e=>['format','size'].includes(e.imageStage));assert.equal(f.calls.length,before);}
});
