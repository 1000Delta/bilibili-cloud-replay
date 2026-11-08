// Synthetic creator fixtures only. Never calls Bilibili or uses account records.
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../bilibili-cloud-replay.user.js'),clone=structuredClone;
function fixture(options={}){
 let uid=123,store={version:1,tasks:{}},writes=0;
 const calls=[],seasons=new Map(),sections=new Map();
 const remote=Object.fromEntries([1,2,3].map(aid=>[aid,{archive:{aid,mid:123,title:'原神 '+aid,tag:'游戏',desc:'合成简介',tid:1,copyright:1,cover:'//i0.hdslb.com/bfs/archive/synthetic.jpg',state:0,interactive:0,season_id:0},videos:[{cid:aid+100,filename:'synthetic-'+aid,title:'分P标题',desc:''}]}]));
 const publications=[1,2,3].map(aid=>({slice_id:aid+1000,avid:aid,av_title:remote[aid].archive.title,av_cover:remote[aid].archive.cover,av_status:2}));
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
  else if(route==='collectionVideoParts'){const d=remote[String(p.aid)];data={archive:{aid:d.archive.aid,title:d.archive.title},videos:d.videos.map(v=>({cid:v.cid,index:1,title:v.title}))};}
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
// Historical strict-check scenarios explicitly opt in; the UI/API default is tested below.
async function preview(f,choices=[{title:'新合集',description:'合成简介',aids:['1']}],options={checkVideos:true}){return f.manager.preview(await f.manager.prepare(),choices,options);}
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
test('invalid owners, review states, multipart, interaction and unsafe CIDs block confirmation before any write',async()=>{
 for(const mutate of [d=>d.archive.mid=999,d=>d.archive.state=-1,d=>d.videos.push(clone(d.videos[0])),d=>d.archive.interactive=1,d=>d.archive.season_id=10,d=>d.videos[0].cid='9007199254740992']){
  for(const target of ['new','existing']){const f=fixture();mutate(f.remote[1]);const p=target==='new'?await preview(f):await existing(f);const results=await f.manager.execute(p.token,{confirmed:true});assert(results.some(r=>r.state==='failed'));assert.equal(f.posts().length,0);}
 }
});
test('account changes after preview or during throttle cannot write',async()=>{
 const f=fixture(),p=await existing(f);f.setUID(999);await assert.rejects(()=>f.manager.execute(p.token,{confirmed:true}),/账号/);assert.equal(f.posts().length,0);
 const g=fixture(),q=await existing(g);g.options.onSleep=()=>g.setUID(999);await g.manager.execute(q.token,{confirmed:true});assert.equal(g.posts().length,0);
});
test('remote title, state, multipart or membership changes block the local plan at confirmation',async()=>{
 for(const change of [d=>d.archive.title='变化',d=>d.archive.state=-1,d=>d.videos.push(clone(d.videos[0])),d=>d.archive.season_id=99]){
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
test('34-video local previews and repeated clicks issue zero requests, sleeps or writes',async()=>{
 const f=fixture();f.publications.splice(0,f.publications.length,...Array.from({length:34},(_,i)=>({slice_id:i+1000,avid:i+1,av_title:'影之刃零 '+(i+1),av_status:2})));
 const session=await f.manager.prepare();assert.equal(f.calls.filter(c=>c.route==='manuscript').length,0);
 const before=f.calls.length;f.options.onRequest=()=>{throw new Error('Preview must not access the network');};f.options.onSleep=()=>{throw new Error('Preview must not schedule network work');};
 const choices=[{title:'影之刃零',description:'本地方案',aids:session.videos.map(v=>v.aid)}];
 const previews=await Promise.all(Array.from({length:5},()=>f.manager.preview(session,choices)));
 for(const p of previews){assert.equal(p.items[0].videos.length,34);assert.deepEqual(p.items[0].videos[0],{aid:'1',title:'影之刃零 1',cover:''});}
 assert.equal(new Set(previews.map(p=>p.token)).size,5);assert.equal(f.calls.length,before);assert.equal(f.posts().length,0);assert.equal(f.writes(),0);
});
test('editing local selections and descriptions does not require another account or manuscript read',async()=>{
 const f=fixture(),session=await f.manager.prepare(),before=f.calls.length;
 const first=await f.manager.preview(session,[{title:'第一方案',description:'原简介',aids:['1','2']}]);
 const second=await f.manager.preview(session,[{title:'第二方案',description:'改后简介',aids:['2']}]);
 assert.equal(first.items[0].videos.length,2);assert.equal(second.items[0].videos.length,1);assert.equal(second.items[0].description,'改后简介');assert.equal(f.calls.length,before);
 for(const title of ['','坏\n名称'])await assert.rejects(()=>f.manager.preview(session,[{title,aids:['1']}]),/名称/);
 assert.equal(f.calls.length,before);
});
test('an account switch still allows local preview but prevents confirmation writes',async()=>{
 const f=fixture(),session=await f.manager.prepare(),before=f.calls.length;f.setUID(999);
 const p=await f.manager.preview(session,[{title:'本地合集',aids:['1']}]);assert.equal(f.calls.length,before);
 await assert.rejects(()=>f.manager.execute(p.token,{confirmed:true}),/账号/);assert.equal(f.posts().length,0);
});
test('confirmation resolves current CID and cover absent from the publication list',async()=>{
 for(const target of ['new','existing']){
  const f=fixture(),p=target==='new'?await preview(f):await existing(f);f.remote[1].videos[0].cid=789;f.remote[1].archive.cover='https://i0.hdslb.com/bfs/archive/current.jpg';
  await f.manager.execute(p.token,{confirmed:true});const add=f.posts().find(c=>c.route==='addCollectionEpisodes');assert.equal(add.p.episodes[0].cid,789);
  if(target==='new')assert.equal(f.posts()[0].p.cover,f.remote[1].archive.cover);
 }
});
test('validated CID and cover stay frozen between creation and import or a rejected import retry',async()=>{
 for(const field of ['cid','cover'])for(const target of ['new','existing']){
  const f=fixture(target==='existing'?{rejectAdd:true}:{}),p=target==='new'?await preview(f):await existing(f);
  const change=()=>{if(field==='cid')f.remote[1].videos[0].cid=999;else f.remote[1].archive.cover='https://i0.hdslb.com/bfs/archive/changed.jpg';};
  if(target==='new')f.options.onRequest=route=>{if(route==='createCollection')change();};
  await f.manager.execute(p.token,{confirmed:true});
  if(target==='existing'){change();f.options.rejectAdd=false;await f.manager.execute(p.token,{confirmed:true});}
  assert.equal(f.posts().length,1);assert.equal(f.posts()[0].route,target==='new'?'createCollection':'addCollectionEpisodes');
 }
});
test('manuscript validation is serial and respects the one-second floor and larger configured intervals',async()=>{
 for(const interval of [0,2500]){
  let now=0;const reads=[];const f=fixture({onSleep:ms=>{now+=ms;},onRequest:route=>{if(route==='manuscript')reads.push(now);}});f.env.interval=()=>interval;
  const p=await preview(f,[{title:'批量合集',aids:['1','2','3']}]);assert.equal(reads.length,0);await f.manager.execute(p.token,{confirmed:true});
  assert.equal(reads.length,6);for(let i=1;i<reads.length;i++)assert(reads[i]-reads[i-1]>=Math.max(1000,interval));assert.equal(f.posts().length,4);
 }
});
test('rate limit -702 stops the remaining confirmed batch without retrying the refused read',async()=>{
 for(const target of ['new','existing']){
  const f=fixture();if(target==='existing')f.addSeason();
  const p=await preview(f,target==='new'?[{title:'第一合集',aids:['1']},{title:'第二合集',aids:['2']}]:[{seasonId:10,sectionId:100,aids:['1','2']}]);
  f.options.onRequest=route=>route==='manuscript'?{http:200,json:{code:-702,message:'请求频率过高，请稍后再试'}}:undefined;
  const results=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.calls.filter(c=>c.route==='manuscript').length,1);assert.equal(f.posts().length,0);assert(results.some(r=>r.state==='cancelled'));assert(results.some(r=>r.message?.includes('已停止后续请求')));
 }
});
test('cancel during the first paced manuscript read prevents that read and every write',async()=>{
 const f=fixture(),p=await preview(f,[{title:'批量合集',aids:['1','2','3']}]);let sleeps=0;f.options.onSleep=()=>{if(++sleeps===2)f.manager.stop();};
 await f.manager.execute(p.token,{confirmed:true});assert.equal(f.calls.filter(c=>c.route==='manuscript').length,0);assert.equal(f.posts().length,0);
});
test('new collection membership is checked after the paced video batch',async()=>{
 const f=fixture(),p=await preview(f,[{title:'批量合集',aids:['1','2']}]);
 f.options.onRequest=(route,params)=>{if(route==='manuscript'&&params.aid==='2'){f.addSeason(30,'并发合集',[300]);f.addMember(300,1);}};
 const result=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);assert(result.some(r=>r.message?.includes('稿件已加入合集')));
 const checks=f.calls.map(c=>c.route);assert(checks.lastIndexOf('collectionSection')>checks.lastIndexOf('manuscript'));
});

async function directPlan(f,target='new',aids=['1'],options){
 if(target==='existing'&&!f.seasons.has('10'))f.addSeason();
 return f.manager.preview(await f.manager.prepare(),target==='new'?[{title:'直接合集',description:'直接创建测试',aids}]:[{seasonId:10,sectionId:100,aids}],options);
}
test('default mode skips every view, creates from list cover before CID reads and tolerates stale list titles',async()=>{
 const f=fixture(),p=await directPlan(f,'new',['1','2']);assert.equal(p.checkVideos,false);assert.equal(p.items[0].videos[0].cover,f.publications[0].av_cover);
 f.remote[1].archive.title='创作中心更新后的标题';f.remote[1].archive.state=-1;f.remote[1].archive.interactive=1;
 f.options.onRequest=route=>{if(route==='manuscript')throw new Error('view is disabled');};
 const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(r.at(-1).state,'verified');
 assert.equal(f.calls.filter(c=>c.route==='manuscript').length,0);assert.equal(f.calls.filter(c=>c.route==='collectionVideoParts').length,2);
 assert(f.calls.findIndex(c=>c.route==='createCollection')<f.calls.findIndex(c=>c.route==='collectionVideoParts'));
 assert.equal(f.posts()[0].p.cover,'https://i0.hdslb.com/bfs/archive/synthetic.jpg');assert.equal(f.posts()[1].p.episodes[0].title,'原神 1');
 assert.equal(f.remote[1].archive.title,'创作中心更新后的标题');assert.equal(f.store().collectionJobs.imports['1'].cid,'101');
});
test('optional mode is frozen in the plan and keeps strict title checks with an actionable error',async()=>{
 for(const checked of [false,true]){
  const f=fixture(),options={checkVideos:checked},p=await directPlan(f,'existing',['1'],options);options.checkVideos=!checked;p.checkVideos=!checked;
  f.remote[1].archive.title='修改后的标题';const r=await f.manager.execute(p.token,{confirmed:true});
  assert.equal(f.posts().length,checked?0:1);assert.equal(f.calls.filter(c=>c.route==='manuscript').length,checked?1:0);
  if(checked)assert(r.some(j=>j.message?.includes('av1：view 当前标题与回放投稿列表标题不同')));
 }
});
test('missing or invalid list cover stops default creation without secretly enabling view',async()=>{
 for(const cover of [undefined,'','https://example.com/cover.jpg','not a URL']){
  const f=fixture();f.publications[0].av_cover=cover;const p=await directPlan(f);const r=await f.manager.execute(p.token,{confirmed:true});
  assert.equal(f.posts().length,0);assert.equal(f.calls.filter(c=>['manuscript','collectionVideoParts'].includes(c.route)).length,0);assert(r.some(j=>j.message?.includes('首条稿件未提供有效B站封面')));
 }
 const f=fixture();delete f.publications[0].av_cover;const p=await directPlan(f,'existing');await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);
});
test('enabling checks can resolve a missing list cover without changing default behavior',async()=>{
 const f=fixture();delete f.publications[0].av_cover;const p=await directPlan(f,'new',['1'],{checkVideos:true});await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(f.calls.filter(c=>c.route==='collectionVideoParts').length,0);
});
test('default CID resolution rejects mismatched identity, missing or unsafe CID and multipart',async()=>{
 for(const change of [d=>d.archive.aid=99,d=>d.videos=[],d=>d.videos.push(clone(d.videos[0])),d=>delete d.videos[0].cid,d=>d.videos[0].cid='9007199254740992',d=>d.videos[0].cid=0]){
  const f=fixture(),p=await directPlan(f,'existing');change(f.remote[1]);const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);assert.equal(r.at(-1).state,'failed');assert.equal(f.calls.filter(c=>c.route==='manuscript').length,0);
 }
});
test('default creation survives a later CID failure and resumes without recreating',async()=>{
 const f=fixture(),p=await directPlan(f);f.options.onRequest=route=>route==='collectionVideoParts'?{http:200,json:{code:-400,message:'暂时没有CID'}}:undefined;
 const first=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(first.at(-1).state,'failed');assert.equal(f.store().collectionJobs.creations['new:直接合集'].seasonId,'20');
 f.options.onRequest=undefined;await f.manager.execute(p.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.route),['createCollection','addCollectionEpisodes']);
});
test('both modes keep account changes, complete membership and unknown-write protections',async()=>{
 for(const checkVideos of [false,true]){
  const f=fixture(),p=await directPlan(f,'existing',['1'],{checkVideos});f.addMember(100,1);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
  const g=fixture(),q=await directPlan(g,'existing',['1'],{checkVideos});g.addSeason(30,'其他合集',[300]);g.addMember(300,1);await g.manager.execute(q.token,{confirmed:true});assert.equal(g.posts().length,0);
  const h=fixture(),r=await directPlan(h,'existing',['1'],{checkVideos});h.options.onRequest=route=>{if(route===(checkVideos?'manuscript':'collectionVideoParts'))h.setUID(999);};await h.manager.execute(r.token,{confirmed:true});assert.equal(h.posts().length,0);
 }
});
test('default unknown import and mode changes never resend or retarget',async()=>{
 const f=fixture({noAddApply:true,addTimeout:true}),p=await directPlan(f,'existing');await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.store().collectionJobs.imports['1'].state,'unknown');
 f.reload();const q=await directPlan(f,'new',['1'],{checkVideos:true});await f.manager.execute(q.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.store().collectionJobs.imports['1'].seasonId,'10');
 f.addMember(100,1);await f.manager.checkPending();assert.equal(f.store().collectionJobs.imports['1'].state,'verified');
});
test('unknown default creation cannot be retried after switching checks and renaming',async()=>{
 const f=fixture({createTimeout:true,noCreateApply:true}),p=await directPlan(f);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);f.reload();
 const q=await preview(f,[{title:'改名合集',aids:['1']}],{checkVideos:true});await f.manager.execute(q.token,{confirmed:true});assert.equal(f.posts().length,1);
});
test('default rejected import refreshes CID and refuses changed parts instead of guessing',async()=>{
 const f=fixture({rejectAdd:true}),p=await directPlan(f,'existing');await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);
 f.options.rejectAdd=false;f.remote[1].videos[0].cid=999;const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert(r.some(j=>j.message?.includes('视频CID已变化')));
});
test('default CID reads respect throttling and -702 stops later imports without retry',async()=>{
 let now=0;const reads=[];const f=fixture({onSleep:ms=>now+=ms,onRequest:route=>{if(route==='collectionVideoParts')reads.push(now);}});f.env.interval=()=>2500;
 const p=await directPlan(f,'existing',['1','2','3']);await f.manager.execute(p.token,{confirmed:true});assert.equal(reads.length,3);for(let i=1;i<reads.length;i++)assert(reads[i]-reads[i-1]>=2500);
 const g=fixture(),q=await directPlan(g,'existing',['1','2']);g.options.onRequest=route=>route==='collectionVideoParts'?{http:200,json:{code:-702,message:'请求频繁'}}:undefined;
 const r=await g.manager.execute(q.token,{confirmed:true});assert.equal(g.calls.filter(c=>c.route==='collectionVideoParts').length,1);assert.equal(g.posts().length,0);assert(r.some(j=>j.state==='cancelled'));
});
test('default cancellation, persistence failure and replay preserve no-double-write behavior',async()=>{
 for(const failure of ['stop','journal']){const f=fixture(),p=await directPlan(f,'existing');if(failure==='stop')f.options.onSleep=()=>f.manager.stop();else f.options.failWrite=true;await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);}
 const f=fixture(),p=await directPlan(f);await f.manager.execute(p.token,{confirmed:true});await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);
});

function countRoutes(calls){return Object.fromEntries([...new Set(calls.map(c=>c.route))].map(route=>[route,calls.filter(c=>c.route===route).length]));}
function addSyntheticVideos(f,total){
 for(let aid=4;aid<=total;aid++){f.remote[aid]=clone(f.remote[1]);Object.assign(f.remote[aid].archive,{aid,title:'原神 '+aid});f.remote[aid].videos[0].cid=aid+100;f.publications.push({slice_id:1000+aid,avid:aid,av_title:'原神 '+aid,av_cover:f.remote[aid].archive.cover,av_status:2});}
}
test('34 adds with seven sections read members once before and once after the complete batch',async()=>{
 const f=fixture();addSyntheticVideos(f,34);f.addSeason(10,'已有合集',[100,101]);for(let id=11;id<=15;id++)f.addSeason(id,'其他合集 '+id,[id*100]);
 const p=await directPlan(f,'existing',f.publications.map(v=>String(v.avid))),before=f.calls.length;
 const result=await f.manager.execute(p.token,{confirmed:true}),calls=f.calls.slice(before),counts=countRoutes(calls),adds=calls.map((c,i)=>c.route==='addCollectionEpisodes'?i:-1).filter(i=>i>=0);
 assert.equal(counts.collections,1);assert.equal(counts.collectionSection,9);assert.equal(counts.collectionDetail,1);assert.equal(counts.collectionVideoParts,34);assert.equal(counts.addCollectionEpisodes,34);assert.equal(counts.manuscript,undefined);assert.equal(counts.nav,70);assert.equal(calls.length,149);
 assert.equal(calls.slice(0,adds[0]).filter(c=>c.route==='collectionSection').length,7);
 assert.equal(calls.slice(adds[0]+1,adds.at(-1)).filter(c=>['collections','collectionDetail','collectionSection'].includes(c.route)).length,0);
 assert.deepEqual(calls.slice(adds.at(-1)+1).filter(c=>c.route==='collectionSection').map(c=>c.p.id),['100','101']);
 assert.equal(result.filter(j=>j.state==='accepted').length,34);assert.equal(result.filter(j=>j.state==='verified').length,34);assert.equal(Object.values(f.store().collectionJobs.imports).filter(j=>j.state==='verified').length,34);
});
test('successful new collection keeps its ID and cached members until a single final verification',async()=>{
 const f=fixture(),p=await directPlan(f,'new',['1','2','3']),before=f.calls.length;await f.manager.execute(p.token,{confirmed:true});const calls=f.calls.slice(before),counts=countRoutes(calls);
 assert.equal(counts.collections,1);assert.equal(counts.collectionSection,1);assert.equal(counts.collectionDetail,2);assert.equal(counts.createCollection,1);assert.equal(counts.addCollectionEpisodes,3);
 const first=calls.findIndex(c=>c.route==='addCollectionEpisodes'),last=calls.findLastIndex(c=>c.route==='addCollectionEpisodes');assert(!calls.slice(first+1,last).some(c=>['collections','collectionDetail','collectionSection'].includes(c.route)));
 assert(calls.findIndex(c=>c.route==='collectionSection')>last);assert.equal(f.store().collectionJobs.creations['new:直接合集'].state,'verified');
});
test('multiple target groups share initial membership and verify each complete target only at the end',async()=>{
 const f=fixture();f.addSeason(10,'第一合集',[100,101]);f.addSeason(20,'第二合集',[200,201]);f.addSeason(30,'未改合集',[300]);
 const p=await f.manager.preview(await f.manager.prepare(),[{seasonId:10,sectionId:101,aids:['1','2']},{seasonId:20,sectionId:201,aids:['3']}]),before=f.calls.length;
 await f.manager.execute(p.token,{confirmed:true});const calls=f.calls.slice(before),last=calls.findLastIndex(c=>c.route==='addCollectionEpisodes');
 assert.equal(countRoutes(calls).collections,1);assert.equal(countRoutes(calls).collectionSection,9);assert.deepEqual(calls.slice(last+1).filter(c=>c.route==='collectionDetail').map(c=>c.p.id),['10','20']);assert(!calls.slice(last+1).some(c=>c.route==='collectionSection'&&c.p.id==='300'));
 assert.deepEqual(f.posts().map(c=>c.p.sectionId),[101,101,201]);
});
test('initial multi-page membership snapshot stays complete without repeated pagination per add',async()=>{
 const f=fixture();for(let id=1;id<=31;id++)f.addSeason(id,'合集 '+id,[id*100]);const p=await f.manager.preview(await f.manager.prepare(),[{seasonId:10,sectionId:1000,aids:['1','2','3']}]),before=f.calls.length;
 await f.manager.execute(p.token,{confirmed:true});const calls=f.calls.slice(before);assert.deepEqual(calls.filter(c=>c.route==='collections').map(c=>c.p.pn),[1,2]);assert.equal(countRoutes(calls).collectionSection,32);
});
test('a fresh execution never reuses a prior batch snapshot after rejection or preflight failure',async()=>{
 const f=fixture({rejectAdd:true}),p=await directPlan(f,'existing',['1','2']);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);
 f.options.rejectAdd=false;f.addSeason(30,'并发合集',[300]);f.addMember(300,1);const before=f.calls.length,result=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert(result.some(j=>j.message?.includes('不会移动成员')));assert.equal(countRoutes(f.calls.slice(before)).collectionSection,2);
});
test('timeout after the second add stops later writes, then verifies both attempted videos once',async()=>{
 for(const applied of [false,true]){
  const f=fixture(),p=await directPlan(f,'existing',['1','2','3']);f.options.onRequest=(route,p)=>{if(route==='addCollectionEpisodes'&&p.episodes[0].aid===2){f.options.addTimeout=true;f.options.noAddApply=!applied;}};
  const before=f.calls.length,result=await f.manager.execute(p.token,{confirmed:true}),calls=f.calls.slice(before);assert.equal(f.posts().length,2);assert.equal(f.store().collectionJobs.imports['1'].state,'verified');assert.equal(f.store().collectionJobs.imports['2'].state,applied?'verified':'unknown');assert(result.some(j=>j.aid==='3'&&j.state==='cancelled'));
  const first=calls.findIndex(c=>c.route==='addCollectionEpisodes'),last=calls.findLastIndex(c=>c.route==='addCollectionEpisodes');assert(!calls.slice(first+1,last).some(c=>['collections','collectionDetail','collectionSection'].includes(c.route)));assert.equal(countRoutes(calls).collectionSection,2);assert.equal(countRoutes(calls).collectionDetail,1);
  f.options.addTimeout=false;f.options.noAddApply=false;f.options.onRequest=undefined;await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().filter(c=>c.p.episodes[0].aid===2).length,1);assert.equal(f.posts().filter(c=>c.p.episodes[0].aid===3).length,1);
 }
});
test('explicit add rejection stops the remainder and still verifies previously accepted writes',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2','3']);f.options.onRequest=(route,p)=>{if(route==='addCollectionEpisodes'&&p.episodes[0].aid===2)f.options.rejectAdd=true;};
 const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(f.store().collectionJobs.imports['1'].state,'verified');assert.equal(f.store().collectionJobs.imports['2'].state,'rejected');assert(r.some(j=>j.aid==='3'&&j.state==='cancelled'));
 f.options.onRequest=undefined;f.options.rejectAdd=false;await f.manager.execute(p.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.p.episodes[0].aid),[1,2,2,3]);
});
test('final verification failure is shared across the target and later pending checks cannot resend',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2','3']);f.options.onRequest=route=>route==='collectionDetail'?{http:200,json:{code:-400,message:'核对暂不可用'}}:undefined;
 const before=f.calls.length,r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,3);assert.equal(countRoutes(f.calls.slice(before)).collectionDetail,1);assert(Object.values(f.store().collectionJobs.imports).every(j=>j.state==='accepted'));assert(r.filter(j=>j.message?.includes('回读未完成')).length===3);
 f.reload();f.options.onRequest=undefined;const next=f.calls.length,checked=await f.manager.checkPending();assert.equal(checked.length,3);assert(checked.every(j=>j.state==='verified'));assert.equal(f.posts().length,3);assert.equal(countRoutes(f.calls.slice(next)).collectionDetail,1);assert.equal(countRoutes(f.calls.slice(next)).collectionSection,1);
});
test('accepted but not yet visible members remain pending after final verification and are never resent',async()=>{
 const f=fixture({noAddApply:true}),p=await directPlan(f,'existing',['1','2','3']);await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,3);assert(Object.values(f.store().collectionJobs.imports).every(j=>j.state==='accepted'));
 const before=f.calls.length;await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,3);assert.equal(countRoutes(f.calls.slice(before)).collections,undefined);assert.equal(countRoutes(f.calls.slice(before)).collectionSection,1);
});
test('stopping after one accepted add still performs one final verification without another write',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2','3']),before=f.calls.length;f.options.onAdd=()=>f.manager.stop();const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.store().collectionJobs.imports['1'].state,'verified');assert.equal(r.filter(j=>j.state==='cancelled').length,2);assert.equal(countRoutes(f.calls.slice(before)).collectionSection,2);
});
test('journal failure after a sent add stops the batch and leaves a recoverable sending record',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2','3']);f.options.onAdd=()=>f.options.failWrite=true;const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.store().collectionJobs.imports['1'].state,'sending');assert(r.some(j=>j.message?.includes('核对结果未保存')));
 f.options.failWrite=false;f.options.onAdd=undefined;await f.manager.execute(p.token,{confirmed:true});assert.deepEqual(f.posts().map(c=>c.p.episodes[0].aid),[1,2,3]);assert.equal(f.store().collectionJobs.imports['1'].state,'verified');
});
test('switching accounts after an accepted add blocks remaining writes and final membership reads',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2']),before=f.calls.length;f.options.onAdd=()=>f.setUID(999);const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(countRoutes(f.calls.slice(before)).collectionDetail,undefined);assert.equal(f.store().collectionJobs.imports['1'].state,'accepted');assert(r.some(j=>j.message?.includes('请切回原账号')));
 f.setUID(123);f.options.onAdd=undefined;await f.manager.checkPending();assert.equal(f.store().collectionJobs.imports['1'].state,'verified');
});
test('final multi-section verification detects a moved member and changed CID without retargeting',async()=>{
 for(const kind of ['section','cid']){
  const f=fixture();f.addSeason(10,'已有合集',[100,101]);const p=await directPlan(f,'existing',['1','2']);f.options.onAdd=p=>{if(p.episodes[0].aid!==2)return;if(kind==='cid')f.sections.get('100').episodes[0].cid=999;else{const section=f.sections.get('100');section.episodes.shift();section.section.epCount--;f.seasons.get('10').sections.sections[0].epCount--;f.addMember(101,1);}};
  await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(f.store().collectionJobs.imports['1'].state,'conflict');assert.equal(f.store().collectionJobs.imports['2'].state,'verified');
 }
});
test('concurrent executions on one manager are refused before requests and do not duplicate adds',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2']);let release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);let once=true;f.options.onSleep=async()=>{if(once){once=false;entered();await gate;}};
 const run=f.manager.execute(p.token,{confirmed:true});await waiting;const before=f.calls.length;await assert.rejects(()=>f.manager.execute(p.token,{confirmed:true}),/队列已经在运行/);assert.equal(f.calls.length,before);release();await run;assert.equal(f.posts().length,2);
});
test('cross-manager lock contention prevents a second batch from using a competing snapshot',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2']),other=new C.CollectionManager(new C.Engine(f.env));const q=await other.preview(await other.prepare(),[{seasonId:10,sectionId:100,aids:['1','2']}]);let locked=false,release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);let once=true;
 f.env.lock=async(_,fn)=>{assert(!locked,'another tab is working');locked=true;try{return await fn();}finally{locked=false;}};f.options.onSleep=async()=>{if(once){once=false;entered();await gate;}};
 const run=f.manager.execute(p.token,{confirmed:true});await waiting;const before=f.calls.length;await assert.rejects(()=>other.execute(q.token,{confirmed:true}),/another tab/);assert.equal(f.calls.length,before);release();await run;assert.equal(f.posts().length,2);
 await other.execute(q.token,{confirmed:true});assert.equal(f.posts().length,2);
});
test('local snapshot is updated after successful adds so later groups cannot assign those members again',async()=>{
 const f=fixture();f.addSeason(10,'第一合集',[100]);f.addSeason(20,'第二合集',[200]);const snapshot=await f.manager.membershipSnapshot('123');assert.equal(snapshot.members.size,0);
 const p=await f.manager.preview(await f.manager.prepare(),[{seasonId:10,sectionId:100,aids:['1']},{seasonId:20,sectionId:200,aids:['2']}]);
 const original=f.manager.membershipSnapshot.bind(f.manager);let loaded;f.manager.membershipSnapshot=async uid=>{loaded=await original(uid);return loaded;};await f.manager.execute(p.token,{confirmed:true});assert.equal(loaded.members.get('1').seasonId,'10');assert.equal(loaded.members.get('2').seasonId,'20');assert.equal(loaded.collections.find(c=>c.id==='10').sections[0].count,1);
});
test('multiple new collections seed empty sections without member reads between add groups',async()=>{
 const f=fixture();f.addSeason(10,'原有合集',[100]);let next=20;f.options.onRequest=(route,p)=>{if(route!=='createCollection')return;const id=next;next+=10;f.addSeason(id,p.title,[id*10]);return {http:200,json:{code:0,data:id}};};
 const p=await f.manager.preview(await f.manager.prepare(),[{title:'第一新合集',aids:['1','2']},{title:'第二新合集',aids:['3']}]),before=f.calls.length;
 await f.manager.execute(p.token,{confirmed:true});const calls=f.calls.slice(before),first=calls.findIndex(c=>c.route==='addCollectionEpisodes'),last=calls.findLastIndex(c=>c.route==='addCollectionEpisodes');
 assert.equal(countRoutes(calls).collections,1);assert.equal(countRoutes(calls).collectionSection,3);assert(!calls.slice(first+1,last).some(c=>['collections','collectionSection'].includes(c.route)));
 assert.deepEqual(calls.slice(last+1).filter(c=>c.route==='collectionDetail').map(c=>c.p.id),['20','30']);assert.deepEqual(f.posts().filter(c=>c.route==='addCollectionEpisodes').map(c=>c.p.sectionId),[200,200,300]);
});
test('final account read failure preserves every accepted job and reports recovery instead of resending',async()=>{
 const f=fixture(),p=await directPlan(f,'existing',['1','2']);f.options.onAdd=p=>{if(p.episodes[0].aid===2)f.options.onRequest=route=>route==='nav'?{http:200,json:{code:-400,message:'账号核对暂不可用'}}:undefined;};
 const r=await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(r.filter(j=>j.message?.includes('账号核对暂不可用')).length,2);assert(Object.values(f.store().collectionJobs.imports).every(j=>j.state==='accepted'));
 f.options.onRequest=undefined;await f.manager.checkPending();assert(Object.values(f.store().collectionJobs.imports).every(j=>j.state==='verified'));assert.equal(f.posts().length,2);
});
test('incomplete final section data never marks any video verified and is read just once per pass',async()=>{
 const f=fixture();f.addSeason(10,'已有合集',[100,101]);const p=await directPlan(f,'existing',['1','2']);f.options.onAdd=p=>{if(p.episodes[0].aid!==2)return;f.options.onRequest=(route,p)=>{if(route==='collectionSection'&&p.id==='101')return {http:200,json:{code:0,data:{section:{id:101,seasonId:10,epCount:1},episodes:[]}}};};};
 const before=f.calls.length;await f.manager.execute(p.token,{confirmed:true});assert(Object.values(f.store().collectionJobs.imports).every(j=>j.state==='accepted'));assert.equal(countRoutes(f.calls.slice(before)).collectionSection,4);assert.equal(f.posts().length,2);
 f.options.onRequest=undefined;await f.manager.checkPending();assert(Object.values(f.store().collectionJobs.imports).every(j=>j.state==='verified'));
});
test('preflight partial reads abort before all writes and cannot seed a later execution cache',async()=>{
 const f=fixture();f.addSeason(10,'已有合集',[100,101]);const p=await directPlan(f,'existing',['1','2']);f.options.onRequest=(route,p)=>route==='collectionSection'&&p.id==='101'?{http:200,json:{code:-400,message:'章节读取失败'}}:undefined;
 await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);f.options.onRequest=undefined;const before=f.calls.length;await f.manager.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(countRoutes(f.calls.slice(before)).collectionSection,4);
});
