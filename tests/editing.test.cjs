const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../bilibili-cloud-replay.user.js');
const clone=structuredClone;
function fixture(options={}){
 const data=aid=>({archive:{aid,mid:123,bvid:'BV1234567890',title:'原题【候选】',tag:'已有,保留',desc:'原简介',tid:1,copyright:1,cover:'//i0.hdslb.com/bfs/archive/mock.jpg',extra:{keep:true},desc_v2:null},videos:[{filename:'synthetic-video',cid:456,title:'分P标题',desc:'分P简介'}],subtitle:{open:0,lan:''}});
 const remote={'1':data(1),'2':data(2)},calls=[];let store={version:1,tasks:{}},uid=123;
 const env={now:()=>1,sleep:async()=>{},interval:()=>0,csrf:()=> 'a'.repeat(32),lock:async(_,fn)=>fn(),read:async()=>clone(store),write:async(_,v)=>{store=clone(v);}};
 env.request=async(url,params,method,format)=>{
  const route=Object.keys(C.ROUTES).find(k=>C.ROUTES[k]===url);calls.push({route,params:clone(params),method,format});
  if(route==='nav')return {http:200,json:{code:0,data:{mid:uid,isLogin:true}}};
  if(route==='manuscript'){if(options.readFailure)throw new Error('offline');return {http:200,json:{code:0,data:clone(remote[params.aid||'1'])}};}
  if(route==='editManuscript'){
   if(options.reject)return {http:200,json:{code:-1,message:'拒绝'}};
   if(!options.noApply)Object.assign(remote[params.aid].archive,C.manuscriptFields({archive:params}));
   await options.onPost?.();if(options.timeout)throw new Error('timeout');return {http:200,json:{code:0,data:{}}};
  }throw new Error('Unexpected route '+route);
 };
 const engine=new C.Engine(env),editor=new C.ManuscriptEditor(engine);
 return {editor,env,remote,calls,options,setUID:v=>uid=v,store:()=>store,posts:()=>calls.filter(c=>c.method==='POST')};
}
async function plan(f,operations={'1':{prefix:'新'}},ids=['1']){return f.editor.preview(await f.editor.prepare(ids.map(avid=>({avid}))),operations);}
test('four paired brackets, nested innermost, mismatches, empty, duplicate and Unicode',()=>{
 assert.deepEqual(C.bracketTags('（甲）【乙】(丙)[丁]'),['甲','乙','丙','丁']);
 assert.deepEqual(C.bracketTags('（外【内😀】外）[é](e\u0301)()【 】'),['内😀','é']);
 assert.deepEqual(C.bracketTags('(错] 【好】 [未闭合'),['好']);assert.deepEqual(C.bracketTags('((最内)) [甲][甲]'),['最内','甲']);assert.deepEqual(C.bracketTags('(a[b)c]'),[]);
});
test('suggestions never change tags without an explicit operation',()=>{
 const d=fixture().remote['1'];C.bracketTags(d.archive.title);assert.equal(C.editTarget(d).tag,d.archive.tag);assert.equal(C.editTarget(d,{addTags:['候选','已有','e\u0301','é'],removeTags:['保留']}).tag,'已有,候选,e\u0301');
});
test('bulk transformations are based on original; payload preserves parts and other metadata',()=>{
 const d=fixture().remote['1'],op={find:'原',replace:'修改',prefix:'前',suffix:'后',descMode:'append',desc:'补充'},t=C.editTarget(d,op);
 assert.equal(t.title,'前修改题【候选】后');assert.equal(t.desc,'原简介\n补充');assert.deepEqual(C.editTarget(d,op),t);
 const body=C.editPayload(d,t,'a'.repeat(32));for(const k of ['videos','subtitle'])assert.deepEqual(body[k],d[k]);for(const k of ['cover','tid','extra'])assert.deepEqual(body[k],d.archive[k]);assert.equal(d.archive.title,'原题【候选】');
});
test('owner, ID, missing metadata, unavailable parts and rich descriptions fail closed',()=>{
 const d=fixture().remote['1'];for(const mutate of [x=>x.archive.mid=234,x=>x.archive.aid=3,x=>x.videos=[],x=>delete x.archive.tag,x=>delete x.videos[0].filename]){const bad=clone(d);mutate(bad);assert.throws(()=>C.manuscriptData(bad,{aid:'1'},'123'));}
 assert.throws(()=>C.manuscriptIdentity({sliceId:'123'}));d.archive.desc_v2=[{type:2,raw_text:'提及'}];assert.throws(()=>C.editTarget(d,{descMode:'append',desc:'x'}));assert.equal(C.editTarget(d,{prefix:'X'}).desc,'原简介');
 assert.throws(()=>C.editTarget(d,{title:'\n'}));assert.throws(()=>C.editTarget(d,{title:'x'.repeat(81)}));assert.throws(()=>C.editTarget(d,{addTags:['x,y']}));
});
test('GET-only preview requires confirmation; frozen targets resist caller mutation and replay',async()=>{
 const f=fixture(),p=await plan(f);assert.equal(f.posts().length,0);await assert.rejects(f.editor.execute(p.token),/明确确认/);p.items[0].target.title='tampered';
 assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'verified');assert.equal(f.posts()[0].params.title,'新原题【候选】');assert.equal(f.posts()[0].format.json,true);await f.editor.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);
});
test('concurrent title, untouched cover, parts or nested settings conflict before POST',async()=>{
 for(const mutate of [d=>d.archive.title='changed',d=>d.archive.cover='changed',d=>d.videos[0].title='changed',d=>d.archive.extra.keep=false]){const f=fixture(),p=await plan(f);mutate(f.remote['1']);assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'conflict');assert.equal(f.posts().length,0);}
});
test('timeout with applied data verifies by readback without repeating append',async()=>{
 const f=fixture({timeout:true}),p=await plan(f,{'1':{descMode:'append',desc:'一次'}});assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'verified');await f.editor.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.remote['1'].archive.desc,'原简介\n一次');
});
test('unknown outcome persists across a new preview and blocks different targets',async()=>{
 const f=fixture({timeout:true,noApply:true}),p=await plan(f);assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'unknown');const next=await plan(f,{'1':{suffix:'different'}});await f.editor.execute(next.token,{confirmed:true});assert.equal(f.posts().length,1);assert.equal(f.store().editJobs['1'].target.title,'新原题【候选】');
});
test('accepted asynchronous edit is only reconciled, never blindly resubmitted',async()=>{
 const f=fixture({noApply:true}),p=await plan(f);assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'accepted');await f.editor.execute(p.token,{confirmed:true});assert.equal(f.posts().length,1);f.remote['1'].archive.title='新原题【候选】';assert.equal((await f.editor.execute(p.token,{checkOnly:true}))[0].state,'verified');assert.equal(f.posts().length,1);
});
test('explicit rejection retries exact fixed values, avoiding double append',async()=>{
 const f=fixture({reject:true}),p=await plan(f,{'1':{descMode:'append',desc:'一次'}});assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'rejected');f.options.reject=false;await f.editor.execute(p.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(f.posts()[0].params.desc,f.posts()[1].params.desc);
});
test('serial cancellation after first request leaves subsequent items unsent',async()=>{
 const f=fixture();f.options.onPost=()=>f.editor.stop();const p=await plan(f,{'1':{prefix:'新'},'2':{prefix:'新'}},['1','2']);assert.deepEqual((await f.editor.execute(p.token,{confirmed:true})).map(x=>x.state),['verified','cancelled']);assert.equal(f.posts().length,1);
});
test('preflight cancellation, changed account and journal failure cannot POST',async()=>{
 const f=fixture(),p=await plan(f);f.env.sleep=async()=>f.editor.stop();assert.equal((await f.editor.execute(p.token,{confirmed:true}))[0].state,'cancelled');assert.equal(f.posts().length,0);f.env.sleep=async()=>{};f.setUID(234);await assert.rejects(f.editor.execute(p.token,{confirmed:true}),/账号已改变/);f.setUID(123);f.env.write=async()=>{throw new Error('disk failure');};await f.editor.execute(p.token,{confirmed:true});assert.equal(f.posts().length,0);
});
test('duplicate selection resolves once by aid and no-op previews do not POST',async()=>{
 const f=fixture(),s=await f.editor.prepare([{avid:'1'},{bvid:'BV1234567890'}]);assert.equal(s.items.length,1);assert.equal((await f.editor.execute(f.editor.preview(s,{}).token,{confirmed:true}))[0].state,'unchanged');assert.equal(f.posts().length,0);
});
test('transport JSON keeps video array and sends CSRF query with session credentials',async()=>{
 let req;const transport=C.createRequestTransport({mode:()=> 'page-fetch',controller:()=>new AbortController(),fetch:async(url,options)=>{req={url,options};return {status:200,url,text:async()=>'{"code":0,"data":{}}'};}});await transport(C.ROUTES.editManuscript,{aid:'1',videos:[{filename:'mock'}],csrf:'a'.repeat(32)},'POST',{json:true});assert.equal(new URL(req.url).searchParams.get('csrf'),'a'.repeat(32));assert.equal(req.options.credentials,'include');const body=JSON.parse(req.options.body);assert.equal(body.csrf,undefined);assert.deepEqual(body.videos,[{filename:'mock'}]);
});
test('preview tokens remain unique across editor instances and old success cannot skip a new change',async()=>{
 const f=fixture(),p=await plan(f);await f.editor.execute(p.token,{confirmed:true});f.editor=new C.ManuscriptEditor(new C.Engine(f.env));const second=await plan(f,{'1':{prefix:'再'}});assert.notEqual(second.token,p.token);await f.editor.execute(second.token,{confirmed:true});assert.equal(f.posts().length,2);assert.equal(f.remote['1'].archive.title,'再新原题【候选】');
});
test('persisted sending state is reconciled after reload and never resent',async()=>{
 const f=fixture({noApply:true}),p=await plan(f);await f.editor.execute(p.token,{confirmed:true});f.store().editJobs['1'].state='sending';f.editor=new C.ManuscriptEditor(new C.Engine(f.env));const next=await plan(f);assert.equal((await f.editor.execute(next.token,{confirmed:true}))[0].state,'unknown');assert.equal(f.posts().length,1);
});
