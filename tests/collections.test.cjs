// Synthetic creator fixtures only. Never calls Bilibili or uses account records.
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../bilibili-cloud-replay.user.js'),clone=structuredClone;
function fixture(options={}){
 let uid=123,store={version:1,tasks:{}},writes=0;
 const calls=[],seasons=new Map(),sections=new Map();
 const remote=Object.fromEntries([1,2,3].map(aid=>[aid,{archive:{aid,mid:123,title:'原神 '+aid,tag:'游戏',desc:'合成简介',tid:1,copyright:1,cover:'//i0.hdslb.com/bfs/archive/synthetic.jpg',state:0,interactive:0,season_id:0},videos:[{cid:aid+100,filename:'synthetic-'+aid,title:'分P标题',desc:''}]}]));
 const publications=[1,2,3].map(aid=>({slice_id:aid+1000,avid:aid,av_title:remote[aid].archive.title,av_status:2}));
 const addSeason=(id=10,title='已有合集',sectionIds=[100])=>{
  const d={season:{id,mid:123,title,desc:'',cover:remote[1].archive.cover},sections:{sections:sectionIds.map(sid=>({id:sid,seasonId:id,title:'默认章节',epCount:0}))}};
  seasons.set(String(id),d);for(const sid of sectionIds)sections.set(String(sid),{section:{id:sid,seasonId:id,epCount:0},episodes:[]});return d;
 };
 const addMember=(sid,aid,cid=Number(aid)+100)=>{
  const d=sections.get(String(sid)),season=seasons.get(String(d.section.seasonId));d.episodes.push({aid:Number(aid),cid:Number(cid),sectionId:Number(sid),seasonId:d.section.seasonId});d.section.epCount=d.episodes.length;season.sections.sections.find(s=>String(s.id)===String(sid)).epCount=d.episodes.length;
 };
 const env={now:()=>1,interval:()=>0,csrf:()=> 'a'.repeat(32),sleep:async ms=>{await options.onSleep?.(ms);},lock:async(_,fn)=>fn(),read:async()=>clone(store),write:async(_,value)=>{writes++;if(options.failWrite)throw new Error('journal unavailable');store=clone(value);await options.onWrite?.(clone(value));}};
 env.request=async(url,p,method,format)=>{
  const route=Object.keys(C.ROUTES).find(k=>C.ROUTES[k]===url);calls.push({route,p:clone(p),method,format});
  const override=await options.onRequest?.(route,p,method);if(override!==undefined)return override;
  let data;
  if(route==='nav')data={mid:uid,isLogin:true};
  else if(route==='collections'){const all=[...seasons.values()];data={total:all.length,seasons:clone(all.slice((p.pn-1)*p.ps,p.pn*p.ps))};}
  else if(route==='collectionDetail')data=clone(seasons.get(String(p.id)));
  else if(route==='collectionSection')data=clone(sections.get(String(p.id)));
  else if(route==='published')data={total:publications.length,list:clone(publications.slice((p.page-1)*p.page_size,p.page*p.page_size))};
  else if(route==='manuscript')data=clone(remote[String(p.aid)]);
  else if(route==='createCollection'){
   if(options.rejectCreate)return {http:200,json:{code:-400,message:'rejected'}};
   if(!options.noCreateApply)addSeason(20,p.title,[200]);
   if(options.createTimeout)throw new Error('create timeout');data=20;
  }else if(route==='addCollectionEpisodes'){
   if(options.rejectAdd)return {http:200,json:{code:-400,message:'rejected'}};
   if(!options.noAddApply)for(const e of p.episodes)addMember(p.sectionId,e.aid,e.cid);
   await options.onAdd?.(p);if(options.addTimeout)throw new Error('add timeout');data={};
  }else throw new Error('Unexpected route '+route);
  return {http:200,json:{code:0,data}};
 };
 const engine=new C.Engine(env);let manager=new C.CollectionManager(engine);
 return {env,engine,options,calls,remote,seasons,sections,publications,addSeason,addMember,get manager(){return manager;},reload(){manager=new C.CollectionManager(new C.Engine(env));return manager;},setUID(value){uid=value;},store:()=>clone(store),writes:()=>writes,posts:()=>calls.filter(c=>c.method==='POST')};
}
async function preview(f,choices=[{title:'新合集',description:'合成简介',aids:['1']}]){return f.manager.preview(await f.manager.prepare(),choices);}
async function existing(f,aids=['1']){f.addSeason();return preview(f,[{seasonId:'10',sectionId:'100',aids}]);}
test('collection parsers require ownership, matching IDs, complete membership and unique sections',()=>{
 const f=fixture(),d=f.addSeason();assert.equal(C.collectionDetail(d,'123','10').id,'10');
 for(const change of [x=>x.season.mid=999,x=>x.season.id=11,x=>x.sections.sections.push(clone(x.sections.sections[0])),x=>x.sections.sections[0].seasonId=11,x=>x.sections.sections[0].epCount=-1]){const x=clone(d);change(x);assert.throws(()=>C.collectionDetail(x,'123','10'));}
 assert.deepEqual(C.collectionSection({section:{id:100,seasonId:10,epCount:0},episodes:null},'10','100'),[]);
 for(const d of [{section:{id:100,seasonId:10,epCount:1},episodes:[]},{section:{id:100,seasonId:11,epCount:0},episodes:[]},{section:{id:100,seasonId:10,epCount:2},episodes:[{aid:1,cid:101,seasonId:10,sectionId:100},{aid:1,cid:101,seasonId:10,sectionId:100}]}])assert.throws(()=>C.collectionSection(d,'10','100'));
});
test('prepare reads every collection page and chapter before suggesting importable publications',async()=>{
 const f=fixture();for(let i=1;i<=31;i++)f.addSeason(i,'合集 '+i,[i*100]);f.addMember(3100,1);
 f.publications.push({slice_id:2000,avid:0,av_title:'未返回稿件',av_status:2});
 const s=await f.manager.prepare();assert.equal(s.collections.length,31);assert.equal(s.videos.find(v=>v.aid==='1').seasonId,'31');assert.equal(s.skipped,1);
 assert.deepEqual(f.calls.filter(c=>c.route==='collections').map(c=>c.p.pn),[1,2]);assert.equal(f.calls.filter(c=>c.route==='collectionSection').length,31);assert.equal(f.posts().length,0);assert.equal(f.writes(),0);
});
test('incomplete collection pages and changing totals fail closed',async()=>{
 for(const kind of ['short','total','duplicate']){
  const f=fixture();for(let i=1;i<=31;i++)f.addSeason(i,'合集 '+i,[i*100]);
  f.options.onRequest=(route,p)=>{if(route!=='collections')return;const all=[...f.seasons.values()];if(kind==='short')return {http:200,json:{code:0,data:{total:31,seasons:all.slice(0,29)}}};if(p.pn===2)return {http:200,json:{code:0,data:{total:kind==='total'?32:31,seasons:[all[0]]}}};};
  await assert.rejects(()=>f.manager.prepare());assert.equal(f.posts().length,0);
 }
});
test('incomplete and duplicate membership across chapters or collections stop preparation',async()=>{
 for(const kind of ['incomplete','chapters','collections']){
  const f=fixture();f.addSeason(10,'第一合集',[100,101]);f.addMember(100,1);
  if(kind==='incomplete')f.sections.get('100').episodes=[];
  if(kind==='chapters')f.addMember(101,1);
  if(kind==='collections'){f.addSeason(11,'第二合集',[110]);f.addMember(110,1);}
  await assert.rejects(()=>f.manager.prepare());assert.equal(f.posts().length,0);
 }
});
test('prepare and preview are readonly and execution requires explicit confirmation',async()=>{
 const f=fixture(),p=await preview(f);assert.equal(f.posts().length,0);assert.equal(f.writes(),0);await assert.rejects(()=>f.manager.execute(p.token),/确认/);assert.equal(f.posts().length,0);
 await f.manager.execute(p.token,{checkOnly:true});assert.equal(f.posts().length,0);
});
test('create uses form encoding then JSON numeric IDs, default chapter and verified readback',async()=>{
 const f=fixture(),p=await preview(f),results=await f.manager.execute(p.token,{confirmed:true});
 assert.deepEqual(f.posts().map(c=>c.route),['createCollection','addCollectionEpisodes']);
 const create=f.posts()[0],add=f.posts()[1];assert.equal(create.format,undefined);assert.equal(create.p.title,'新合集');assert.equal(create.p.desc,'合成简介');assert.equal(create.p.season_price,0);
 assert.equal(add.format.json,true);assert.equal(add.p.sectionId,200);assert.deepEqual(add.p.episodes,[{aid:1,cid:101,title:'原神 1',charging_pay:0}]);assert.equal(results.at(-1).state,'verified');assert.equal(f.store().collectionJobs.imports['1'].state,'verified');
});
test('append preserves existing members and targets the explicitly chosen chapter',async()=>{
 const f=fixture();f.addSeason(10,'已有合集',[100,101]);f.addMember(100,2);
 const p=await preview(f,[{seasonId:10,sectionId:101,aids:['1']}]);await f.manager.execute(p.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.route),['addCollectionEpisodes']);assert.equal(f.posts()[0].p.sectionId,101);assert.equal(f.sections.get('100').episodes[0].aid,2);
});
test('full membership recheck deduplicates a concurrent addition without POST',async()=>{
 const f=fixture(),p=await existing(f);f.addMember(100,1);const results=await f.manager.execute(p.token,{confirmed:true});assert.equal(results.at(-1).state,'unchanged');assert.equal(f.posts().length,0);
});
test('same video in another chapter blocks import and cross-group duplicate AIDs block preview',async()=>{
 const f=fixture();f.addSeason(10,'已有合集',[100,101]);const p=await preview(f,[{seasonId:10,sectionId:100,aids:['1']}]);f.addMember(101,1);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
 const g=fixture();await assert.rejects(()=>preview(g,[{title:'甲合集',aids:['1']},{title:'乙合集',aids:['1']}]),/多个分组/);assert.equal(g.posts().length,0);
});
test('invalid owners, review states, multipart, interaction and unsafe CIDs block preview',async()=>{
 for(const mutate of [d=>d.archive.mid=999,d=>d.archive.state=-1,d=>d.videos.push(clone(d.videos[0])),d=>d.archive.interactive=1,d=>d.archive.season_id=10,d=>d.videos[0].cid='9007199254740992']){
  const f=fixture();mutate(f.remote[1]);await assert.rejects(()=>preview(f));assert.equal(f.posts().length,0);
 }
});
test('account changes after preview or during throttle cannot write',async()=>{
 const f=fixture(),p=await existing(f);f.setUID(999);await assert.rejects(()=>f.manager.execute(p.token,{confirmed:true}),/账号/);assert.equal(f.posts().length,0);
 const g=fixture(),q=await existing(g);g.options.onSleep=()=>g.setUID(999);await g.manager.execute(q.token,{confirmed:true});assert.equal(g.posts().length,0);
});
test('remote title, state, part or membership changes invalidate the frozen preview',async()=>{
 for(const change of [d=>d.archive.title='变化',d=>d.archive.state=-1,d=>d.videos[0].cid=999,d=>d.archive.season_id=99]){
  const f=fixture(),p=await existing(f);change(f.remote[1]);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
 }
});
test('caller mutations of session, choices and returned preview do not change execution',async()=>{
 const f=fixture();f.addSeason();const session=await f.manager.prepare(),choices=[{seasonId:10,sectionId:100,aids:['1']}],p=await f.manager.preview(session,choices);
 session.collections[0].title='篡改';choices[0].aids.push('2');p.items[0].videos[0].title='篡改';p.items[0].sectionId='999';
 await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.posts()[0].p.sectionId,100);assert.equal(f.posts()[0].p.episodes[0].title,'原神 1');assert.equal(f.posts()[0].p.episodes.length,1);
});
test('stop during throttle prevents all writes and stop after first import skips the remainder',async()=>{
 const f=fixture(),p=await existing(f);f.options.onSleep=()=>f.manager.stop();await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
 const g=fixture(),q=await existing(g,['1','2']);g.options.onAdd=()=>g.manager.stop();const results=await g.manager.execute(q.token,{confirmed:true});assert.equal(g.posts().length,1);assert(results.some(r=>r.aid==='2'&&r.state==='cancelled'));
});
test('accepted and unknown imports survive reload and are read back rather than resent',async()=>{
 for(const timeout of [false,true]){
  const f=fixture({noAddApply:true,addTimeout:timeout}),p=await existing(f);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.store().collectionJobs.imports['1'].state,timeout?'unknown':'accepted');assert.equal(f.posts().length,1);
  f.reload();const q=await preview(f,[{seasonId:10,sectionId:100,aids:['1']}]);await f.manager.execute(q.token,{confirmed:true});assert.equal(f.posts().length,1);
  f.addMember(100,1);const pending=await f.manager.checkPending();assert.equal(pending[0].state,'verified');assert.equal(f.posts().length,1);
 }
});
test('lost import response with applied membership verifies rather than retries',async()=>{
 const f=fixture({addTimeout:true}),p=await existing(f),r=await f.manager.execute(p.token,{confirmed:true});assert.equal(r.at(-1).state,'verified');assert.equal(f.posts().length,1);
});
test('explicitly rejected imports can be retried after fresh preflight',async()=>{
 const f=fixture({rejectAdd:true}),p=await existing(f);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.store().collectionJobs.imports['1'].state,'rejected');f.options.rejectAdd=false;await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(f.store().collectionJobs.imports['1'].state,'verified');
});
test('unknown creation is never blindly recreated after reload',async()=>{
 const f=fixture({createTimeout:true,noCreateApply:true}),p=await preview(f);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.store().collectionJobs.creations['new:新合集'].state,'unknown');assert.equal(f.posts().length,1);
 f.reload();const q=await preview(f);await f.manager.execute(q.token,{confirmed:true});assert.equal(f.posts().length,1);
});
test('accepted creation with unreadable chapter resumes without recreating',async()=>{
 const f=fixture();f.options.onRequest=route=>route==='collectionDetail'?{http:200,json:{code:-1,message:'temporarily unavailable'}}:undefined;
 const p=await preview(f);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.store().collectionJobs.creations['new:新合集'].state,'accepted');
 f.options.onRequest=undefined;await f.manager.execute(p.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.route),['createCollection','addCollectionEpisodes']);
});
test('journal failure before sending blocks create and append POSTs',async()=>{
 for(const target of ['new','existing']){const f=fixture(),p=target==='new'?await preview(f):await existing(f);f.options.failWrite=true;await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);}
});
test('new collection validation rejects blank/control text but does not invent size limits',()=>{
 const f=fixture(),item={title:'名'.repeat(30),description:'简'.repeat(300),cover:f.remote[1].archive.cover};assert.equal(C.collectionCreateBody(item,'a'.repeat(32)).title,item.title);
 for(const x of [{...item,title:' '},{...item,title:'坏\n名称'},{...item,description:'坏\u0000简介'}])assert.throws(()=>C.collectionCreateBody(x,'a'.repeat(32)));
});
test('unsafe CID cannot leave an empty newly created collection',async()=>{
 const f=fixture();f.remote[1].videos[0].cid='9007199254740992';
 try{const p=await preview(f);await f.manager.execute(p.token,{confirmed:true});}catch(_){}
 assert.equal(f.posts().length,0);
});
test('changed manuscript is rejected before creating an empty collection',async()=>{
 const f=fixture(),p=await preview(f);f.remote[1].archive.title='改动';await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
});
test('rejected creation can retry, but a non-unique default chapter cannot receive imports',async()=>{
 const f=fixture({rejectCreate:true}),p=await preview(f);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.store().collectionJobs.creations['new:新合集'].state,'rejected');f.options.rejectCreate=false;await f.manager.execute(p.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.route),['createCollection','createCollection','addCollectionEpisodes']);
 const g=fixture();g.options.onRequest=route=>{if(route==='collectionDetail'){const d=clone(g.seasons.get('20'));d.sections.sections.push({id:201,seasonId:20,title:'另一个章节',epCount:0});return {http:200,json:{code:0,data:d}};}};const q=await preview(g);await g.manager.execute(q.token,{confirmed:true});assert.deepEqual(g.posts().map(c=>c.route),['createCollection']);
});
test('unknown tokens, unchecked videos, assigned sources and duplicate targets cannot mutate',async()=>{
 const f=fixture();await assert.rejects(()=>f.manager.execute('unknown',{confirmed:true}));
 for(const choices of [[{title:'新合集',aids:['999']}],[{title:'新合集',aids:[]}],[{title:'重复合集',aids:['1']},{title:'重复合集',aids:['2']}]])await assert.rejects(()=>preview(f,choices));
 f.addSeason();f.addMember(100,1);await assert.rejects(()=>preview(f,[{title:'新合集',aids:['1']}]));assert.equal(f.posts().length,0);
});
test('existing duplicate name, missing chapter and repeated target choices require correction',async()=>{
 const f=fixture();f.addSeason();
 for(const choices of [[{title:'已有合集',aids:['1']}],[{seasonId:10,aids:['1']}],[{seasonId:10,sectionId:999,aids:['1']}],[{seasonId:10,sectionId:100,aids:['1']},{seasonId:10,sectionId:100,aids:['2']}]])await assert.rejects(()=>preview(f,choices));
 assert.equal(f.posts().length,0);
});
test('renaming a plan after an uncertain creation cannot bypass the no-resend journal',async()=>{
 const f=fixture({createTimeout:true,noCreateApply:true}),p=await preview(f);await f.manager.execute(p.token,{confirmed:true});f.reload();
 const q=await preview(f,[{title:'改过的新名称',aids:['1']}]);const results=await f.manager.execute(q.token,{confirmed:true});assert.equal(f.posts().length,1);assert(results.some(r=>r.state==='unknown'));
});
test('pending imports are reconciled before a new target collection can be created',async()=>{
 for(const timeout of [false,true]){
  const f=fixture({noAddApply:true,addTimeout:timeout}),p=await existing(f);await f.manager.execute(p.token,{confirmed:true});f.reload();
  const q=await preview(f,[{title:'另一合集',aids:['1']}]);await f.manager.execute(q.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.route),['addCollectionEpisodes']);assert.equal(f.store().collectionJobs.imports['1'].seasonId,'10');
 }
});
test('absent manuscript season metadata never bypasses fresh membership elsewhere',async()=>{
 for(const target of ['new','existing']){
  const f=fixture();delete f.remote[1].archive.season_id;const p=target==='new'?await preview(f):await existing(f);
  f.addSeason(30,'其他合集',[300]);f.addMember(300,1);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);assert.equal(f.sections.get('300').episodes.length,1);
 }
});
test('switching account during manuscript preflight blocks create and import',async()=>{
 for(const target of ['new','existing']){
  const f=fixture(),p=target==='new'?await preview(f):await existing(f);
  f.options.onRequest=route=>{if(route==='manuscript')f.setUID(999);};await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
 }
});
test('cancellation during sending journal persistence prevents the associated POST',async()=>{
 for(const target of ['new','existing']){
  const f=fixture(),p=target==='new'?await preview(f):await existing(f);
  f.options.onWrite=ledger=>{const book=ledger.collectionJobs;if(book&&[...Object.values(book.creations),...Object.values(book.imports)].some(j=>j.state==='sending'))f.manager.stop();};
  const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);assert(r.some(j=>j.state==='cancelled'));
  assert(!JSON.stringify(f.store().collectionJobs).includes('"state":"sending"'));
 }
});
test('unrelated new collection proceeds while unknown creation still protects its name and AIDs',async()=>{
 const f=fixture({createTimeout:true,noCreateApply:true}),p=await preview(f,[{title:'未知创建',aids:['1']}]);await f.manager.execute(p.token,{confirmed:true});
 f.options.createTimeout=false;f.options.noCreateApply=false;f.reload();
 const q=await preview(f,[{title:'独立合集',aids:['2']}]);await f.manager.execute(q.token,{confirmed:true});
 assert.deepEqual(f.posts().map(c=>c.route),['createCollection','createCollection','addCollectionEpisodes']);
 assert.equal(f.store().collectionJobs.creations['new:未知创建'].state,'unknown');assert.equal(f.store().collectionJobs.imports['2'].state,'verified');
 for(const choices of [[{title:'改名仍是原视频',aids:['1']}],[{title:' 未知创建 ',aids:['3']}]]){
  const retry=await preview(f,choices);await f.manager.execute(retry.token,{confirmed:true});assert.equal(f.posts().length,3);
 }
});
test('replaying a successful preview does not restore a later-removed member without fresh approval',async()=>{
 for(const outcome of ['verified','unchanged']){
  const f=fixture(),p=await existing(f);if(outcome==='unchanged')f.addMember(100,1);
  const first=await f.manager.execute(p.token,{confirmed:true});assert.equal(first.at(-1).state,outcome);const sent=f.posts().length;
  const section=f.sections.get('100');section.episodes=[];section.section.epCount=0;f.seasons.get('10').sections.sections[0].epCount=0;
  const replayed=await f.manager.execute(p.token,{confirmed:true});assert.equal(replayed.at(-1).state,outcome);assert.equal(f.posts().length,sent);assert.equal(section.episodes.length,0);
  const fresh=await preview(f,[{seasonId:10,sectionId:100,aids:['1']}]);await f.manager.execute(fresh.token,{confirmed:true});assert.equal(f.posts().length,sent+1);assert.equal(section.episodes.length,1);
 }
});
