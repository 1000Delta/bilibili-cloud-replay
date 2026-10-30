// ==UserScript==
// @name         B站云端回放分段助手（默认只读）
// @namespace    local.bilibili.cloud-replay
// @version      0.8.0
// @license      MIT
// @description  缓存并后台发现已结束回放，卡片内多选投稿；同日同主题跨场次连续编号，预览随机帧封面后按钮确认提交。
// @match        https://link.bilibili.com/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.live.bilibili.com
// @connect      api.bilibili.com
// @connect      member.bilibili.com
// @connect      *.hdslb.com
// @noframes
// ==/UserScript==
/* No remote dependencies. Scanning never uploads images or publishes videos.
 * Credentials are read from the current browser session only when required.
 * Image upload and publication require explicit confirmation in the review UI.
 */
(function () {
  'use strict';
  const API = 'https://api.live.bilibili.com/xlive/app-blink/v1/anchorVideo/';
  const NAV = 'https://api.bilibili.com/x/web-interface/nav';
  const ROUTES = Object.freeze({sessionData:API+'GetLiveSessionData',manuscript:'https://member.bilibili.com/x/vupre/web/archive/view',editManuscript:'https://member.bilibili.com/x/vu/web/edit',replays: API+'AnchorGetReplayList', published: API+'AnchorGetVideoSliceList', streams: API+'GetSliceStream', publish: API+'AnchorPublishVideoSlice', nav: NAV,frames:API+'GetAnchorVideoKeyFrame',upload:'https://api.bilibili.com/x/upload/web/image'});
  const MAX = 7200, CHUNK = 7190, SETTLE = 300, MAX_PAGES = 250;
  const BLOCKED = new Set(['sending','unknown','accepted','processing','posted','remote_failed','rejected','duplicate']);
  const LABEL = {ready:'待确认',sending:'正在提交',unknown:'结果不明，禁止重发',accepted:'已提交，等待云端处理',processing:'云端处理中',posted:'已投稿，转码审核另查',remote_failed:'云端投稿失败',rejected:'提交被拒绝',duplicate:'已有内容或标题冲突',retry_ready:'待投稿（已重置）'};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const assert = (condition, message) => {if (!condition) throw new Error(message);};
  // Preserve 64-bit identifiers before JSON.parse can round them.
  function parseJSON(text) {
    return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (all, string, number) => {
      if (string || !/^-?\d+$/.test(number)) return all;
      return Number.isSafeInteger(Number(number)) ? all : JSON.stringify(number);
    }));
  }
  function time(value) {
    if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value);
    if (typeof value !== 'string') return NaN;
    const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ','T')+'+08:00' : value;
    return Date.parse(s)/1000;
  }
  function stamp(ts) {return new Date((ts+8*3600)*1000).toISOString().slice(0,19).replace('T',' ');}
  function date(ts) {return stamp(ts).slice(0,10);}
  function duration(s) {return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(v=>String(v).padStart(2,'0')).join(':');}
  function title(topic, start, n) {
    assert(n>=1 && n<=99,'同日同主题超过99段，无法使用两位序号');
    const suffix = ` ${date(start)} ${String(n).padStart(2,'0')}`;
    let head = String(topic).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
    assert(head,'直播主题为空，请填写主题');
    while (head.length+suffix.length>80) head=Array.from(head).slice(0,-1).join('');
    return head+suffix;
  }
  function validateTitleDrafts(clips,drafts,known=[]){
    const titles={},errors={},owners=new Map();
    for(const clip of clips){
      const value=drafts===undefined?clip.title:drafts[clip.key];
      if(typeof value!=='string'){errors[clip.key]='标题必须是文字';continue;}
      const clean=value.trim();
      if(!clean)errors[clip.key]='标题不能为空';
      else if(clean.length>80)errors[clip.key]='标题长度超过80，请缩短';
      else if(/[\u0000-\u001f\u007f]/.test(value))errors[clip.key]='标题不能包含换行或控制字符';
      else{
        titles[clip.key]=clean;const group=owners.get(clean)||[];group.push(clip.key);owners.set(clean,group);
        if(known.some(p=>p.title===clean&&p.state!=='投稿失败'))errors[clip.key]='已有同名投稿，请补充或修改标题';
      }
    }
    for(const group of owners.values())if(group.length>1)for(const key of group)errors[key]='本批次标题重复，请分别补充主题';
    return {titles,errors};
  }
  function coverURL(value) {
    const u = new URL(String(value).replace(/^http:/,'https:').replace(/^\/\//,'https://'));
    assert(u.protocol==='https:' && u.hostname.endsWith('.hdslb.com') && !u.username && !u.password,'缺少有效的B站图片封面');
    return u.href;
  }
  function stableCover(value) {
    try{const u=new URL(String(value));return ['http:','https:'].includes(u.protocol)&&u.hostname.endsWith('.hdslb.com')&&!u.username&&!u.password&&u.pathname.startsWith('/bfs/live/')&&!u.search&&!u.hash?u.href:'';}catch(_){return '';}
  }
  function publishCoverURL(value){const url=stableCover(value);assert(url,'封面尚未转换为稳定图片地址，请先上传');return url;}
  function checkedImage(blob){assert(blob&&Number.isFinite(blob.size)&&blob.size>0&&blob.size<=10*1024*1024&&['image/jpeg','image/png','image/webp'].includes(blob.type),'封面图片须为10MB以内的JPEG/PNG/WebP');return blob;}
  function imageFailure(message,stage,details={}){return Object.assign(new Error(message),{imageStage:stage,...details});}
  async function normalizeImage(blob){
    if(!blob||!Number.isFinite(blob.size)||blob.size<=0||blob.size>10*1024*1024)throw imageFailure('已读取响应，但图片为空或超过10MB，未进入上传','size');
    let bytes;try{bytes=new Uint8Array(await blob.slice(0,16).arrayBuffer());}catch(_){throw imageFailure('已读取响应，但无法检查图片文件头，未进入上传','format');}
    let type='';
    if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)type='image/jpeg';
    else if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))type='image/png';
    else if(bytes.length>=12&&[82,73,70,70].every((v,i)=>bytes[i]===v)&&[87,69,66,80].every((v,i)=>bytes[i+8]===v))type='image/webp';
    if(!type)throw imageFailure('已下载 '+blob.size+' 字节，但文件头不是JPEG/PNG/WebP（响应类型 '+String(blob.type||'空').slice(0,80)+'），未进入上传','format');
    return blob.type===type?blob:new Blob([blob],{type});
  }
  function createImageReader(options){return async value=>{
    const url=coverURL(value),mode=options.mode();
    const validate=async(blob,http)=>{const normalized=await normalizeImage(blob);try{options.report?.({http,sourceType:String(blob.type||'空').slice(0,80),detectedType:normalized.type,imageBytes:normalized.size});}catch(_){}return normalized;};
    if(mode==='page-fetch'){
      const controller=options.controller(),timer=setTimeout(()=>controller.abort(),25000);
      try{
        let response;try{response=await options.fetch(url,{method:'GET',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:controller.signal});}
        catch(error){throw imageFailure(error?.name==='AbortError'?'封面下载超时，未取得图片字节':'封面下载失败（网络或CORS），未取得图片字节','download');}
        if(response.status<200||response.status>=300)throw imageFailure('封面下载返回HTTP '+response.status+'，未进入上传','download',{imageHTTP:response.status});
        let blob;try{blob=await response.blob();}catch(_){throw imageFailure('封面响应读取失败，未取得完整图片字节','download');}
        return await validate(blob,response.status);
      }finally{clearTimeout(timer);}
    }
    assert(mode==='extension-http','未知图片请求方式');return new Promise((resolve,reject)=>options.gm({method:'GET',url,responseType:'blob',anonymous:true,timeout:25000,redirect:'error',
      onload:r=>{if(r.status<200||r.status>=300){reject(imageFailure('封面下载返回HTTP '+r.status+'，未进入上传','download',{imageHTTP:r.status}));return;}if(r.finalUrl&&new URL(r.finalUrl).origin!==new URL(url).origin){reject(imageFailure('封面图片重定向，停止读取','download'));return;}validate(r.response,r.status).then(resolve,reject);},
      onerror:()=>reject(imageFailure('封面下载网络错误，未取得图片字节','download')),ontimeout:()=>reject(imageFailure('封面下载超时，未取得图片字节','download'))}));
  };}
  function overlaps(a,b,c,d) {return a<d && c<b;}
  function merge(ranges) {
    const out=[];
    for (const r of ranges.sort((a,b)=>a[0]-b[0])) {
      if(out.length && r[0]<=out[out.length-1][1]) out[out.length-1][1]=Math.max(out[out.length-1][1],r[1]);
      else out.push([...r]);
    }
    return out;
  }
  function cutTime(value) {
    const m=/^(\d+):([0-5]\d):([0-5]\d)$/.exec(String(value).trim());
    assert(m,'时间请使用 HH:MM:SS（相对本场开播）');
    const n=Number(m[1])*3600+Number(m[2])*60+Number(m[3]);assert(Number.isSafeInteger(n),'时间超出范围');return n;
  }
  function cutClock(seconds) {
    const n=Math.max(0,Math.floor(seconds));return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(x=>String(x).padStart(2,'0')).join(':');
  }
  // ASS event times are relative. Mapping to a broadcast is explicitly confirmed in the UI.
  function parseDanmakuASS(text) {
    assert(typeof text==='string'&&text.length<=8*1024*1024,'弹幕文件超过 8 MiB 或格式无效');
    let events=false,format=null;const rows=[];let skipped=0;
    for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
      if(/^\[/.test(line.trim())){events=/^\[Events\]$/i.test(line.trim());continue;}if(!events)continue;
      if(/^Format\s*:/i.test(line)){format=line.replace(/^Format\s*:/i,'').split(',').map(x=>x.trim().toLowerCase());continue;}
      if(!/^Dialogue\s*:/i.test(line))continue;
      assert(format&&format.includes('start')&&format.at(-1)==='text','ASS Events 字段无法识别');
      const fields=line.replace(/^Dialogue\s*:\s*/i,'').split(','),values=fields.splice(0,format.length-1);values.push(fields.join(','));
      const obj=Object.fromEntries(format.map((k,i)=>[k,values[i]||''])),m=/^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(obj.start.trim());
      if(!m){skipped++;continue;}
      const offset=Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number('0.'+(m[4]||'0'));
      const content=obj.text.replace(/\{[^}]*\}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ');
      if(!content.trim()){skipped++;continue;}
      rows.push({offset,user:obj.name.trim()||'未提供',text:content});assert(rows.length<=100000,'弹幕超过 100000 条，请缩小范围');
    }
    assert(format,'未找到 ASS Events 格式');return {rows:rows.sort((a,b)=>a.offset-b.offset),skipped};
  }
  function minuteBuckets(rows,origin,duration) {
    const buckets=new Map();for(const row of rows){const offset=row.offset+origin;if(offset<0||offset>=duration)continue;const minute=Math.floor(offset/60);if(!buckets.has(minute))buckets.set(minute,[]);buckets.get(minute).push({...row,offset});}return [...buckets].sort((a,b)=>a[0]-b[0]);
  }
  function validateCuts(session,cuts,allowLong=false) {
    assert(cuts.length>0&&cuts.length<=99,'请保留 1–99 个片段');const sorted=cuts.slice().sort((a,b)=>a.start-b.start);
    for(let i=0;i<sorted.length;i++){const c=sorted[i];assert(Number.isInteger(c.start)&&Number.isInteger(c.end)&&c.end>c.start,'片段起止必须是整数秒，结束须晚于开始');assert(allowLong||c.end-c.start<=CHUNK,'每段最多 1:59:50，请增加分段');assert(session.ranges?.some(([a,b])=>c.start>=a&&c.end<=b),'片段超出可用录像范围或跨越缺口');assert(!i||sorted[i-1].end<=c.start,'片段不能重叠，请调整相邻滑块');assert(typeof c.topic==='string'&&c.topic.trim(),'请填写片段主题');}return sorted;
  }
  function splitAround(cuts,index,start,end,topic) {
    const c=cuts[index];assert(c&&Number.isInteger(start)&&Number.isInteger(end)&&start>=c.start&&end<=c.end&&end>start,'专题范围必须位于所选片段中');
    const pieces=[];if(c.start<start)pieces.push({...c,end:start});pieces.push({...c,start,end,topic:topic.trim()||c.topic});if(end<c.end)pieces.push({...c,start:end});return [...cuts.slice(0,index),...pieces,...cuts.slice(index+1)];
  }
  function assURL(raw) {
    const u=new URL(raw);assert(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)hdslb\.com$/.test(u.hostname),'弹幕下载地址不在 HTTPS 官方 CDN 白名单');return u;
  }
  function createASSReader(options) {
    return async raw=>{
      const u=assURL(raw),check=(status,url,text)=>{assert(status>=200&&status<300,'弹幕文件读取失败');assert(!url||assURL(url).origin===u.origin,'弹幕文件发生跨来源跳转');assert(typeof text==='string'&&text.length<=8*1024*1024,'弹幕文件过大');return text;};
      if(options.mode()==='extension-http')return new Promise((resolve,reject)=>options.gm({method:'GET',url:u.href,anonymous:true,redirect:'error',timeout:25000,onload:r=>{try{resolve(check(r.status,r.finalUrl,r.responseText));}catch(e){reject(e);}},onerror:()=>reject(new Error('弹幕下载失败')),ontimeout:()=>reject(new Error('弹幕下载超时')),onabort:()=>reject(new Error('弹幕下载中止'))}));
      const controller=options.controller(),timer=setTimeout(()=>controller.abort(),25000);try{const r=await options.fetch(u.href,{credentials:'omit',redirect:'error',signal:controller.signal});return check(r.status,r.url,await r.text());}finally{clearTimeout(timer);}
    };
  }
  function makeClips(replay, streamData, topic) {
    const start=Number(replay.start_time), end=Number(replay.end_time);
    assert(Number.isInteger(start) && Number.isInteger(end) && end>start,'开播或结束时间无效');
    assert(typeof replay.live_key==='string' && /^\d+$/.test(replay.live_key),'场次标识必须为完整数字字符串');
    assert(!replay.alarm_info?.is_ban_publish,'此场回放被禁止投稿');
    const ranges=merge((streamData.list||[]).map(x=>{
      assert(Number.isInteger(x.start_time) && Number.isInteger(x.end_time),'录像时间结构已改变，停止处理');
      return [Math.max(start,x.start_time),Math.min(end,x.end_time)];
    }).filter(x=>x[1]>x[0]));
    assert(ranges.length,'暂无可用录像流，稍后重新扫描');
    for(const b of streamData.ban_list||[]) {
      assert(Number.isFinite(Number(b.start_time)) && Number.isFinite(Number(b.end_time)),'违规范围格式无法识别');
      assert(!ranges.some(r=>overlaps(r[0],r[1],Number(b.start_time),Number(b.end_time))),'此场含不可发布范围，需人工处理');
    }
    const clips=[], cover=coverURL(replay.live_info?.cover);
    // Observed encoder overhang: 7199s selected -> 7202s final. Leave 10s headroom.
    for(const [a,b] of ranges) for(let s=a;s<b;s+=CHUNK) {
      const e=Math.min(b,s+CHUNK), n=clips.length+1;
      clips.push({key:`${replay.live_key}:${s}:${e}`,liveKey:replay.live_key,broadcastStart:start,broadcastEnd:end,start:s,end:e,topic:topic??replay.live_info?.title,title:title(topic??replay.live_info?.title,start,n),cover,defaultCover:cover,sequence:n});
    }
    return {clips,ranges,missingSeconds:end-start-ranges.reduce((n,r)=>n+r[1]-r[0],0)};
  }
  // Daily numbering is shared by all broadcasts with the same rendered topic.
  // Persist reservations so a vanished old replay never renumbers later clips.
  function assignDailyNumbers(clips,ledger,rows) {
    if(ledger.numbering===undefined)ledger.numbering={version:1,groups:{}};
    const book=ledger.numbering;
    assert(book?.version===1&&book.groups&&typeof book.groups==='object'&&!Array.isArray(book.groups),'编号账本格式错误，请保留诊断备份');
    const groups=new Map(),suffix=/^(.*) (0[1-9]|[1-9]\d)$/;
    const ordered=clips.slice().sort((a,b)=>a.broadcastStart-b.broadcastStart||a.liveKey.localeCompare(b.liveKey)||a.start-b.start||a.end-b.end);
    for(const c of ordered){
      let prefix=title(c.topic,c.broadcastStart,1).slice(0,-3);
      const old=ledger.tasks[c.key],saved=old?.attempts>0&&['sending','unknown','accepted','processing','posted'].includes(old.state)&&suffix.exec(old.automaticTitle||old.clip?.automaticTitle||old.clip?.title||'');
      if(saved){prefix=saved[1];c.fixedSequence=Number(saved[2]);}
      const list=groups.get(prefix)||[];list.push(c);groups.set(prefix,list);
    }
    for(const [prefix,list]of groups){
      let group=book.groups[prefix];
      if(group===undefined)group=book.groups[prefix]={last:0,byClip:{}};
      assert(Number.isInteger(group.last)&&group.last>=0&&group.last<=99&&group.byClip&&typeof group.byClip==='object'&&!Array.isArray(group.byClip),'日期编号账本格式错误，请保留诊断备份');
      const owners=new Map(),used=new Set();
      for(const [key,n]of Object.entries(group.byClip)){
        assert(Number.isInteger(n)&&n>=1&&n<=99&&!owners.has(n),'编号账本存在重复或无效编号，请保留诊断备份');
        owners.set(n,key);used.add(n);group.last=Math.max(group.last,n);
      }
      function reserve(c,n){
        if(Object.hasOwn(group.byClip,c.key)){assert(group.byClip[c.key]===n,'已提交片段的编号与本地账本不一致，请人工核对');return;}
        assert(!owners.has(n)||owners.get(n)===c.key,'已提交片段的编号已被另一片段占用，请人工核对');
        group.byClip[c.key]=n;owners.set(n,c.key);used.add(n);group.last=Math.max(group.last,n);
      }
      for(const c of list)if(c.fixedSequence)reserve(c,c.fixedSequence);
      const existing=rows.map(r=>({r,match:suffix.exec(r.av_title||'')})).filter(x=>x.match?.[1]===prefix).sort((a,b)=>Number(a.match[2])-Number(b.match[2]));
      for(const {r,match}of existing){
        const n=Number(match[2]);used.add(n);group.last=Math.max(group.last,n);
        if(owners.has(n))continue;
        const [s,e]=rowRange(r);if(!Number.isFinite(s)||!Number.isFinite(e))continue;
        // An existing differently-sized cut belongs to its largest overlap,
        // never to every clip it touches (e.g. an encoder's 1-second overhang).
        let best=null,overlap=0;
        for(const c of list){if(Object.hasOwn(group.byClip,c.key))continue;const amount=Math.max(0,Math.min(c.end,e)-Math.max(c.start,s));if(amount>overlap){best=c;overlap=amount;}}
        if(best)reserve(best,n);
      }
      for(const c of list){
        if(!Object.hasOwn(group.byClip,c.key)){
          let n=group.last+1;while(used.has(n))n++;
          assert(n<=99,`${prefix} 的编号超过99，请使用更具体的直播主题`);reserve(c,n);
        }
        c.sequence=group.byClip[c.key];c.title=prefix+' '+String(c.sequence).padStart(2,'0');delete c.fixedSequence;
      }
    }
    return clips;
  }
  function rowID(row) {return String(row.slice_id??row.silce_id??'');}
  function rowRange(row) {return [time(row.start_tm??row.start_time),time(row.end_tm??row.end_time)];}
  function publicationInfo(row) {
    const [start,end]=rowRange(row),avid=/^[1-9]\d*$/.test(String(row.avid||''))?String(row.avid):'',bvid=/^BV[A-Za-z0-9]{10}$/.test(String(row.bvid||''))?String(row.bvid):'';
    const createdAt=time(row.ctime),duration=Number(row.av_duration),liveKey=typeof row.live_key==='string'&&/^\d+$/.test(row.live_key)?row.live_key:'';
    return {createdAt:Number.isFinite(createdAt)?createdAt:null,duration:row.av_duration!==undefined&&Number.isInteger(duration)&&duration>=0?duration:null,liveKey,sliceId:rowID(row),title:String(row.av_title||'未返回标题'),start:Number.isFinite(start)?start:null,end:Number.isFinite(end)?end:null,
      state:({1:'处理中',2:'已投稿',3:'投稿失败'})[Number(row.av_status)]||'状态待核对',avid,bvid,reason:String(row.failed_reason||''),
      href:bvid?'https://www.bilibili.com/video/'+bvid+'/':avid?'https://www.bilibili.com/video/av'+avid:'https://member.bilibili.com/platform/upload-manager/article',direct:!!(avid||bvid)};
  }
  function parseCardDuration(value){
    const parts=String(value||'').trim().split(':');if(![2,3].includes(parts.length)||parts.some(p=>!/^\d+$/.test(p)))return null;
    const n=parts.map(Number);if(n.at(-1)>=60||parts.length===3&&n[1]>=60)return null;
    return parts.length===2?n[0]*60+n[1]:n[0]*3600+n[1]*60+n[2];
  }
  function matchPublishedCard(publications,identity){
    const ids=['sliceId','avid','bvid'].filter(k=>identity[k]);
    let candidates;
    if(ids.length)candidates=publications.filter(p=>ids.every(k=>String(p[k])===String(identity[k])));
    else{
      const text=String(identity.created||'').trim();if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text))return null;
      candidates=publications.filter(p=>p.title===String(identity.title||'').trim()&&Number.isFinite(p.createdAt)&&stamp(p.createdAt).slice(0,text.length)===text);
      const seconds=parseCardDuration(identity.duration);
      if(seconds!==null)candidates=candidates.filter(p=>p.duration===null||p.duration===undefined||p.duration===seconds);
    }
    return candidates.length===1?candidates[0]:null;
  }
  function reversePublication(publication,sessions){
    // Store a compact copy, never a session object containing its publications.
    const summary=s=>({liveKey:s.liveKey,start:s.start,end:s.end,topic:s.topic,originalTopic:s.originalTopic});
    if(publication.liveKey){const found=sessions.filter(s=>s.liveKey===publication.liveKey);
      if(found.length===1)return {kind:'matched',method:'liveKey',session:summary(found[0]),candidates:[]};
      return {kind:found.length?'ambiguous':'missing',method:'liveKey',candidates:found.map(summary),reason:found.length?'场次ID对应多个记录，请核对':'来源场次未在当前回放列表中，可能已过期'};
    }
    const {start,end}=publication;if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return {kind:'invalid',candidates:[],reason:'投稿记录缺少有效切片起止时间，无法反查'};
    const full=sessions.filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start<=start&&s.end>=end);
    if(full.length===1)return {kind:'matched',method:'range',session:summary(full[0]),candidates:[]};
    if(full.length>1)return {kind:'ambiguous',method:'range',candidates:full.map(summary),reason:'切片时间对应多个直播场次，请核对'};
    const partial=sessions.filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&overlaps(start,end,s.start,s.end));
    return {kind:partial.length?'partial':'missing',method:'range',candidates:partial.map(summary),reason:partial.length?'切片未被单场完整覆盖，可能跨场或范围不完整，请核对':'来源场次未在当前回放列表中，可能已过期'};
  }
  function indexPublications(rows,sessions){return rows.map(row=>{const p=publicationInfo(row);return {...p,origin:reversePublication(p,sessions)};});}
  function relatedPublications(clip,rows,old={}) {
    return rows.filter(r=>{const [a,b]=rowRange(r);return !(Number(r.av_status)===3&&old.ignoreFailedIDs?.includes(rowID(r)))&&
      (r.av_title===clip.title||(Number.isFinite(a)&&Number.isFinite(b)&&overlaps(clip.start,clip.end,a,b)));})
      .map(r=>{const info=publicationInfo(r);return {...info,match:r.av_title===clip.title?'同名标题'+(info.start!==null&&overlaps(clip.start,clip.end,info.start,info.end)?' / 时间重叠':''):'时间重叠'};});
  }
  function attachPublications(sessions,clips,rows) {
    for(const c of clips)c.publications=relatedPublications(c,rows);
    for(const s of sessions){const map=new Map();for(const r of rows){const [a,b]=rowRange(r);if(Number.isFinite(a)&&Number.isFinite(b)&&overlaps(s.start,s.end,a,b)){const info=publicationInfo(r);map.set(info.sliceId,info);}}
      for(const c of clips.filter(c=>c.liveKey===s.liveKey))for(const info of c.publications)map.set(info.sliceId,info);
      s.publications=[...map.values()];}
  }
  function statusTone(status) {
    return ['已投稿','posted'].includes(status)?'tone-green':['未投稿','投稿失败','ready','retry_ready','rejected','remote_failed'].includes(status)?'tone-red':
      ['部分已投稿','duplicate'].includes(status)?'tone-amber':'tone-blue';
  }
  function randomFrameTimestamp(clip,previous,random=Math.random) {
    const seconds=clip.end-clip.start;assert(Number.isInteger(seconds)&&seconds>0,'片段范围无效');
    const margin=Math.min(15,Math.floor((seconds-1)*.05)),lo=clip.start+margin,hi=clip.end-margin-1,n=hi-lo+1;
    const u=random();assert(Number.isFinite(u)&&u>=0&&u<1,'随机数无效');
    const skip=Number.isInteger(previous)&&previous>=lo&&previous<=hi&&n>1;
    let ts=lo+Math.floor(u*(n-(skip?1:0)));if(skip&&ts>=previous)ts++;
    return ts;
  }
  function frameSelection(clip,data,requested) {
    assert(Array.isArray(data?.list),'关键帧返回结构无法识别');
    const row=data.list.find(r=>Number(r.ts)===requested)||(data.list.length===1?data.list[0]:null),ts=Number(row?.ts);
    assert(row&&Number.isInteger(ts)&&ts>=clip.start&&ts<clip.end&&row.url,'未取得本片段内可用关键帧，请重试或选择默认封面');
    return {url:coverURL(row.url),ts,requested,source:'random'};
  }
  function remoteConflict(clip, rows, old={}) {
    const ownsID=!!old.sliceId&&Number(old.attempts)>0;
    const ordered=ownsID?[...rows].sort((a,b)=>Number(rowID(b)===old.sliceId)-Number(rowID(a)===old.sliceId)):rows;
    for (const r of ordered) {
      const state=Number(r.av_status), id=rowID(r), [s,e]=rowRange(r);
      if (state===3 && old.ignoreFailedIDs?.includes(id)) continue;
      const sameID=ownsID && old.sliceId===id;
      const interval=Number.isFinite(s)&&Number.isFinite(e)&&overlaps(clip.start,clip.end,s,e);
      const sameTitle=r.av_title===clip.title;
      if(sameID || interval || sameTitle) {
        const exact=s===clip.start && e===clip.end && sameTitle;
        return {state:exact||sameID?({1:'processing',2:'posted',3:'remote_failed'}[state]||'unknown'):'duplicate',sliceId:id,avid:r.avid?String(r.avid):'',publications:relatedPublications(clip,rows,old),message:interval&&!exact&&!sameID?'已有片段与此时间范围重叠':sameTitle&&!exact&&!sameID?'服务器已有同名标题':r.failed_reason||'服务器已存在该片段'};
      }
    }
    return null;
  }
  function payload(c,csrf) {
    assert(c.end>c.start && c.end-c.start<=MAX,'单段时长必须大于0且不超过7200秒');
    assert(c.title && c.title.length<=80,'标题长度无效');
    assert(/^[0-9a-f]{32}$/i.test(csrf),'未取得有效CSRF，请检查登录状态');
    return {live_key:c.liveKey,start_ts:c.start,end_ts:c.end,av_title:c.title,av_cover:publishCoverURL(c.cover),av_highlight:0,with_subtitle:0,with_danmaku:0,with_reserve:0,csrf};
  }
  // Page fetch is observable in page DevTools. Never switch transport after a failed POST.
  function createRequestTransport(options) {
    return async (url,params,method,format={})=>{
      assert(Object.values(ROUTES).includes(url),'请求地址不在白名单');
      const u=new URL(url),mode=options.mode(),started=Date.now();
      if((format.json||format.multipart)&&params.csrf)u.searchParams.set('csrf',params.csrf);
      if(method==='GET')for(const [k,v]of Object.entries(params))u.searchParams.set(k,String(v));
      const headers=method==='POST'&&!format.multipart?{'Content-Type':format.json?'application/json':'application/x-www-form-urlencoded'}:{};
      let body=method==='POST'?(format.json?JSON.stringify(Object.fromEntries(Object.entries(params).filter(([k])=>k!=='csrf'))):new URLSearchParams(params).toString()):undefined;
      if(format.multipart){body=options.formData?.()||new FormData();body.append('bucket','live');body.append('file',checkedImage(params.file),'cover.'+({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[params.file.type]));}
      const finish=(status,finalURL,text,trace)=>{
        assert(!finalURL||new URL(finalURL).origin===u.origin,'接口跳转到其它来源，停止');
        let json=null;try{json=parseJSON(text);}catch(_){}
        return {http:status,json,transport:mode,elapsedMs:Date.now()-started,traceId:/^[a-zA-Z0-9_-]{1,128}$/.test(trace||'')?trace:''};
      };
      if(mode==='page-fetch'){
        const controller=options.controller(),timer=setTimeout(()=>controller.abort(),options.timeoutMs||25000);
        try{
          const response=await options.fetch(u.href,{method,headers,body,credentials:'include',redirect:'error',signal:controller.signal});
          const text=await response.text();return finish(response.status,response.url,text,response.headers?.get('x-bili-trace-id'));
        }catch(error){throw new Error(error?.name==='AbortError'?'页面请求超时，投稿结果需核对':'页面请求失败（可能为网络、CORS或站点限制）；不会自动切换方式重投');}
        finally{clearTimeout(timer);}
      }
      assert(mode==='extension-http','未知请求方式');
      return new Promise((resolve,reject)=>options.gm({method,url:u.href,anonymous:false,timeout:options.timeoutMs||25000,redirect:'error',headers,data:body,
        onload:r=>{try{resolve(finish(r.status,r.finalUrl,r.responseText,/^x-bili-trace-id:\s*([^\r\n]+)/im.exec(r.responseHeaders||'')?.[1]?.trim()));}catch(error){reject(error);}},
        onerror:()=>reject(new Error('扩展请求网络错误')),ontimeout:()=>reject(new Error('扩展请求超时')),onabort:()=>reject(new Error('扩展请求中止'))}));
    };
  }
  function requestIntervalMs(value=100) {
    assert(value!==''&&value!==null&&Number.isInteger(Number(value))&&Number(value)>=0&&Number(value)<=60000,'请求前间隔须为0–60000之间的整数毫秒');return Number(value);
  }
  class Engine {
    constructor(env) {this.env=env;this.snapshot=null;this.stopped=false;this.events=[];this.coverOptions=new Map();this.coverWrites=Promise.resolve();this.publicationCheck=null;this.verifiedUID=null;this.scanTicket=null;}
    log(event) {this.events.push({at:new Date(this.env.now()*1000).toISOString(),...event});this.events=this.events.slice(-800);this.env.log?.(event);}
    notify(event) {try {this.env.progress?.(event);} catch (_) {}}
    async call(route,params={},method='GET') {
      assert(Object.hasOwn(ROUTES,route),'接口未列入白名单');
      assert(method==='GET'||(method==='POST'&&['publish','frames','upload','editManuscript'].includes(route)),'此接口不允许写入');
      for(let attempt=0;;attempt++) {
        try {
          if(route==='streams')await this.requestPause(route);
          const transport=this.env.transport?.()||'custom';this.log({route,method,phase:'start',transport,fields:Object.keys(params).filter(k=>!['csrf','csrf_token'].includes(k))});
          const r=await this.env.request(ROUTES[route],params,method,['frames','editManuscript'].includes(route)?{json:true}:route==='upload'?{multipart:true}:undefined);
          this.log({route,method,http:r.http,code:r.json?.code,transport:r.transport||transport,elapsedMs:r.elapsedMs,traceId:r.traceId||'',message:String(r.json?.message||r.json?.msg||(r.json===null?'非JSON响应':'')).slice(0,300)});
          if(r.http<200 || r.http>=300) throw Object.assign(new Error(`HTTP ${r.http}`),{retryable:r.http===429||r.http>=500});
          assert(r.json && typeof r.json.code==='number','接口响应结构无法识别');
          if(r.json.code!==0) throw Object.assign(new Error(`${route}: ${r.json.code} ${r.json.message||r.json.msg||''}`),{apiCode:r.json.code});
          return r.json.data;
        } catch(e) {
          this.log({route,method,error:e.message});
          if(method!=='GET'||e.apiCode!==undefined||e.retryable===false||attempt>=2) throw e;
          this.notify({stage:'retry',text:`读取失败，${2**attempt}秒后重试`});
          await this.env.sleep(1000*2**attempt);
        }
      }
    }
    async account() {
      const d=await this.call('nav');
      assert(d?.isLogin && /^\d+$/.test(String(d.mid)),'请先登录B站');
      return String(d.mid);
    }
    async prepareScan() {
      const uid=await this.account();this.verifiedUID=uid;this.scanTicket={uid};return this.scanTicket;
    }
    scannedAccount() {
      assert(this.snapshot&&this.verifiedUID===this.snapshot.uid,'请先扫描以确认当前账号');return this.verifiedUID;
    }
    async requestPause(route) {
      const ms=requestIntervalMs(this.env.interval?.());
      this.log({route,method:route==='publish'?'POST':'GET',phase:'interval',intervalMs:ms,message:`请求前等待 ${ms}ms`});
      if(ms)this.notify({stage:'request-wait',text:`${route} 请求前等待 ${ms}ms`});
      for(let left=ms;left>0;){if(route==='publish'&&this.stopped)return;const step=Math.min(left,1000);await this.env.sleep(step);left-=step;}
    }
    async list(route) {
      const size=route==='published'?20:30, out=[], seen=new Set();
      let expected=null;
      for(let page=1;page<=MAX_PAGES;page++) {
        const data=await this.call(route,{page,page_size:size});
        const rows=route==='published'?data?.list:data?.replay_info;
        const total=Number(route==='published'?data?.total:data?.pagination?.total);
        assert((rows===null||Array.isArray(rows)) && Number.isInteger(total)&&total>=0,'列表或分页格式改变，停止处理');
        if(expected===null) expected=total;
        assert(expected===total,'扫描期间列表发生变化，请重新扫描');
        for(const r of rows||[]) {
          const id=route==='published'?rowID(r):r.live_key;
          assert(id && !seen.has(id),'列表存在重复页或缺少标识，请重新扫描');
          seen.add(id);out.push(r);
        }
        this.notify({stage:route,text:`${route==='published'?'核对已有投稿':'读取直播场次'} · 第${page}/${Math.max(1,Math.ceil(total/size))}页`,done:out.length,total});
        if(out.length>=total) {assert(out.length===total,'列表总数不一致');return out;}
        assert(rows?.length,'分页提前结束，无法完整去重');
        await this.env.sleep(200);
      }
      throw new Error('分页超过安全上限，停止处理');
    }
    async load(uid) {
      const ledger=await this.env.read(uid);
      assert(ledger&&ledger.version===1&&ledger.tasks&&typeof ledger.tasks==='object','本地账本格式错误：请保留导出备份');
      return ledger;
    }
    async write(uid,ledger) {await this.env.write(uid,ledger);try {this.env.ledger?.(uid,ledger);} catch (_) {}}
    knownPublications(uid) {
      assert(this.publicationCheck?.uid===uid,'请先完成当前账号的初始投稿检查');return this.publicationCheck.rows;
    }
    rememberPublications(uid,rows) {this.publicationCheck={uid,rows:structuredClone(rows),at:this.env.now()};}
    dedupRows(uid,ledger,excludeKey) {
      const local=Object.entries(ledger.tasks).filter(([key,t])=>key!==excludeKey&&Number(t.attempts)>0&&t.clip&&['sending','unknown','accepted','processing','posted'].includes(t.state)).map(([key,t])=>({slice_id:t.sliceId||'local:'+key,av_status:t.state==='posted'?2:0,av_title:t.approvedTitle||t.clip.title,start_tm:stamp(t.clip.start),end_tm:stamp(t.clip.end)}));
      return [...this.knownPublications(uid),...local];
    }
    async scan(topics={},options={}) {
      const ticket=options.accountTicket||await this.prepareScan();assert(ticket===this.scanTicket&&ticket.uid===this.verifiedUID,'扫描账号凭据已失效，请重试');this.scanTicket=null;const uid=ticket.uid;
      return this.env.lock(uid,async()=>{
        const ledger=await this.load(uid);
        if(options.force||this.publicationCheck?.uid!==uid)this.rememberPublications(uid,await this.list('published'));
        const rows=this.knownPublications(uid),replays=await this.list('replays');
        let cache={};
        try {cache=await this.env.cacheRead?.(uid)||{};}catch(_) {}
        if(cache.policy!==CACHE_POLICY||cache.uid!==uid)cache={};
        const streams={},clips=[],sessions=[];
        for(const r of replays.sort((a,b)=>a.start_time-b.start_time)) {
          this.notify({stage:'streams',text:`读取录像范围 · ${sessions.length+1}/${replays.length}`,done:sessions.length,total:replays.length,title:r.live_info?.title});
          const session={liveKey:r.live_key,start:r.start_time,end:r.end_time,topic:topics[r.live_key]??r.live_info?.title??'',originalTopic:(r.live_info?.title||'').trim(),displayStart:Number(r.live_info?.live_time)||r.start_time,notes:[]};sessions.push(session);
          try {
            assert(r.end_time>r.start_time && r.end_time<=this.env.now()-SETTLE,'直播未结束或结束尚不足5分钟');
            assert(![-1,-6].includes(Number(r.video_info?.replay_status)),'回放状态不允许剪辑');
            const signature=JSON.stringify([r.start_time,r.end_time,r.video_info?.replay_status,r.alarm_info]);
            const previous=cache.streams?.[r.live_key],ttl=this.env.now()-r.end_time<900?60:21600;
            const hit=!options.force&&previous?.signature===signature&&Number.isFinite(previous.at)&&this.env.now()>=previous.at&&this.env.now()-previous.at<ttl;
            const stream=hit?previous.data:cleanStreams(await this.call('streams',{live_key:r.live_key,start_time:r.start_time,end_time:r.end_time}));
            streams[r.live_key]={signature,at:hit?previous.at:this.env.now(),data:cleanStreams(stream)};
            session.cachedRanges=hit;
            const made=makeClips(r,stream,session.topic);
            session.missingSeconds=made.missingSeconds;session.ranges=made.ranges;session.coverage=sessionCoverage(made.ranges,rows);
            if(made.missingSeconds) session.notes.push(`实际录像比开播范围少${made.missingSeconds}秒；只使用可用录像`);
            clips.push(...made.clips);
          } catch(e) {session.error=e.message;if(e.apiCode===-101||e.apiCode===-111)throw e;}
          await this.env.sleep(200);
        }
        assignDailyNumbers(clips,ledger,rows);
        for(const c of clips){const old=ledger.tasks[c.key];if(old?.attempts>0&&typeof old.approvedTitle==='string'){c.automaticTitle=c.title;c.title=old.approvedTitle;}}
        attachPublications(sessions,clips,rows);
        for(const clip of clips){
          const old=ledger.tasks[clip.key]||{},remote=remoteConflict(clip,rows,old);
          if(remote)ledger.tasks[clip.key]={...old,...remote,clip,updated:this.env.now()};
          else if(old.state==='sending'){old.state='unknown';old.message='上次发送中断，必须人工核实';}
          const saved=ledger.tasks[clip.key];
          Object.assign(clip,{state:saved?.state||'ready',message:saved?.message||'',blocked:!!saved&&BLOCKED.has(saved.state)});
        }
        const names=new Map();
        for(const c of clips) {const group=names.get(c.title)||[];group.push(c);names.set(c.title,group);}
        for(const group of names.values()) if(group.length>1) for(const c of group) {c.blocked=true;c.planConflict=true;c.message='已固定编号发生冲突，请保留诊断并人工核对';}
        await this.write(uid,ledger);
        this.coverOptions.clear();this.snapshot={uid,created:this.env.now(),publicationCheckedAt:this.publicationCheck.at,token:JSON.stringify(clips.map(c=>[c.key,c.title,c.cover])),sessions,clips,published:indexPublications(rows,sessions)};
        try {await this.env.cacheWrite?.(uid,{policy:CACHE_POLICY,uid,at:this.env.now(),streams,plan:this.snapshot});}catch(e){this.log({error:'扫描缓存写入失败：'+e.message});}
        this.notify({stage:'scanned',text:'扫描完成，等待选择',done:replays.length,total:replays.length});
        return this.snapshot;
      });
    }
    async danmaku(liveKey,token) {
      const snapshot=this.snapshot,session=snapshot?.sessions.find(s=>s.liveKey===liveKey);
      assert(session&&snapshot.token===token&&this.scannedAccount()===snapshot.uid,'计划或账号已改变');
      const data=await this.call('sessionData',{live_key:liveKey,start_tm:stamp(session.start),end_tm:stamp(session.end)});
      assert(data?.ass_url,'此场未提供弹幕文件（可能尚未生成或无权限）');
      const result=parseDanmakuASS(await this.env.readASS(data.ass_url));assert(this.snapshot===snapshot&&this.scannedAccount()===snapshot.uid,'计划或账号已改变');return result;
    }
    async reviseCuts(token,keys,liveKey,drafts) {
      const snapshot=this.snapshot;assert(snapshot?.token===token&&this.env.now()-snapshot.created<900,'计划已过期，请重新扫描');assert(this.scannedAccount()===snapshot.uid,'登录账号已改变');
      return this.env.lock(snapshot.uid,async()=>{
        assert(this.snapshot===snapshot,'计划已改变');const ledger=await this.load(snapshot.uid),selected=new Set(keys),old=snapshot.clips.filter(c=>selected.has(c.key)),session=snapshot.sessions.find(s=>s.liveKey===liveKey);
        assert(old.length===selected.size&&old.length&&old.every(c=>c.liveKey===liveKey&&!c.blocked&&!ledger.tasks[c.key]?.attempts),'仅可调整本场尚未尝试投稿的片段');
        const allowed=merge(old.map(c=>[c.start,c.end]));const cuts=validateCuts(session,drafts);
        assert(cuts.every(c=>allowed.some(([a,b])=>c.start>=a&&c.end<=b)),'调整范围不能超出本次选中的片段');
        const remaining=snapshot.clips.filter(c=>!selected.has(c.key));assert(cuts.every(c=>!remaining.some(r=>r.liveKey===liveKey&&overlaps(c.start,c.end,r.start,r.end))),'与未选中的片段重叠');
        const clips=cuts.map(c=>({...old[0],key:`${liveKey}:${c.start}:${c.end}`,start:c.start,end:c.end,topic:c.topic.trim(),cover:old[0].defaultCover||old[0].cover,state:'ready',blocked:false,message:'',automaticTitle:undefined}));
        const rows=this.dedupRows(snapshot.uid,ledger);assignDailyNumbers(clips,ledger,rows);
        for(const c of clips){assert(!ledger.tasks[c.key]?.attempts,'此时间段已有投稿尝试记录，需先核实');assert(!remoteConflict(c,rows,ledger.tasks[c.key]||{}),'调整后的范围与已有投稿冲突');}
        assert(this.scannedAccount()===snapshot.uid&&this.snapshot===snapshot,'计划或账号已改变');await this.write(snapshot.uid,ledger);
        this.coverOptions.clear();this.reviewSession=null;
        this.snapshot={...snapshot,clips:[...remaining,...clips].sort((a,b)=>a.start-b.start),token:JSON.stringify([snapshot.token,clips.map(c=>[c.key,c.title]),this.env.now()])};return {plan:this.snapshot,keys:clips.map(c=>c.key)};
      });
    }
    stop() {this.stopped=true;}
    beginReview(token,keys) {
      const plan=this.snapshot;
      assert(plan&&plan.token===token&&this.env.now()-plan.created<900,'计划已过期，请重新扫描');
      this.reviewSession={plan,keys:new Set(keys)};return this.reviewSession;
    }
    endReview(session) {if(this.reviewSession===session)this.reviewSession=null;}
    reviewCurrent(plan,key) {return this.reviewSession?.plan===plan&&this.reviewSession.keys.has(key);}
    async randomCover(key,previous,restoreTimestamp) {
      const plan=this.snapshot,clip=plan?.clips.find(c=>c.key===key);
      assert(clip&&(!clip.blocked||this.reviewCurrent(plan,key)&&['rejected','remote_failed'].includes(clip.state)),'片段不可用，请重新扫描');assert(this.reviewCurrent(plan,key)||this.env.now()-plan.created<900,'计划已超过15分钟，请重新扫描');
      assert(this.scannedAccount()===plan.uid,'登录账号已改变，停止读取封面');
      const csrf=this.env.csrf();assert(/^[0-9a-f]{32}$/i.test(csrf),'未取得有效CSRF，请检查登录状态');
      const ts=restoreTimestamp===undefined?randomFrameTimestamp(clip,previous,this.env.random||Math.random):restoreTimestamp;assert(Number.isInteger(ts)&&ts>=clip.start&&ts<clip.end,'保存的封面时间不在当前片段内');
      // This POST reads key-frame images only. It never publishes or creates a draft.
      const data=await this.call('frames',{live_key:clip.liveKey,time_list:String(ts),csrf},'POST');
      assert(this.snapshot===plan,'计划已改变，请重新打开确认窗口');assert(this.scannedAccount()===plan.uid,'登录账号已改变，停止读取封面');
      const result=frameSelection(clip,data,ts),options=this.coverOptions.get(key)||new Set();
      options.add(JSON.stringify([result.url,result.ts]));this.coverOptions.set(key,options);return result;
    }
    async savedCoverChoices(keys) {
      const plan=this.snapshot;assert(plan,'请先扫描');assert(this.scannedAccount()===plan.uid,'账号已改变，停止读取封面选择');
      const ledger=await this.load(plan.uid),out={};
      for(const key of keys){const c=plan.clips.find(c=>c.key===key),task=ledger.tasks[key],previous=task?.approvedCover,d=ledger.coverDrafts?.[key]||(previous&&task.clip?{...previous,liveKey:task.clip.liveKey,start:task.clip.start,end:task.clip.end}:null);
        if(c&&d&&d.liveKey===c.liveKey&&d.start===c.start&&d.end===c.end&&(['default'].includes(d.source)||d.source==='random'&&Number.isInteger(d.ts)&&d.ts>=c.start&&d.ts<c.end))out[key]={source:d.source,ts:d.ts};
      }return out;
    }
    saveCoverChoice(key,choice) {
      const plan=this.snapshot,c=plan?.clips.find(c=>c.key===key);assert(c,'当前片段不存在');
      const draft={source:choice.source,ts:choice.ts??null,liveKey:c.liveKey,start:c.start,end:c.end,updated:this.env.now()};
      assert(['default','random'].includes(draft.source),'未知封面类型');
      if(draft.source==='random')assert(Number.isInteger(draft.ts)&&draft.ts>=c.start&&draft.ts<c.end&&this.coverOptions.get(key)?.has(JSON.stringify([coverURL(choice.url),draft.ts])),'封面未经当前计划读取');
      // Serialize independent image callbacks and merge with the latest account ledger.
      const work=this.coverWrites.catch(()=>{}).then(async()=>{
        assert(this.snapshot===plan,'扫描计划已改变，未保存旧封面');assert(this.scannedAccount()===plan.uid,'账号已改变，未保存封面');
        return this.env.lock(plan.uid,async()=>{const ledger=await this.load(plan.uid);ledger.coverDrafts=ledger.coverDrafts||{};ledger.coverDrafts[key]=draft;await this.write(plan.uid,ledger);});
      });this.coverWrites=work;return work;
    }
    async preparePublishCover(c,ledger) {
      const plan=this.snapshot;assert(plan&&this.scannedAccount()===plan.uid,'请先扫描以确认账号');const direct=stableCover(c.cover);if(direct)return direct;
      let source=new URL(coverURL(c.cover)),sourcePath=source.origin+source.pathname,identity=JSON.stringify([c.coverSource||'default',c.coverTimestamp??null,sourcePath]);const cached=ledger.coverUploads?.[c.key];
      if(cached?.identity===identity&&stableCover(cached.location))return cached.location;
      assert(this.env.readImage,'未提供封面读取功能，停止投稿');
      this.notify({stage:'cover-upload',text:'正在将所选封面上传为稳定图片地址',title:c.title});
      this.log({route:'cover-image',method:'GET',phase:'start',message:'读取已确认封面；不记录临时图片地址'});
      let file;
      try{file=await normalizeImage(await this.env.readImage(c.cover));}
      catch(error){
        if(this.stopped)return '';
        if(['format','size'].includes(error.imageStage)||c.coverSource!=='random'||!Number.isInteger(c.coverTimestamp))throw error;
        assert(this.snapshot===plan&&this.scannedAccount()===plan.uid,'计划已改变，停止重新取图');
        this.notify({stage:'cover-refresh',text:'图片读取失败，正在按原时间戳重新取图',title:c.title});
        this.log({route:'frames',method:'POST',phase:'renew',message:`自动重新取图一次，保持原时间 ${stamp(c.coverTimestamp)}`});
        const fresh=await this.randomCover(c.key,undefined,c.coverTimestamp);
        assert(fresh.ts===c.coverTimestamp,'重新取图返回了不同时间的画面，请手动重新选择并确认封面');
        if(this.stopped)return '';c.cover=fresh.url;
        try{this.env.coverRefresh?.(c.key,{...fresh});}catch(_){}
        source=new URL(coverURL(c.cover));sourcePath=source.origin+source.pathname;identity=JSON.stringify([c.coverSource,c.coverTimestamp,sourcePath]);
        try{file=await normalizeImage(await this.env.readImage(c.cover));}catch(error){if(['format','size'].includes(error.imageStage))throw error;throw new Error('已按原时间戳重新取图一次，下载仍失败：'+error.message+'；未上传或投稿');}
      }
      if(this.stopped)return '';assert(this.snapshot===plan&&this.scannedAccount()===plan.uid,'计划已改变，停止上传封面');
      const csrf=this.env.csrf();assert(/^[0-9a-f]{32}$/i.test(csrf),'未取得有效CSRF，请检查登录状态');
      const data=await this.call('upload',{csrf,file,bucket:'live'},'POST'),location=publishCoverURL(data?.location);
      assert(this.snapshot===plan&&this.scannedAccount()===plan.uid,'计划已改变，未保存封面上传结果');ledger.coverUploads=ledger.coverUploads||{};ledger.coverUploads[c.key]={identity,location,at:this.env.now()};
      await this.write(plan.uid,ledger);return location;
    }
    async publish(keys,token,approvedCovers,approvedTitles) {
      const plan=this.snapshot;
      assert(plan&&plan.token===token,'计划已改变，请重新确认');
      assert(keys.every(k=>this.reviewCurrent(plan,k))||this.env.now()-plan.created<15*60,'计划已超过15分钟，请重新扫描');
      assert(keys.length&&new Set(keys).size===keys.length,'请选择片段，且不可重复选择');
      const base=keys.map(k=>plan.clips.find(c=>c.key===k));
      assert(base.every(c=>c&&!c.blocked),'选中项已被阻止');
      if(approvedTitles!==undefined)assert(approvedTitles&&typeof approvedTitles==='object'&&!Array.isArray(approvedTitles)&&Object.keys(approvedTitles).length===keys.length&&Object.keys(approvedTitles).every(k=>keys.includes(k)),'标题确认与选中片段不一致');
      const checkedTitles=validateTitleDrafts(base,approvedTitles);assert(!Object.keys(checkedTitles.errors).length,Object.values(checkedTitles.errors)[0]||'请检查标题');
      if(approvedCovers)assert(Object.keys(approvedCovers).length===keys.length&&Object.keys(approvedCovers).every(k=>keys.includes(k)),'封面确认与选中片段不一致');
      const selected=base.map(c=>{
        const approved={...c,title:checkedTitles.titles[c.key],automaticTitle:c.automaticTitle||c.title};
        if(!approvedCovers)return approved;
        const choice=approvedCovers[c.key];assert(choice&&['default','random'].includes(choice.source),'请先确认所有片段封面');
        const cover=coverURL(choice.url);
        if(choice.source==='default')assert(cover===(c.defaultCover||c.cover),'默认封面已改变，请重新确认');
        else assert(Number.isInteger(choice.ts)&&choice.ts>=c.start&&choice.ts<c.end&&this.coverOptions.get(c.key)?.has(JSON.stringify([cover,choice.ts])),'随机封面未经本次计划读取，请重新确认');
        return {...approved,cover,coverSource:choice.source,coverTimestamp:choice.ts??null};
      });
      this.stopped=false;
      return this.env.lock(plan.uid,async()=>{
        assert(this.scannedAccount()===plan.uid,'登录账号已改变，停止投稿');
        let ledger=await this.load(plan.uid);
        for(let index=0;index<selected.length;index++) {
          const c=selected[index];
          if(this.stopped) break;
          // Account-wide durable spacing covers separate clicks, batches and tabs.
          const wait=Math.max(0,Math.ceil((Number(ledger.nextSubmitAt)||0)-this.env.now()));
          for(let left=wait;left>0&&!this.stopped;left--){
            this.notify({stage:'cooldown',text:`投稿间隔等待 ${left} 秒`,title:c.title});await this.env.sleep(1000);
          }
          if(this.stopped)break;
          this.notify({stage:'submit',text:`投稿队列 · ${index+1}/${selected.length}`,done:index,total:selected.length,title:c.title});
          assert(this.scannedAccount()===plan.uid,'登录账号已改变，停止投稿');
          const old=ledger.tasks[c.key]||{};if(BLOCKED.has(old.state))continue;
          const known=this.knownPublications(plan.uid),conflict=remoteConflict(c,known,old);
          if(conflict) {ledger.tasks[c.key]={...old,...conflict,clip:c};await this.write(plan.uid,ledger);continue;}
          assert(!remoteConflict(c,this.dedupRows(plan.uid,ledger,c.key).slice(known.length),old),'本地已有已受理或结果不明的同名/重叠片段，请修改标题或核对');
          // The scan already obtained available ranges; do not repeat GetSliceStream here.
          const ranges=plan.sessions.find(session=>session.liveKey===c.liveKey)?.ranges;
          assert(ranges?.some(r=>r[0]<=c.start&&r[1]>=c.end),'片段不在扫描确认的录像范围内，请重新扫描');
          c.cover=await this.preparePublishCover(c,ledger);if(this.stopped)break;
          await this.requestPause('publish');if(this.stopped)break;assert(this.snapshot===plan,'计划已改变，停止投稿');
          const body=payload(c,this.env.csrf());
          // Persist before POST: a browser crash never causes an automatic resubmission.
          ledger.tasks[c.key]={...old,state:'sending',clip:c,approvedTitle:c.title,automaticTitle:c.automaticTitle,approvedCover:{url:c.cover,source:c.coverSource||'default',ts:c.coverTimestamp??null},updated:this.env.now(),attempts:(old.attempts||0)+1};
          ledger.nextSubmitAt=this.env.now()+30;
          await this.write(plan.uid,ledger);
          if(this.stopped) {ledger.tasks[c.key]={...old,state:'retry_ready',clip:c,message:'发送前已停止，未调用投稿接口'};await this.write(plan.uid,ledger);break;}
          try {
            const result=await this.call('publish',body,'POST');
            const id=result?.video_slice_id;
            assert(id!==undefined&&/^\d+$/.test(String(id)),'服务器返回成功但缺少切片ID');
            Object.assign(ledger.tasks[c.key],{state:'accepted',sliceId:String(id),message:'已受理，尚未证明投稿完成'});
            await this.write(plan.uid,ledger);
            this.notify({stage:'accepted',text:`已提交 · ${index+1}/${selected.length}`,done:index+1,total:selected.length,title:c.title});
          } catch(e) {
            // No POST retry. A timeout/5xx/malformed success can hide a successful submit.
            Object.assign(ledger.tasks[c.key],{state:e.apiCode===undefined?'unknown':([4002,4006].includes(e.apiCode)?'duplicate':'rejected'),apiCode:e.apiCode??null,message:e.message});
            if(e.apiCode===4001)ledger.nextSubmitAt=Math.max(ledger.nextSubmitAt,this.env.now()+60);
            await this.write(plan.uid,ledger);
            throw e;
          }
        }
        this.notify({stage:this.stopped?'stopped':'submitted',text:this.stopped?'队列已停止':'本批次提交结束，云端处理结果请刷新状态'});
        return ledger;
      });
    }
    async reconcile() {
      const uid=this.scannedAccount();
      return this.env.lock(uid,async()=>{
        const ledger=await this.load(uid),rows=await this.list('published');this.rememberPublications(uid,rows);
        for(const task of Object.values(ledger.tasks)) {
          if(!task.clip) continue;
          const remote=remoteConflict(task.clip,rows,task);
          if(remote) Object.assign(task,remote,{updated:this.env.now()});
          else if(task.state==='sending') Object.assign(task,{state:'unknown',message:'未找到确认结果，禁止自动重发'});
        }
        if(this.snapshot?.uid===uid){
          this.snapshot.publicationCheckedAt=this.publicationCheck.at;this.snapshot.published=indexPublications(rows,this.snapshot.sessions);attachPublications(this.snapshot.sessions,this.snapshot.clips,rows);
          for(const s of this.snapshot.sessions)if(s.ranges)s.coverage=sessionCoverage(s.ranges,rows);
          for(const c of this.snapshot.clips){const old=ledger.tasks[c.key]||{},remote=remoteConflict(c,rows,old);if(remote)ledger.tasks[c.key]={...old,...remote,clip:c,updated:this.env.now()};}
        }
        await this.write(uid,ledger);return ledger;
      });
    }
    async allowRetry(keys) {
      const plan=this.snapshot;assert(plan,'请先扫描');assert(keys.length&&new Set(keys).size===keys.length,'请选择需要重置的片段');
      const uid=this.scannedAccount();assert(uid===plan.uid,'登录账号已改变');
      return this.env.lock(uid,async()=>{
        const ledger=await this.load(uid),rows=this.knownPublications(uid),updates=[];
        for(const key of keys){
          const task=ledger.tasks[key],clip=plan.clips.find(c=>c.key===key);
          assert(task&&['remote_failed','rejected','duplicate'].includes(task.state)&&Number(task.attempts)>0,'只能重置有提交记录且明确失败的任务');
          assert(clip&&!clip.planConflict,'片段已过期或存在固定编号冲突，请重新扫描核对');
          // Reuse the initial snapshot and local accepted tasks; no per-reset list request.
          const conflict=remoteConflict(task.clip,this.dedupRows(uid,ledger,key).filter(r=>Number(r.av_status)!==3),task);
          assert(!conflict,'服务器仍有成功、处理中或冲突片段，不能重试');
          const failed=relatedPublications(task.clip,rows.filter(r=>Number(r.av_status)===3),{}).map(p=>p.sliceId);
          if(task.sliceId&&rows.some(r=>rowID(r)===task.sliceId&&Number(r.av_status)===3))failed.push(task.sliceId);
          updates.push({key,task,clip,failed});
        }
        assert(this.snapshot===plan&&this.scannedAccount()===uid,'账号或扫描计划已改变，停止重置');
        for(const {task,clip,failed}of updates){
          task.history=[...(task.history||[]),{state:task.state,message:task.message,sliceId:task.sliceId,apiCode:task.apiCode,at:this.env.now()}];
          task.ignoreFailedIDs=[...new Set([...(task.ignoreFailedIDs||[]),...failed])];
          Object.assign(task,{state:'retry_ready',sliceId:'',avid:'',apiCode:null,updated:this.env.now(),message:'已重置为待投稿，保留原序号；再次确认后才会提交'});
          task.publications=relatedPublications(task.clip,rows,task);
        }
        await this.write(uid,ledger);
        for(const {clip,task}of updates)Object.assign(clip,{state:task.state,blocked:false,message:task.message,publications:task.publications});
        return ledger;
      });
    }
  }
  // Cached plans and stream metadata contain no signed stream URLs or credentials.
  const CACHE_POLICY='v3-daily-7190';
  function cleanStreams(data) {
    return {list:(data.list||[]).map(x=>({start_time:x.start_time,end_time:x.end_time})),
      ban_list:(data.ban_list||[]).map(x=>({start_time:x.start_time,end_time:x.end_time}))};
  }
  function sessionCoverage(ranges,rows) {
    const count=statuses=>merge(rows.filter(r=>statuses.includes(Number(r.av_status))).map(r=>[time(r.start_tm),time(r.end_tm)]).filter(r=>r.every(Number.isFinite)&&r[1]>r[0]))
      .reduce((n,r)=>n+ranges.reduce((m,a)=>m+Math.max(0,Math.min(a[1],r[1])-Math.max(a[0],r[0])),0),0);
    const total=ranges.reduce((n,r)=>n+r[1]-r[0],0),posted=count([2]),covered=count([1,2]);
    return {total,posted,covered,status:total&&posted>=total?'已投稿':total&&covered>=total?'处理中':covered>0?'部分已投稿':'未投稿'};
  }
  // Match only the visible official replay card fields; ambiguous matches are never actionable.
  function matchSession(sessions,topic,minute) {
    const found=sessions.filter(s=>s.originalTopic===String(topic).trim()&&stamp(s.displayStart||s.start).slice(0,16)===String(minute).trim());
    return found.length===1?found[0]:null;
  }
  // Manuscript editing is independent of the replay numbering and publication ledger.
  function uniqueTags(values) {
    const seen=new Set();return values.map(v=>String(v).trim()).filter(v=>{const key=v.normalize('NFC');if(!v||seen.has(key))return false;seen.add(key);return true;});
  }
  function bracketTags(text) {
    const pairs={'（':'）','【':'】','(':')','[':']'},closing=new Set(Object.values(pairs)),stack=[],out=[];
    for(const char of String(text)){
      if(Object.hasOwn(pairs,char)){if(stack.length)stack.at(-1).nested=true;stack.push({end:pairs[char],text:'',nested:false});}
      else if(closing.has(char)){
        if(!stack.length)continue;
        if(stack.at(-1).end!==char){stack.length=0;continue;}
        const frame=stack.pop();if(!frame.nested)out.push(frame.text);
      }else if(stack.length)stack.at(-1).text+=char;
    }
    return uniqueTags(out);
  }
  function stableJSON(value){
    if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function manuscriptIdentity(info){
    const aid=String(info.avid||info.aid||''),bvid=String(info.bvid||'');
    assert(/^[1-9]\d*$/.test(aid)||/^BV[A-Za-z0-9]{10}$/.test(bvid),'稿件ID尚未返回，请刷新投稿状态；切片ID不能用于编辑');
    return /^[1-9]\d*$/.test(aid)?{aid}:{bvid};
  }
  function manuscriptData(data,identity,uid){
    const a=data?.archive;
    assert(a&&/^[1-9]\d*$/.test(String(a.aid))&&String(a.mid)===uid,'稿件归属无法确认，请检查当前账号');
    assert((!identity.aid||String(a.aid)===identity.aid)&&(!identity.bvid||a.bvid===identity.bvid),'返回稿件ID不一致，停止编辑');
    assert(['title','tag','desc','cover'].every(k=>typeof a[k]==='string')&&Number(a.tid)>0&&[1,2].includes(Number(a.copyright)),'稿件元数据不完整，停止编辑');
    assert(Array.isArray(data.videos)&&data.videos.length&&data.videos.every(v=>typeof v.filename==='string'&&v.filename&&typeof v.title==='string'),'视频列表尚未就绪，稍后刷新；不会覆盖空视频列表');
    return structuredClone(data);
  }
  function manuscriptFields(data){const {title,tag,desc}=data.archive;return {title,tag,desc};}
  function editTarget(data,operation={}){
    const before=manuscriptFields(data),out={...before};
    if(operation.title!==undefined)out.title=operation.title;
    else out.title=(operation.prefix||'')+(operation.find?before.title.split(operation.find).join(operation.replace||''):before.title)+(operation.suffix||'');
    if(operation.tags!==undefined)out.tag=uniqueTags(operation.tags).join(',');
    else if(operation.addTags?.length||operation.removeTags?.length){const remove=new Set(uniqueTags(operation.removeTags||[]).map(t=>t.normalize('NFC')));out.tag=uniqueTags([...before.tag.split(',').filter(t=>!remove.has(t.trim().normalize('NFC'))),...(operation.addTags||[])]).join(',');}
    if(operation.descMode==='replace')out.desc=operation.desc||'';
    if(operation.descMode==='append'&&operation.desc)out.desc=before.desc+(before.desc?'\n':'')+operation.desc;
    assert(typeof out.title==='string'&&out.title.trim()&&out.title.length<=80&&!/[\u0000-\u001f\u007f]/.test(out.title),'标题须为1–80字符，且不含换行或控制字符');
    out.title=out.title.trim();assert(typeof out.desc==='string','简介必须是文字');
    const tags=operation.tags||operation.addTags||[];
    assert(tags.every(t=>typeof t==='string'&&!/[,\r\n\u0000]/.test(t)),'每个标签不能包含英文逗号、换行或空字符');
    if(out.desc!==before.desc)assert(!data.archive.desc_v2?.length&&!data.desc_v2?.length,'此稿件使用富文本简介，请在创作中心编辑以保留提及等信息');
    return out;
  }
  function editPayload(data,target,csrf){
    assert(/^[0-9a-f]{32}$/i.test(csrf),'未取得有效CSRF');
    // Preserve the complete returned archive and auxiliary options, including all parts.
    const payload={...structuredClone(data),...structuredClone(data.archive),...target,csrf};
    delete payload.archive;payload.videos=structuredClone(data.videos);
    return payload;
  }
  const EDIT_LABEL={ready:'待确认',sending:'正在保存',verified:'已回读确认（审核状态另查）',accepted:'已受理，等待回读确认',unknown:'结果不明，禁止重发',rejected:'服务器拒绝，可重试固定目标',conflict:'数据已变化，请重新预览',failed:'发送前失败，可重试',cancelled:'已取消后续',unchanged:'没有变化'};
  class ManuscriptEditor {
    constructor(engine){this.engine=engine;this.env=engine.env;this.plans=new Map();this.running=false;this.stopped=false;}
    stop(){this.stopped=true;}
    async read(identity,uid){return manuscriptData(await this.engine.call('manuscript',identity),identity,uid);}
    async prepare(infos){
      assert(!this.running,'正在编辑，请等待当前队列结束');const uid=await this.engine.account(),items=[],seen=new Set();
      for(const info of infos){
        const identity=manuscriptIdentity(info),data=await this.read(identity,uid),aid=String(data.archive.aid);
        if(seen.has(aid))continue;seen.add(aid);items.push({aid,data});
      }
      assert(items.length,'请选择已有稿件');return {uid,items};
    }
    preview(session,operations){
      assert(!this.running,'正在编辑');const items=session.items.map(item=>({aid:item.aid,before:structuredClone(item.data),target:editTarget(item.data,operations[item.aid]||{})}));
      const token='edit-'+crypto.randomUUID(),plan={uid:session.uid,items};this.plans.set(token,structuredClone(plan));
      return {token,uid:plan.uid,items:structuredClone(items)};
    }
    async reconcile(uid,job){
      try{const current=await this.read({aid:job.aid},uid);if(stableJSON(manuscriptFields(current))===stableJSON(job.target)){job.state='verified';job.message='目标字段已回读确认';}}
      catch(error){job.message='回读未完成：'+error.message;}
      return job;
    }
    async execute(token,{confirmed=false,checkOnly=false,progress=()=>{}}={}){
      assert(confirmed||checkOnly,'需要明确确认后才能保存');assert(!this.running,'已有编辑队列正在运行');
      const plan=this.plans.get(token);assert(plan,'预览已失效，请重新预览');this.running=true;this.stopped=false;
      const results=[],report=job=>{results.push(structuredClone(job));try{progress(structuredClone(job));}catch(_){}};
      try{return await this.env.lock(plan.uid,async()=>{
        assert(await this.engine.account()===plan.uid,'登录账号已改变，请重新打开编辑器');
        const ledger=await this.engine.load(plan.uid);ledger.editJobs ||= {};
        for(const item of plan.items){
          let job=ledger.editJobs[item.aid];
          const save=async()=>{ledger.editJobs[item.aid]=job;await this.engine.write(plan.uid,ledger);};
          if(this.stopped){report({aid:item.aid,state:'cancelled'});continue;}
          if(job&&['sending','unknown','accepted'].includes(job.state)){
            if(job.state==='sending')job.state='unknown';await this.reconcile(plan.uid,job);await save();
            if(job.state!=='verified'){report(job);continue;}
          }
          if(checkOnly){report(job||{aid:item.aid,state:'ready'});continue;}
          if(job?.token===token&&job.state==='verified'){report(job);continue;}
          job={aid:item.aid,token,target:structuredClone(item.target),state:'ready'};
          try{
            await this.env.sleep(Math.max(1000,requestIntervalMs(this.env.interval?.())));
            if(this.stopped){job.state='cancelled';report(job);continue;}
            assert(await this.engine.account()===plan.uid,'登录账号已改变，停止保存');
            const current=await this.read({aid:item.aid},plan.uid);
            if(stableJSON(current)!==stableJSON(item.before)){job.state='conflict';job.message='预览后稿件发生变化，未提交';await save();report(job);continue;}
            if(stableJSON(manuscriptFields(current))===stableJSON(item.target)){job.state='unchanged';await save();report(job);continue;}
            const body=editPayload(current,item.target,this.env.csrf());
            if(this.stopped){job.state='cancelled';report(job);continue;}
            job.state='sending';await save(); // Journal before the only POST; reloads must never repeat it.
            if(this.stopped){job.state='cancelled';await save();report(job);continue;}
            try{await this.engine.call('editManuscript',body,'POST');job.state='accepted';}
            catch(error){job.state=error.apiCode!==undefined?'rejected':'unknown';job.message=error.message;}
            await save();
            if(['accepted','unknown'].includes(job.state)){await this.reconcile(plan.uid,job);await save();}
          }catch(error){if(job.state==='sending')job.state='unknown';else if(job.state==='ready')job.state='failed';job.message=error.message;}
          report(job);
        }
        return results;
      });}finally{this.running=false;}
    }
  }
  const core={cutTime,cutClock,parseDanmakuASS,minuteBuckets,validateCuts,splitAround,assURL,createASSReader,ManuscriptEditor,EDIT_LABEL,bracketTags,uniqueTags,stableJSON,manuscriptIdentity,manuscriptData,manuscriptFields,editTarget,editPayload,imageFailure,normalizeImage,stableCover,publishCoverURL,checkedImage,createImageReader,requestIntervalMs,createRequestTransport,validateTitleDrafts,parseCardDuration,matchPublishedCard,reversePublication,indexPublications,publicationInfo,relatedPublications,statusTone,randomFrameTimestamp,frameSelection,CACHE_POLICY,cleanStreams,sessionCoverage,matchSession,Engine,ROUTES,MAX,CHUNK,parseJSON,time,stamp,date,duration,title,makeClips,assignDailyNumbers,remoteConflict,payload};
  if(typeof module==='object'&&module.exports) {module.exports=core;return;}
  if(window.top!==window.self) return;
  const env={
    now:()=>Math.floor(Date.now()/1000),sleep,
    cacheRead:async uid=>parseJSON(GM_getValue('scan-cache-v3-'+uid,'{}')),
    cacheWrite:async(uid,value)=>GM_setValue('scan-cache-v3-'+uid,JSON.stringify(value)),
    csrf:()=>{const match=document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);return match?decodeURIComponent(match[1]):'';},
    read:async uid=>parseJSON(GM_getValue('ledger-v1-'+uid,'{"version":1,"tasks":{}}')),
    write:async(uid,ledger)=>{const key='ledger-v1-'+uid,value=JSON.stringify(ledger);GM_setValue(key,value);assert(GM_getValue(key,'')===value,'本地账本写入未确认，停止发送');},
    lock:async(uid,fn)=>{
      assert(navigator.locks,'此浏览器不支持跨标签页锁，已禁止投稿');
      return navigator.locks.request('bili-cloud-replay-'+uid,{ifAvailable:true},lock=>{assert(lock,'另一个标签页正在工作，请稍后再试');return fn();});
    },
    readASS:createASSReader({mode:()=>GM_getValue('request-mode-v1','page-fetch'),fetch:(...args)=>(typeof unsafeWindow==='object'?unsafeWindow:window).fetch(...args),controller:()=>new (typeof unsafeWindow==='object'?unsafeWindow:window).AbortController(),gm:details=>GM_xmlhttpRequest(details)}),
    readImage:createImageReader({report:meta=>engine.log({route:'cover-image',method:'GET',phase:'validated',...meta,message:`已下载 ${meta.imageBytes} 字节；响应类型 ${meta.sourceType}；文件头识别 ${meta.detectedType}，准备上传`}),mode:()=>GM_getValue('request-mode-v1','page-fetch'),fetch:(...args)=>(typeof unsafeWindow==='object'?unsafeWindow:window).fetch(...args),controller:()=>new (typeof unsafeWindow==='object'?unsafeWindow:window).AbortController(),gm:details=>GM_xmlhttpRequest(details)}),
    interval:()=>GM_getValue('request-interval-ms-v1',100),
    transport:()=>GM_getValue('request-mode-v1','page-fetch'),
    request:createRequestTransport({mode:()=>GM_getValue('request-mode-v1','page-fetch'),
      fetch:(...args)=>(typeof unsafeWindow==='object'?unsafeWindow:window).fetch(...args),
      controller:()=>new (typeof unsafeWindow==='object'?unsafeWindow:window).AbortController(),formData:()=>new (typeof unsafeWindow==='object'?unsafeWindow:window).FormData(),gm:details=>GM_xmlhttpRequest(details)})
  };
  const engine=new Engine(env);
  let host,root,plan=null,active=false,batchActive=false,invalid=false,tab='plan',ledger={version:1,tasks:{}},uid='',phase={text:'等待扫描'},filterText='',filterState='all';
  const chosen=new Set(),topics={},logs=[];
  const stored=GM_getValue('ui-v2','{}');
  let layout;try {layout=JSON.parse(stored);}catch(_){layout={};}
  layout={x:null,y:null,width:660,height:690,collapsed:false,...layout};if(layout.width<360)layout.width=660;if(layout.height<620)layout.height=690;
  let savedSettings={};try{savedSettings=JSON.parse(GM_getValue('settings-v3','{}'));}catch(_){}
  const settings={autoScan:true,...savedSettings};
  let reviewLayer=null,cancelReview=null,reviewRefresh=null,reviewRequests=null,reviewRefreshedCover=null;
  const PHASES={'cover-refresh':'重新取图','cover-upload':'准备封面','request-wait':'间隔等待',scanned:'只读预览',submit:'正在投稿',accepted:'正在投稿',submitted:'批次已提交',stopped:'已停止',refreshed:'状态已更新',error:'需处理'};
  function el(tag,text,cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,action,parent,cls) {const b=el('button',text,cls);b.type='button';b.onclick=action;parent.append(b);return b;}
  function link(text,url,parent) {const n=el('a',text);n.href=url;n.target='_blank';n.rel='noopener noreferrer';parent.append(n);return n;}
  const DETAIL_CSS=`.tone-green{color:#16834a!important}.tone-red{color:#c53b42!important}.tone-amber{color:#a56b0b!important}.tone-blue{color:#247da4!important}.pub-wrap{display:inline-block;vertical-align:middle}.pub-trigger{font-weight:650;text-decoration:none;border-bottom:1px dotted currentColor;cursor:pointer;margin:0}.publication-popover{position:fixed;z-index:2147483647;width:min(410px,calc(100vw - 24px));max-height:min(340px,65vh);overflow:auto;background:#fff;color:#344559;border:1px solid #d7e3ec;border-radius:9px;box-shadow:0 8px 30px #193a5540;padding:12px;font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif;text-align:left;white-space:normal}.publication-popover strong{display:block;color:#344559}.publication-info{padding:8px 0;border-bottom:1px solid #e8eef4;overflow-wrap:anywhere}.publication-info:last-child{border:0}.publication-popover small{display:block;color:#758798;font-size:11px}.publication-popover a{color:#008ab7;text-decoration:none}.publication-popover .tip-intro{font-size:11px;color:#72889a;margin-bottom:3px}.cover-row{display:grid;grid-template-columns:160px 1fr;gap:13px;align-items:start}.cover-preview{width:160px;height:90px;object-fit:contain;background:#edf2f6;border:1px solid #e0e8ef;border-radius:6px}.cover-info{min-width:0;overflow-wrap:anywhere}.cover-actions{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0}.cover-actions button{font-size:11px;padding:5px 8px}.cover-message{font-size:11px;line-height:1.5;margin-top:5px;color:#6d8193}.cover-message.error{color:#c53b42}.cover-tools{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap}.cover-progress{font-size:11px;color:#6d8193}.review-list{max-height:48vh!important}.review-list>div{padding:12px 0}dialog{width:min(760px,92vw)!important}[hidden]{display:none!important}@media(max-width:540px){.cover-row{grid-template-columns:1fr}.cover-preview{width:100%;height:auto;max-height:180px;aspect-ratio:16/9}}`;
  const TITLE_CSS=`.reset-task{font-size:11px!important;margin:6px 0 0 22px;color:#bc354a!important}.request-log{max-height:120px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;background:#f3f7fa;padding:8px}.review>details{margin-top:8px;font-size:11px}.review .cover-tools select{font-size:11px;margin-left:8px}.queue-result{font-size:12px;margin-top:8px;font-weight:600}.queue-message{font-size:12px;color:#45677e}.title-input:disabled{background:#f1f5f7!important}.retry-publish{color:#c53b42!important;border-color:#c53b42!important}.review-title-line{display:flex;align-items:center;gap:8px}.review-title-line label{font-size:12px;font-weight:650}.review-title-count{font-size:11px;color:#7c8f9e;margin-left:auto}.restore-title{font-size:10px!important;padding:3px 7px!important}.review .title-input{display:block;width:100%;margin:5px 0 2px;padding:7px 9px;border:1px solid #cedde7;border-radius:6px;color:#263e51;background:white;box-sizing:border-box;line-height:1.4;font-size:12px}.review .title-input[aria-invalid=true]{border-color:#c53b42;background:#fff8f8}.review-title-error{font-size:11px;color:#c53b42;min-height:0;margin-bottom:4px}.review-title-error:empty{display:none}`;
  let publicationTipNumber=0;
  function intervalControl(changed){
    const label=el('label','请求前间隔（ms）'),input=el('input');input.type='number';input.className='request-interval';input.min='0';input.max='60000';input.step='1';input.value=String(env.interval());input.setAttribute('aria-label','streams / publish 请求前间隔（毫秒）');input.title='在streams与publish请求发出前等待；默认100ms，0表示不等待。';input.style.width='88px';
    input.onchange=()=>{try{const ms=requestIntervalMs(input.value);GM_setValue('request-interval-ms-v1',ms);for(const n of root?.querySelectorAll('.request-interval')||[])n.value=String(ms);input.value=String(ms);changed?.();}catch(error){input.value=String(env.interval());message(error.message+'；已恢复原值。',true);}};
    label.append(input);return {label,input};
  }
  function publicationBadge(text,records=[],tone=statusTone(text)){
    if(!records.length)return el('span',text,'state '+tone);
    const wrap=el('span',undefined,'pub-wrap'),first=records[0];
    const href=info=>publicationInfo({avid:info.avid,bvid:info.bvid}).href;
    const trigger=link(text,href(first),wrap);trigger.className='pub-trigger state '+tone;trigger.title=`悬停或聚焦查看 ${records.length} 条已有投稿；点击打开${first.direct?'视频':'创作中心'}`;
    const popup=el('div',undefined,'publication-popover');popup.id='bcr-publication-'+(++publicationTipNumber);popup.hidden=true;popup.setAttribute('role','region');popup.setAttribute('aria-label','已有投稿详情');trigger.setAttribute('aria-describedby',popup.id);
    popup.append(el('div',`已有投稿 ${records.length} 条 · 点击标题跳转`,'tip-intro'));
    for(const info of records){const row=el('div',undefined,'publication-info');link(info.title,href(info),row);row.append(el('small',`${info.state}${info.match?' · '+info.match:''}`,'state '+statusTone(info.state)));
      if(Number.isFinite(info.start)&&Number.isFinite(info.end))row.append(el('small',`${stamp(info.start)} → ${stamp(info.end)}`));
      row.append(el('small',`切片 ${info.sliceId||'待返回'}${info.avid?' · av'+info.avid:''}`));
      if(info.reason)row.append(el('small',info.reason));if(info.direct)button('编辑稿件',()=>openManuscriptEditor([info]),row);if(!info.direct)row.append(el('small','稿件ID尚未返回，链接打开创作中心。'));popup.append(row);}
    wrap.append(popup);
    let closeTimer;
    function open(){clearTimeout(closeTimer);popup.hidden=false;popup.style.maxHeight='min(340px,65vh)';const rect=trigger.getBoundingClientRect();let box=popup.getBoundingClientRect();
      const below=innerHeight-rect.bottom-16,above=rect.top-16,useBelow=below>=box.height||below>=above;
      popup.style.maxHeight=Math.max(50,Math.min(box.height,useBelow?below:above))+'px';box=popup.getBoundingClientRect();
      popup.style.left=Math.max(12,Math.min(rect.left,innerWidth-box.width-12))+'px';popup.style.top=Math.max(8,useBelow?rect.bottom+4:rect.top-box.height-4)+'px';}
    function focused(){return wrap.contains(wrap.getRootNode().activeElement);}
    wrap.onmouseenter=open;wrap.onfocusin=open;popup.onmouseenter=()=>clearTimeout(closeTimer);wrap.onmouseleave=()=>{clearTimeout(closeTimer);closeTimer=setTimeout(()=>{if(!focused()&&!wrap.matches(':hover'))popup.hidden=true;},180);};wrap.onfocusout=()=>setTimeout(()=>{if(!focused()&&!wrap.matches(':hover'))popup.hidden=true;},0);
    trigger.onclick=e=>e.stopPropagation();popup.onclick=e=>e.stopPropagation();return wrap;
  }
  const manuscriptEditor=new ManuscriptEditor(engine);
  let editLayer=null;
  function openManuscriptEditor(infos){
    if(active||editLayer?.isConnected)return;
    const layer=el('div'),shadow=layer.attachShadow({mode:'open'}),dialog=el('dialog'),style=el('style');editLayer=layer;
    style.textContent=`dialog{box-sizing:border-box;width:min(900px,94vw);max-height:90vh;border:1px solid #ccdbe7;border-radius:12px;padding:22px;color:#243b50;font:14px/1.6 system-ui;background:#fff}dialog::backdrop{background:#10243d70}h2{margin-top:0}button,input,textarea,select{font:inherit}button{cursor:pointer;padding:6px 12px;margin:4px;border:1px solid #b9cedb;border-radius:6px;background:#f4f9fc;color:#176589}button:disabled{opacity:.5;cursor:default}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;padding:7px;border:1px solid #bdcdd9;border-radius:5px}textarea{min-height:70px}label{display:block;margin:8px 0}fieldset{margin:12px 0;border:1px solid #d5e1ea;border-radius:7px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f6f9;padding:12px}.status{color:#9c4d12}.actions{position:sticky;bottom:0;background:white;padding:8px 0}.candidates label{display:inline-flex;gap:5px;margin-right:12px}.candidates input[type=text]{width:150px}.hint{color:#586d7d;font-size:12px}`;
    const heading=el('h2',infos.length===1?'继续编辑稿件':'历史投稿批量编辑'),hint=el('p','先选择稿件并读取最新信息，再预览修改。保存可能触发重新审核；“已投稿”不代表审核通过。'),content=el('div'),notice=el('p','','status'),actions=el('div',undefined,'actions');notice.setAttribute('role','status');
    const transportLabel=el('label','请求方式'),editTransport=el('select');editTransport.setAttribute('aria-label','稿件编辑请求方式');
    for(const [value,text]of [['page-fetch','页面 fetch'],['extension-http','扩展 HTTP']]){const option=el('option',text);option.value=value;editTransport.append(option);}editTransport.value=env.transport();
    editTransport.onchange=()=>{GM_setValue('request-mode-v1',editTransport.value);invalidate();};transportLabel.append(editTransport,el('small',' 读取遇到 CORS 可手动改用扩展 HTTP；发送后不会自动切换重试。','hint'));
    dialog.append(heading,hint,transportLabel,content,notice,actions);shadow.append(style,dialog);document.body.append(layer);dialog.showModal();
    let busy=false,preview=null,session=null,entries=[],previewBox=null;
    const close=()=>{if(busy){manuscriptEditor.stop();notice.textContent='已停止后续任务，请等当前请求结束后关闭。';return;}layer.remove();editLayer=null;renderBusy();};
    dialog.oncancel=e=>{e.preventDefault();close();};button('关闭',close,actions);
    const stop=button('停止后续',()=>{manuscriptEditor.stop();notice.textContent='已请求停止，当前请求无法撤销。';},actions);stop.disabled=true;
    const setBusy=value=>{busy=value;active=value;editTransport.disabled=value;renderBusy();for(const n of content.querySelectorAll('button,input,textarea,select'))n.disabled=value||n.dataset.unavailable==='true';stop.disabled=!value;save.disabled=value||!preview;check.disabled=value||!preview;};
    const invalidate=()=>{preview=null;if(previewBox)previewBox.replaceChildren();save.disabled=true;check.disabled=true;notice.textContent='草稿已变化，请重新生成预览。';};
    async function work(fn){if(busy)return;setBusy(true);try{await fn();}catch(error){notice.textContent=error.message;}finally{setBusy(false);}}
    function field(parent,title,value='',multiline=false){const label=el('label',title),input=el(multiline?'textarea':'input');input.value=value;input.setAttribute('aria-label',title);input.oninput=invalidate;label.append(input);parent.append(label);return input;}
    const save=button('确认保存预览中的修改',()=>work(async()=>{
      const current=preview;if(!current)return;
      const results=await manuscriptEditor.execute(current.token,{confirmed:true,progress:job=>showResult(job)});
      notice.textContent=`已处理 ${results.length} 项；已受理和结果不明项仅允许回读核对。`;
    }),actions);save.disabled=true;
    const check=button('只核对保存结果',()=>work(async()=>{await manuscriptEditor.execute(preview.token,{checkOnly:true,progress:showResult});notice.textContent='核对完成；未确认结果的稿件不会重发。';}),actions);check.disabled=true;
    function showResult(job){const entry=entries.find(e=>e.aid===job.aid);if(entry)entry.result.textContent=(EDIT_LABEL[job.state]||job.state)+(job.message?' · '+job.message:'');}
    function renderEditor(){
      content.replaceChildren();entries=[];notice.textContent='已读取最新稿件。括号候选默认不选中；添加前可以修改文字。';
      if(session.items.length>1){
        const bulk=el('fieldset');bulk.append(el('legend','批量规则（先应用到下方草稿）'));
        const find=field(bulk,'标题查找文字'),replace=field(bulk,'替换为'),prefix=field(bulk,'标题前缀'),suffix=field(bulk,'标题后缀'),add=field(bulk,'追加标签（英文逗号分隔）'),remove=field(bulk,'移除标签（英文逗号分隔）'),desc=field(bulk,'批量简介', '',true),mode=el('select');mode.setAttribute('aria-label','批量简介操作');
        for(const [value,text]of [['keep','保留简介'],['append','追加简介'],['replace','替换简介']]){const option=el('option',text);option.value=value;mode.append(option);}mode.onchange=invalidate;bulk.append(mode);
        button('应用规则到草稿',()=>{try{
          // Always derive from the fetched base: clicking twice cannot double-append.
          const drafts=session.items.map(item=>editTarget(item.data,{find:find.value,replace:replace.value,prefix:prefix.value,suffix:suffix.value,addTags:add.value.split(','),removeTags:remove.value.split(','),descMode:mode.value,desc:desc.value}));
          entries.forEach((entry,i)=>{entry.title.value=drafts[i].title;entry.tags.value=drafts[i].tag;entry.desc.value=drafts[i].desc;entry.candidates.replaceChildren();});invalidate();
        }catch(error){notice.textContent=error.message;}},bulk);content.append(bulk);
      }
      for(const item of session.items){
        const box=el('fieldset');box.append(el('legend','av'+item.aid));const title=field(box,'标题 · av'+item.aid,item.data.archive.title),tags=field(box,'标签（英文逗号分隔） · av'+item.aid,item.data.archive.tag),desc=field(box,'视频简介 · av'+item.aid,item.data.archive.desc,true),candidates=el('div',undefined,'candidates'),result=el('p','','status');
        result.setAttribute('role','status');
        button('识别标题括号标签',()=>{candidates.replaceChildren();const values=bracketTags(title.value);if(!values.length)candidates.append(el('span','没有有效的括号候选'));for(const value of values){const label=el('label'),checked=el('input'),text=el('input');checked.type='checkbox';checked.setAttribute('aria-label','选择标签 '+value);text.type='text';text.value=value;text.setAttribute('aria-label','候选标签 '+value);label.append(checked,text);candidates.append(label);}if(values.length)button('追加已勾选候选到草稿',()=>{const selected=[...candidates.querySelectorAll('label')].filter(n=>n.querySelector('[type=checkbox]').checked).map(n=>n.querySelector('[type=text]').value);tags.value=uniqueTags([...tags.value.split(','),...selected]).join(',');invalidate();},candidates);},box);
        box.append(candidates,el('p','封面、分区、视频列表及其他设置保留。富文本简介请使用创作中心编辑。','hint'),result);link('打开创作中心','https://member.bilibili.com/platform/upload-manager/article',box);content.append(box);entries.push({aid:item.aid,title,tags,desc,candidates,result});
      }
      button('生成修改前后预览',()=>{try{
        const operations=Object.fromEntries(entries.map(e=>[e.aid,{title:e.title.value,tags:e.tags.value.split(','),descMode:'replace',desc:e.desc.value}]));preview=manuscriptEditor.preview(session,operations);previewBox.replaceChildren();
        for(const item of preview.items){const before=manuscriptFields(item.before),block=el('pre');block.textContent=`av${item.aid}\n标题：${before.title}\n→ ${item.target.title}\n标签：${before.tag}\n→ ${item.target.tag}\n简介：${before.desc}\n→ ${item.target.desc}`;previewBox.append(block);}
        save.disabled=false;check.disabled=false;notice.textContent='请核对下方全部变更，再点击“确认保存预览中的修改”。预览后服务器数据变化将标记冲突。';
      }catch(error){invalidate();notice.textContent=error.message;}},content);previewBox=el('div');content.append(previewBox);
    }
    const choices=[];
    for(const info of infos){const label=el('label'),input=el('input');input.type='checkbox';let valid=true;try{manuscriptIdentity(info);}catch(_){valid=false;}input.checked=valid&&infos.length===1;input.disabled=!valid;input.dataset.unavailable=String(!valid);label.append(input,document.createTextNode(info.title+' · '+info.state+(valid?'':' · 等待稿件ID，不能编辑')));content.append(label);choices.push({info,input,valid});}
    button('读取所选稿件',()=>work(async()=>{const selected=choices.filter(c=>c.valid&&c.input.checked).map(c=>c.info);assert(selected.length,'请先选择稿件');session=await manuscriptEditor.prepare(selected);renderEditor();}),content);
    renderBusy();
  }
  function sessionPublications(s){const rows=new Map((s.publications||[]).map(p=>[p.sliceId,p]));for(const c of plan?.clips.filter(c=>c.liveKey===s.liveKey)||[])for(const p of c.publications||[])rows.set(p.sliceId,p);return [...rows.values()];}
  function saveLayout(){GM_setValue('ui-v2',JSON.stringify(layout));}
  function applyLayout() {
    if(!host)return;
    const w=Math.min(layout.collapsed?310:Math.max(360,layout.width),innerWidth-20),h=layout.collapsed?56:Math.min(Math.max(620,layout.height),innerHeight-20);
    const x=Number.isFinite(layout.x)?layout.x:innerWidth-w-18,y=Number.isFinite(layout.y)?layout.y:innerHeight-h-18;
    host.style.width=w+'px';host.style.height=h+'px';host.style.left=Math.max(10,Math.min(x,innerWidth-w-10))+'px';host.style.top=Math.max(10,Math.min(y,innerHeight-h-10))+'px';
    host.style.resize=layout.collapsed?'none':'both';
    root.querySelector('.panel').classList.toggle('collapsed',layout.collapsed);
    root.querySelector('.toggle').textContent=layout.collapsed?'展开':'收起';
    root.querySelector('.toggle').setAttribute('aria-label',layout.collapsed?'展开回放助手':'收起回放助手');
  }
  function addLog(text,level='info') {
    logs.push({at:new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),text,level});if(logs.length>150)logs.shift();renderLogs();
  }
  function message(text,error=false) {lastMessage=text;queueInline();if(!root)return;const n=root.querySelector('.message');n.textContent=text;n.classList.toggle('error',error);n.setAttribute('role',error?'alert':'status');}
  function showProgress(event) {
    phase=event;queueInline();if(!root)return;
    if(event.stage==='stopped'||event.stage==='submitted')addLog(event.text);
    root.querySelector('.phase').textContent=PHASES[event.stage]||(active?'读取中':'只读预览');
    root.querySelector('.progress-label').textContent=event.text+(event.title?' · '+event.title:'');
    const p=root.querySelector('progress');p.max=event.total||1;p.value=event.done||0;
    if(!event.total)p.removeAttribute('value');
    root.querySelector('.progress-box').classList.toggle('idle',!active);
  }
  function syncLedger(account,next) {
    uid=account;const previous=ledger;ledger=structuredClone(next);
    for(const [key,t]of Object.entries(ledger.tasks))if(t.state!==previous.tasks[key]?.state&&['sending','accepted','processing','posted','unknown','remote_failed','rejected'].includes(t.state))addLog(`${t.clip?.title||'任务'}：${LABEL[t.state]||t.state}`,['unknown','remote_failed','rejected'].includes(t.state)?'error':'info');
    if(plan)for(const c of plan.clips){const t=ledger.tasks[c.key];if(t){if(t.approvedTitle&&t.attempts>0){c.automaticTitle=t.automaticTitle||c.automaticTitle||c.title;c.title=t.approvedTitle;}c.state=t.state;if(t.publications)c.publications=t.publications;c.message=c.planConflict?'固定编号发生冲突，请人工核对':t.message||'';c.blocked=!!c.planConflict||BLOCKED.has(t.state);if(c.blocked)chosen.delete(c.key);}}
    reviewRefresh?.();renderStats();if(tab==='tasks')renderTasks();else if(plan)renderPlan();
  }
  env.progress=event=>{showProgress(event);if(['cooldown','request-wait','cover-upload','cover-refresh'].includes(event.stage)&&reviewLayer?.isConnected){const n=reviewLayer.shadowRoot.querySelector('.queue-message');if(n)n.textContent=event.text+(event.title?' · '+event.title:'');}};
  env.ledger=syncLedger;env.coverRefresh=(key,choice)=>reviewRefreshedCover?.(key,choice);
  env.log=e=>{reviewRequests?.();if(e.error)addLog(`读取或提交未完成：${e.error}`,'error');};
  function renderStats() {
    queueInline();if(!root)return;
    const clips=plan?.clips||[],tasks=Object.values(ledger.tasks);
    root.querySelector('[data-stat=scenes]').textContent=plan?.sessions.length??'—';
    root.querySelector('[data-stat=ready]').textContent=clips.filter(c=>!c.blocked).length;
    root.querySelector('[data-stat=blocked]').textContent=clips.filter(c=>c.blocked).length;
    root.querySelector('[data-stat=processing]').textContent=tasks.filter(t=>['sending','accepted','processing'].includes(t.state)).length;
    root.querySelector('.account').textContent=uid?'当前账号 '+uid:'尚未读取账号';
    root.querySelector('.selection').textContent=`已选 ${chosen.size} 段`;
    root.querySelector('.publish-main').disabled=active||invalid||!chosen.size;
  }
  function renderBusy() {
    if(!root)return;for(const n of root.querySelectorAll('.request-interval')){n.value=String(env.interval());n.disabled=active||!!reviewLayer?.isConnected;}const transport=root.querySelector('.request-transport');if(transport){transport.value=env.transport();transport.disabled=active||!!reviewLayer?.isConnected;}
    for(const b of root.querySelectorAll('[data-work]'))b.disabled=active;for(const b of root.querySelectorAll('.reset-task'))b.disabled=active||invalid;
    for(const n of root.querySelectorAll('.session input,.clip input'))n.disabled=active||n.dataset.blocked==='true';
    root.querySelector('.stop').disabled=!batchActive;
    renderStats();
  }
  async function run(fn,label) {
    if(active)return;active=true;renderBusy();if(label)addLog(label);
    try{await fn();}catch(e){message(e.message,true);addLog(e.message,'error');showProgress({stage:'error',text:'操作未完成，请查看提示'});}
    finally{active=false;renderBusy();root.querySelector('.progress-box').classList.add('idle');}
  }
  async function scan(force=false,accountTicket) {
    invalid=true;message('正在读取回放和已有投稿，扫描不会投稿。');
    const ticket=accountTicket||await engine.prepareScan(),account=ticket.uid;
    if(uid&&uid!==account){chosen.clear();plan=null;ledger={version:1,tasks:{}};for(const key of Object.keys(topics))delete topics[key];}
    uid=account;
    let saved;try{saved=JSON.parse(GM_getValue('topics-v2-'+uid,'{}'));}catch(_){saved={};}Object.assign(topics,saved);
    plan=await engine.scan(topics,{force,accountTicket:ticket});for(const key of chosen)if(!plan.clips.some(c=>c.key===key&&!c.blocked))chosen.delete(key);invalid=false;tab='plan';render();
    message(`已读取 ${plan.sessions.length} 场回放。请选择片段，再点击“确认投稿”。`);addLog(`扫描完成：${plan.clips.filter(c=>!c.blocked).length}段待确认，${plan.clips.filter(c=>c.blocked).length}段已拦下。`);
  }
  function setTab(next){tab=next;for(const b of root.querySelectorAll('[data-tab]'))b.setAttribute('aria-selected',String(b.dataset.tab===tab));root.querySelector('.plan-view').hidden=tab!=='plan';root.querySelector('.tasks-view').hidden=tab!=='tasks';root.querySelector('.logs-view').hidden=tab!=='logs';if(tab==='tasks')renderTasks();if(tab==='logs')renderLogs();}
  function visibleSessions() {
    if(!plan)return[];
    return plan.sessions.slice().reverse().filter(s=>{
      const clips=plan.clips.filter(c=>c.liveKey===s.liveKey);
      return (!filterText||`${s.topic} ${date(s.start)}`.toLowerCase().includes(filterText.toLowerCase()))&&(filterState==='all'||clips.some(c=>filterState==='ready'?!c.blocked:c.blocked));
    });
  }
  function checkedInput(label,onChange,blocked=false,checked=false) {
    const c=el('input');c.type='checkbox';c.setAttribute('aria-label',label);c.dataset.blocked=String(blocked);c.disabled=blocked||active;c.checked=checked;c.onchange=()=>onChange(c.checked);return c;
  }
  function renderPlan() {
    if(!root)return;const list=root.querySelector('.list'),scroll=list.scrollTop;
    const open=new Set([...list.querySelectorAll('details[open]')].map(d=>d.dataset.key));
    const hadDetails=!!list.querySelector('details');list.replaceChildren();
    if(!plan){list.append(el('div','正在自动载入缓存并扫描回放，完成后可选择投稿。','empty'));return;}
    const sessions=visibleSessions();if(!sessions.length){list.append(el('div','没有符合筛选条件的场次。','empty'));return;}
    for(const s of sessions){
      const clips=plan.clips.filter(c=>c.liveKey===s.liveKey),available=clips.filter(c=>!c.blocked);
      const box=el('details',undefined,'session');box.dataset.key=s.liveKey;box.open=hadDetails?open.has(s.liveKey):true;
      const summary=el('summary'),left=el('div'),numbers=clips.map(c=>c.sequence),span=numbers.length?` · 序号${String(Math.min(...numbers)).padStart(2,'0')}–${String(Math.max(...numbers)).padStart(2,'0')}`:'';left.append(el('strong',s.topic),el('small',`${stamp(s.start)} · ${clips.length}段${span}`));summary.append(left,publicationBadge(s.error?'暂不可投稿':s.coverage?.status||'状态待核对',sessionPublications(s)));box.append(summary);
      const body=el('div',undefined,'session-body');
      const line=el('div',undefined,'session-actions'),group=el('label');
      const allSelected=available.length>0&&available.every(c=>chosen.has(c.key));
      group.append(checkedInput(`选择本场 ${s.topic} ${stamp(s.start)}`,on=>{for(const c of available)on?chosen.add(c.key):chosen.delete(c.key);renderPlan();renderStats();},!available.length,allSelected),document.createTextNode('选择本场'));line.append(group,el('span',`开播日期 ${date(s.start)}`,'muted'));body.append(line);
      const field=el('input');field.type='text';field.value=s.topic;field.maxLength=80;field.placeholder='自定义本场主题';field.setAttribute('aria-label',`主题 ${s.liveKey}`);field.disabled=active;
      field.onchange=()=>{topics[s.liveKey]=field.value;GM_setValue('topics-v2-'+uid,JSON.stringify(topics));invalid=true;chosen.clear();engine.snapshot=null;renderStats();message('本场主题已修改，请重新扫描后确认分段。');addLog('修改了直播主题，需要重新扫描。');};body.append(field);
      if(s.error)body.append(el('p',s.error,'note error'));
      for(const note of s.notes)body.append(el('p',note,'note'));
      for(const c of clips){
        const row=el('div',undefined,'clip'),label=el('label'),content=el('div',undefined,'clip-content');
        label.append(checkedInput(c.title,on=>{on?chosen.add(c.key):chosen.delete(c.key);renderStats();},c.blocked,chosen.has(c.key)));content.append(el('b',c.title),el('small',`${stamp(c.start)} → ${stamp(c.end)} · ${duration(c.end-c.start)}`));
        const status=c.blocked&&c.state==='ready'?'已拦下':LABEL[c.state]||c.state;content.append(publicationBadge(status,c.publications||[],statusTone(c.state))); if(c.message)content.append(el('small',c.message,'muted'));label.append(content);row.append(label);if(['rejected','remote_failed','duplicate'].includes(c.state)&&Number(ledger.tasks[c.key]?.attempts)>0)button('重置为待投稿',()=>run(()=>resetFailed([c.key]),'按初始检查及本地记录重置失败片段。'),row,'reset-task').disabled=active||invalid;body.append(row);
      }
      box.append(body);list.append(box);
    }
    list.scrollTop=scroll;renderBusy();
  }
  function renderTasks() {
    if(!root)return;const area=root.querySelector('.tasks-view');area.replaceChildren();
    button('历史投稿批量编辑…',()=>openManuscriptEditor(plan?.published||[]),area).disabled=active||!plan?.published?.length;
    const tasks=Object.values(ledger.tasks).filter(t=>t.clip&&Number(t.attempts)>0).sort((a,b)=>(b.updated||0)-(a.updated||0));
    if(!tasks.length){area.append(el('div','本地暂无提交任务。服务器已有内容会在回放计划中拦下。','empty'));return;}
    for(const t of tasks){const card=el('div',undefined,'task');card.append(el('strong',t.clip.title),publicationBadge(LABEL[t.state]||t.state,t.publications||[],statusTone(t.state)),el('small',`${stamp(t.clip.start)} → ${stamp(t.clip.end)}`));if(t.message)card.append(el('p',t.message,'note'));if(t.avid)button('继续编辑稿件',()=>openManuscriptEditor([{avid:t.avid,title:t.clip.title,state:LABEL[t.state]}]),card);if(t.avid)link('查看视频（转码审核后可播放）','https://www.bilibili.com/video/av'+encodeURIComponent(t.avid),card);link('创作中心','https://member.bilibili.com/platform/upload-manager/article',card);if(['rejected','remote_failed','duplicate'].includes(t.state))button('重置为待投稿',()=>run(()=>resetFailed([t.clip.key]),'按初始检查及本地记录重置失败任务。'),card,'reset-task').disabled=active||invalid;area.append(card);}
  }
  function renderLogs(){if(!root)return;const area=root.querySelector('.log-lines');if(!area)return;area.replaceChildren();if(!logs.length)area.append(el('p','尚无操作记录。','muted'));for(const log of logs.slice().reverse())area.append(el('div',`${log.at}  ${log.text}`,'log '+log.level));}
  function render(){if(!root)return;renderPlan();renderStats();renderTasks();renderLogs();setTab(tab);}
  function selectOldest(){
    if(!plan||invalid){message('请先扫描回放。');return;}
    const s=plan.sessions.slice().sort((a,b)=>a.start-b.start).find(s=>{const c=plan.clips.filter(c=>c.liveKey===s.liveKey);return !s.error&&c.length&&c.reduce((n,x)=>n+x.end-x.start,0)>=60&&c.every(x=>!x.blocked);});
    if(!s){message('没有完整可投稿的正常场次。请查看重叠或标题冲突提示。');return;}
    chosen.clear();for(const c of plan.clips.filter(c=>c.liveKey===s.liveKey))chosen.add(c.key);
    filterText='';filterState='all';root.querySelector('.search').value='';root.querySelector('.filter-state').value='all';renderPlan();renderStats();message(`已选择 ${s.topic} · ${stamp(s.start)}，共${chosen.size}段，尚未投稿。`);
    root.querySelector(`details[data-key="${s.liveKey}"]`)?.scrollIntoView({block:'nearest'});
  }
  function download(name,value){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  async function refresh(){const account=engine.scannedAccount();if(uid&&account!==uid)throw new Error('账号已改变，请重新扫描');const l=await engine.reconcile();syncLedger(account,l);message('任务状态已刷新。“已投稿”仍需等待转码和审核。');showProgress({stage:'refreshed',text:'任务状态已刷新',done:1,total:1});addLog('已刷新投稿任务状态。');}
  let timingLayer=null,cancelTiming=null;
  function timingEditor(snapshot,liveKey,selectedKeys,onApplied) {
    if(timingLayer)return;const session=snapshot.sessions.find(s=>s.liveKey===liveKey),original=snapshot.clips.filter(c=>selectedKeys.includes(c.key)&&c.liveKey===liveKey);
    let cuts=original.map(c=>({start:c.start,end:c.end,topic:c.topic})),rows=[],closed=false,busy=false,page=0,minute=null;
    const layer=el('div'),shadow=layer.attachShadow({mode:'open'}),dialog=el('dialog'),style=el('style');timingLayer=layer;layer.id='bcr-timing';
    style.textContent=`:host{font:14px/1.5 system-ui;color:#263445}*{box-sizing:border-box}dialog{width:min(1000px,95vw);max-height:92vh;overflow:auto;border:1px solid #d9e3ed;border-radius:14px;padding:22px;color:#263445}dialog::backdrop{background:#12243599}button,input{font:inherit}button{padding:6px 10px;margin:3px;border:1px solid #cad8e4;border-radius:6px;background:white;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}input{padding:5px;border:1px solid #cad8e4;border-radius:5px}input[type=range]{width:100%;accent-color:#00a1d6;padding:0}input[type=text]{max-width:100%}.bar{position:relative;height:56px;margin:12px 0;background:#eef6fa;border-radius:6px}.bar button{position:absolute;top:4px;margin:0;transform:translateX(-50%);padding:2px;min-width:8px;background:#87cfe7;font-size:10px}.segments{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:10px}.segment{padding:12px;border:1px solid #dae5ed;border-radius:8px;background:#f8fbfd}.segment label{display:block;margin:5px 0}.segment input[type=text]{width:120px}.segment .topic{width:100%!important}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{text-align:left;padding:7px;border-bottom:1px solid #e6edf3;overflow-wrap:anywhere;white-space:pre-wrap}th:first-child{width:100px}th:nth-child(2){width:120px}th:last-child{width:100px}.notice{white-space:pre-wrap;color:#926021}.note{font-size:12px;color:#6b7c8c}h3{margin-top:0}.primary{background:#00a1d6;color:white}.list{max-height:320px;overflow:auto}`;

    style.textContent+=`:host{font:13px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#263747}dialog{width:min(1120px,96vw);padding:28px;background:#f7f9fc;border:1px solid #e1e8f0;border-radius:20px;box-shadow:0 24px 90px #152b4940}dialog::backdrop{background:#10253899;backdrop-filter:blur(4px)}h3{font-size:23px;letter-spacing:-.5px;margin:0 0 6px}h4{font-size:14px;margin:22px 0 10px}button,input,select{font:inherit;transition:background .15s,box-shadow .15s}button{border-color:#e0e7ef;padding:7px 12px;margin:3px 3px 3px 0}button:hover{background:#edf6fc}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #85c9ee;outline-offset:3px}input,select{border:1px solid #dce5ee;background:#fff;border-radius:7px;padding:7px 9px;color:#293e52}input[type=checkbox]{accent-color:#008fbd}.note{color:#75859a}.timeline-panel{background:#fff;border:1px solid #e0e8f0;border-radius:14px;padding:18px 24px 10px;margin:20px 0;box-shadow:0 3px 12px #183c6210}.timeline-header{display:flex;gap:14px;align-items:center}.timeline-header strong{font-size:15px}.timeline-header select{margin-left:auto}.axis-scroll{overflow-x:auto;padding:18px 12px 4px;margin:0 -12px}.axis-canvas{min-width:800px}.cut-axis{height:120px;position:relative;margin:0 0 6px;background:repeating-linear-gradient(90deg,transparent,transparent calc(12.5% - 1px),#eef2f7 calc(12.5% - 1px),#eef2f7 12.5%)}.tick{position:absolute;top:0;transform:translateX(-50%);font:11px ui-monospace,monospace;color:#7b8d9f}.tick:first-child{transform:none}.tick:nth-child(9){transform:translateX(-100%)}.cut-band{position:absolute;top:40px;height:62px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:18px 10px;background:hsl(var(--hue) 65% 92%);color:hsl(var(--hue) 65% 29%);border:1px solid hsl(var(--hue) 50% 80%);font-weight:650;border-radius:6px}.boundary{position:absolute!important;top:32px!important;bottom:auto!important;height:78px;width:16px;min-width:16px!important;transform:translateX(-50%);margin:0!important;padding:0!important;border:2px solid white!important;background:#168eb7!important;box-shadow:0 1px 5px #1b52665c;border-radius:6px!important;z-index:2;color:white;cursor:ew-resize;touch-action:none;user-select:none}.boundary:hover,.boundary:focus,.boundary.dragging{background:#096984!important;z-index:4}.boundary-time{display:none;position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);background:#19364c;color:#fff;border-radius:5px;padding:3px 8px;font:11px ui-monospace,monospace;pointer-events:none}.boundary:hover .boundary-time,.boundary:focus .boundary-time,.boundary.dragging .boundary-time{display:block}.bar{height:30px;background:#f2f7fb;margin:0;border-radius:5px}.bar:empty:after{content:'读取弹幕后将在这里显示时间节点';font-size:11px;color:#8b9bae;padding-left:10px}.bar button{border:0;border-radius:4px;padding:1px 5px;background:#b9e3f1;color:#236b83;top:4px}.segments{grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:12px}.segment{background:white;border:1px solid #e2e9f1;border-top:3px solid hsl(var(--hue) 60% 62%);border-radius:10px;padding:14px;position:relative}.cut-duration{float:right;color:#7890a4;font:12px ui-monospace,monospace;padding-top:3px}.segment .topic{margin:10px 0 6px}.time-inputs{display:flex;gap:10px}.time-inputs label{font-size:11px;color:#8191a1;flex:1;min-width:0}.time-inputs input{display:block;width:100%!important;font:13px ui-monospace,monospace;color:#2c475d;margin-top:3px}.segment button{font-size:11px;padding:5px 7px}.list{background:#fff;border:1px solid #e1e8f0;border-radius:10px}th{background:#f0f5f9;color:#627b90;font-size:11px;position:sticky;top:0}td{font-size:12px}.sticky-actions{position:sticky;bottom:-28px;padding:14px 0;margin-bottom:-28px;background:#f7f9fcf5;border-top:1px solid #e1e8f0;justify-content:flex-end;z-index:5}.primary{background:#098eB8!important;border-color:#098eb8;color:white;box-shadow:0 2px 5px #0c84a82b}.notice:empty{display:none}.notice{padding:10px 12px;background:#fff7e8;border-radius:8px}.timeline-panel>.note{white-space:pre-line;max-height:100px;overflow:auto}@media(max-width:600px){dialog{padding:16px}.timeline-panel{padding:14px}.timeline-header .note{display:none}.sticky-actions{bottom:-16px;margin-bottom:-16px;flex-wrap:wrap}th:nth-child(2){width:75px}th:last-child{width:80px}.segments{grid-template-columns:1fr}}`;
    const heading=el('h3','弹幕与切片 · '+session.topic),intro=el('p',`时间均相对本场开播 ${stamp(session.start)}。修改仅影响本次计划，重新扫描会恢复自动分段。范围或主题改变后重新生成标题与封面；未改变的片段保留标题草稿。编辑时可临时超长，标红片段须拆至 1:59:50 内才能应用；专题段拆分当前段，可删除不需要的前后部分。`,'note');
    const notice=el('p','','notice'),segments=el('div',undefined,'segments'),bar=el('div',undefined,'bar'),hover=el('p','时轴按分钟聚集弹幕，悬停查看摘要，点击筛选该分钟。','note');
    const timeline=el('section',undefined,'timeline-panel'),axisScroll=el('div',undefined,'axis-scroll'),axisCanvas=el('div',undefined,'axis-canvas'),axis=el('div',undefined,'cut-axis');
    const timelineHeader=el('div',undefined,'timeline-header');timelineHeader.append(el('strong','剪辑时间轴'),el('span','拖动分界 · 相邻两段同步调整','note'));const zoom=el('select');zoom.setAttribute('aria-label','时间轴缩放');for(const n of [1,2,4,8]){const option=el('option',n+'×');option.value=n;zoom.append(option);}zoom.onchange=()=>{axisCanvas.style.width=(Number(zoom.value)*100)+'%';};timelineHeader.append(zoom);axisCanvas.append(axis,bar);axisScroll.append(axisCanvas);timeline.append(timelineHeader,axisScroll,hover);
    const controls=el('div',undefined,'row'),read=button('读取本场弹幕',async()=>{if(busy)return;busy=true;read.disabled=true;notice.textContent='正在读取弹幕…';try{const result=await engine.danmaku(liveKey,snapshot.token);if(closed)return;rows=result.rows;confirmed.checked=false;page=0;minute=null;notice.textContent=`读取 ${rows.length} 条，跳过 ${result.skipped} 条。请核对 ASS 时间零点后勾选校准确认；缺失用户名显示“未提供”。`;drawDanmaku();}catch(e){if(!closed)notice.textContent=e.message;}finally{busy=false;read.disabled=false;}},controls);
    const file=el('input');file.type='file';file.accept='.ass,.ssa';file.setAttribute('aria-label','导入 ASS 弹幕文件');file.onchange=async()=>{const f=file.files[0];if(!f)return;try{assert(f.size<=8*1024*1024,'文件超过 8 MiB');const result=parseDanmakuASS(await f.text());if(closed)return;rows=result.rows;confirmed.checked=false;page=0;minute=null;notice.textContent=`导入 ${rows.length} 条，跳过 ${result.skipped} 条；请核对时间零点。`;drawDanmaku();}catch(e){notice.textContent=e.message;}};controls.append(file);
    const calibration=el('div',undefined,'row'),origin=el('input');origin.type='number';origin.step='1';origin.value='0';origin.style.width='100px';origin.setAttribute('aria-label','ASS 零点相对开播秒数');const originLabel=el('label','ASS 零点相对开播（秒，可为负）：');originLabel.append(origin);const confirmed=el('input');confirmed.type='checkbox';const confirmLabel=el('label',' 已核对弹幕与录像的时间对应');confirmLabel.prepend(confirmed);calibration.append(originLabel,confirmLabel);
    calibration.append(el('span',session.missingSeconds?'本场存在录像缺口：拼接播放器时间可能不等于开播相对时间。请分段核对，无法用固定偏移对应时不要按弹幕切片。':'默认按开播时刻为 ASS 零点，请先对照官方回放核对。','note'));
    origin.oninput=()=>{confirmed.checked=false;page=0;minute=null;drawDanmaku();};confirmed.onchange=drawDanmaku;
    const highlights=el('div',undefined,'row'),before=el('input'),after=el('input'),topic=el('input');
    for(const [input,label,value]of [[before,'弹幕前（秒）','60'],[after,'弹幕后（秒）','30']]){input.type='number';input.min='0';input.max=String(CHUNK);input.step='1';input.value=value;input.style.width='90px';input.setAttribute('aria-label',label);const l=el('label',label);l.append(input);highlights.append(l);}
    topic.type='text';topic.placeholder='专题主题，如：通过第三关';topic.setAttribute('aria-label','专题主题');highlights.append(topic);
    const search=el('input');search.type='text';search.placeholder='搜索用户或弹幕';search.setAttribute('aria-label','搜索用户或弹幕');const filter=el('div',undefined,'row');filter.append(search);button('显示全部分钟',()=>{minute=null;page=0;drawDanmaku();},filter);search.oninput=()=>{page=0;drawDanmaku();};
    const list=el('div',undefined,'list'),pager=el('div',undefined,'row');
    function mapping(){const n=Number(origin.value);assert(origin.value.trim()&&Number.isSafeInteger(n),'时间偏移必须为整数秒');return n;}
    function drawDanmaku(){
      bar.replaceChildren();list.replaceChildren();pager.replaceChildren();let shift;try{shift=mapping();}catch(e){notice.textContent=e.message;return;}
      const buckets=minuteBuckets(rows,shift,session.end-session.start);
      for(const [min,items]of buckets){const b=button(String(items.length),()=>{minute=min;page=0;drawDanmaku();},bar);b.style.left=((min*60+30)/(session.end-session.start)*100).toFixed(3)+'%';b.style.left=`clamp(8px, ${b.style.left}, calc(100% - 8px))`;b.title=`${cutClock(min*60)} · ${items.length} 条\n`+items.slice(0,12).map(r=>`${cutClock(r.offset)} ${r.user}：${r.text}`).join('\n')+(items.length>12?'\n点击查看本分钟全部弹幕':'');b.onmouseenter=b.onfocus=()=>{hover.textContent=b.title;};b.setAttribute('aria-label',`${cutClock(min*60)}，${items.length} 条弹幕`);}
      const q=search.value.toLocaleLowerCase(),filtered=rows.map(r=>({...r,relative:r.offset+shift})).filter(r=>(minute===null||Math.floor(r.relative/60)===minute)&&(!q||(r.user+' '+r.text).toLocaleLowerCase().includes(q)));page=Math.min(page,Math.max(0,Math.ceil(filtered.length/50)-1));
      const table=el('table'),head=el('tr');for(const label of ['开播后时间','用户','弹幕','专题片段'])head.append(el('th',label));table.append(head);
      for(const row of filtered.slice(page*50,page*50+50)){const tr=el('tr'),at=row.relative;tr.append(el('td',at<0?'-'+cutClock(-at):cutClock(at)),el('td',row.user),el('td',row.text));const td=el('td'),b=button('拆出片段',()=>{
        try{assert(confirmed.checked,'请先核对时间对应');const pre=Number(before.value),post=Number(after.value);assert(before.value!==''&&after.value!==''&&Number.isInteger(pre)&&Number.isInteger(post)&&pre>=0&&post>=0&&pre+post>0,'前后时长必须为非负整数，总长度大于零');const absolute=session.start+Math.floor(at),index=cuts.findIndex(c=>absolute>=c.start&&absolute<c.end);assert(index>=0,'此弹幕不在当前待投稿片段内');const c=cuts[index],start=Math.max(c.start,absolute-pre),end=Math.min(c.end,absolute+post);const next=splitAround(cuts,index,start,end,topic.value);validateCuts(session,next,true);cuts=next;drawCuts();notice.textContent=`已拆出 ${cutClock(start-session.start)}–${cutClock(end-session.start)}${start>absolute-pre||end<absolute+post?'（已截断到当前段边界）':''}。请核对分段，应用后仍需确认投稿。`;}catch(e){notice.textContent=e.message;}
      },td);b.disabled=!confirmed.checked||at<0||at>=session.end-session.start;tr.append(td);table.append(tr);}list.append(table);if(!filtered.length)list.append(el('p','暂无匹配弹幕。可读取本场弹幕或导入 ASS。'));
      const prev=button('上一页',()=>{page--;drawDanmaku();},pager);prev.disabled=page===0;pager.append(el('span',`${filtered.length} 条 · 第 ${page+1}/${Math.max(1,Math.ceil(filtered.length/50))} 页${minute===null?'':' · '+cutClock(minute*60)}`));const next=button('下一页',()=>{page++;drawDanmaku();},pager);next.disabled=(page+1)*50>=filtered.length;
    }
    function boundary(index,field){
      const c=cuts[index],adjIndex=field==='start'?index-1:index+1,other=field==='start'?'end':'start',linked=cuts[adjIndex]?.[other]===c[field];
      const range=merge(original.map(c=>[c.start,c.end])).find(([a,b])=>c.start>=a&&c.end<=b);
      let min=field==='start'?range[0]:c.start+1,max=field==='start'?c.end-1:range[1];
      if(linked){const adj=cuts[adjIndex];if(field==='start')min=Math.max(min,adj.start+1);else max=Math.min(max,adj.end-1);}
      else if(cuts[adjIndex]){if(field==='start')min=Math.max(min,cuts[adjIndex].end);else max=Math.min(max,cuts[adjIndex].start);}
      return {min,max,linked,adjIndex,other};
    }
    function moveBoundary(index,field,n,clamp=false){
      const bounds=boundary(index,field);if(clamp)n=Math.max(bounds.min,Math.min(bounds.max,n));
      assert(Number.isInteger(n)&&n>=bounds.min&&n<=bounds.max,'分界超出可用范围或片段过短');
      const next=cuts.map(c=>({...c}));next[index][field]=n;if(bounds.linked)next[bounds.adjIndex][bounds.other]=n;
      validateCuts(session,next,true);cuts=next;return n;
    }
    function drawAxis(){
      axis.replaceChildren();const length=session.end-session.start;
      for(let i=0;i<=8;i++){const tick=el('span',cutClock(length*i/8),'tick');tick.style.left=(i/8*100)+'%';axis.append(tick);}
      cuts.forEach((c,index)=>{const band=el('div',`${String(index+1).padStart(2,'0')} · ${c.topic}`,'cut-band');band.dataset.index=index;band.style.setProperty('--hue',String(195+index%4*18));axis.append(band);});
      const handles=[];cuts.forEach((c,index)=>{if(!index||cuts[index-1].end!==c.start)handles.push([index,'start']);handles.push([index,'end']);});
      for(const [index,field]of handles){const limits=boundary(index,field),shared=limits.linked,h=el('button','⋮','boundary');h.type='button';h.setAttribute('role','slider');h.dataset.index=index;h.dataset.field=field;h.setAttribute('aria-label',shared?`片段 ${index+1} 与 ${limits.adjIndex+1} 的分界`:`片段 ${index+1} ${field==='start'?'起点':'终点'}`);h.setAttribute('aria-valuemin',String(limits.min-session.start));h.setAttribute('aria-valuemax',String(limits.max-session.start));const tip=el('span','','boundary-time');h.append(tip);axis.append(h);
        const finish=()=>{drawCuts();axis.querySelector(`[data-index="${index}"][data-field="${field}"]`)?.focus({preventScroll:true});};
        h.onkeydown=e=>{let n=cuts[index][field],step=e.shiftKey?10:1;if(['ArrowLeft','ArrowDown'].includes(e.key))n-=step;else if(['ArrowRight','ArrowUp'].includes(e.key))n+=step;else if(e.key==='Home')n=boundary(index,field).min;else if(e.key==='End')n=boundary(index,field).max;else return;e.preventDefault();moveBoundary(index,field,n,true);finish();};
        h.onpointerdown=e=>{if(e.button!==0||busy)return;e.preventDefault();const initial=cuts.map(c=>({...c})),rect=axis.getBoundingClientRect(),pointer=e.pointerId;h.focus({preventScroll:true});try{h.setPointerCapture(pointer);}catch(_){}h.classList.add('dragging');
          const move=event=>{if(event.pointerId!==pointer)return;const n=session.start+Math.round((event.clientX-rect.left)/rect.width*length);moveBoundary(index,field,n,true);drawCuts(false);paintAxis();notice.textContent='拖动分界会同步更新相邻两段；方向键微调 1 秒，Shift + 方向键微调 10 秒。';};
          const end=event=>{if(event.pointerId!==pointer)return;if(event.type==='pointercancel')cuts=initial;h.onpointermove=h.onpointerup=h.onpointercancel=h.onlostpointercapture=null;try{h.releasePointerCapture(pointer);}catch(_){}finish();};h.onpointermove=move;h.onpointerup=h.onpointercancel=h.onlostpointercapture=end;
        };
      }paintAxis();
    }
    function paintAxis(){
      const length=session.end-session.start;for(const band of axis.querySelectorAll('.cut-band')){const c=cuts[Number(band.dataset.index)];band.style.left=((c.start-session.start)/length*100)+'%';band.style.width=((c.end-c.start)/length*100)+'%';}
      for(const h of axis.querySelectorAll('.boundary')){const n=cuts[Number(h.dataset.index)][h.dataset.field];h.style.left=((n-session.start)/length*100)+'%';h.setAttribute('aria-valuenow',String(n-session.start));h.setAttribute('aria-valuetext',cutClock(n-session.start));h.querySelector('span').textContent=cutClock(n-session.start);}
    }
    function drawCuts(redraw=true){
      segments.replaceChildren();cuts.forEach((c,index)=>{
        const box=el('div',undefined,'segment');box.style.setProperty('--hue',String(195+index%4*18));box.append(el('b',`片段 ${String(index+1).padStart(2,'0')}`),el('small',cutClock(c.end-c.start),'cut-duration'));const theme=el('input');theme.type='text';theme.className='topic';theme.value=c.topic;theme.setAttribute('aria-label',`片段 ${index+1} 主题`);theme.oninput=()=>{c.topic=theme.value;const band=axis.querySelector(`.cut-band[data-index="${index}"]`);if(band)band.textContent=`${String(index+1).padStart(2,'0')} · ${c.topic}`;};box.append(theme);if(c.end-c.start>CHUNK){box.style.borderColor='#dc6475';box.append(el('p','超过 1:59:50，请继续拆分后再应用。','notice'));}
        const times=el('div',undefined,'time-inputs');for(const [field,label]of [['start','开始'],['end','结束']]){
          const l=el('label',label+' '),text=el('input');text.type='text';text.value=cutClock(c[field]-session.start);text.setAttribute('aria-label',`片段 ${index+1} ${label}时间`);
          text.onchange=()=>{try{moveBoundary(index,field,session.start+cutTime(text.value));notice.textContent='分界已调整，相邻片段时间已同步。';drawCuts();}catch(e){notice.textContent=e.message;text.value=cutClock(c[field]-session.start);}};l.append(text);times.append(l);
        }box.append(times);
        button('从中间分成两段',()=>{try{const mid=Math.floor((c.start+c.end)/2);assert(mid>c.start,'片段过短');const next=splitAround(cuts,index,c.start,mid,c.topic);validateCuts(session,next,true);cuts=next;drawCuts();}catch(e){notice.textContent=e.message;}},box);
        const remove=button('移除此段',()=>{cuts.splice(index,1);drawCuts();},box);remove.disabled=cuts.length===1;segments.append(box);
      });const long=cuts.filter(c=>c.end-c.start>CHUNK);apply.disabled=busy||long.length>0;apply.title=long.length?'请先拆分标红的超长片段':'';if(redraw){drawAxis();drawDanmaku();}
    }
    const actions=el('div',undefined,'row');const close=()=>{if(busy){notice.textContent='正在读取或应用，请稍后关闭。';return;}closed=true;layer.remove();timingLayer=null;cancelTiming=null;};cancelTiming=()=>{closed=true;layer.remove();timingLayer=null;cancelTiming=null;};
    button('取消调整',close,actions);button('重置本次调整',()=>{cuts=original.map(c=>({start:c.start,end:c.end,topic:c.topic}));drawCuts();},actions);
    const apply=button('应用分段并重新确认投稿',async()=>{if(busy||closed)return;busy=true;apply.disabled=true;try{const result=await engine.reviseCuts(snapshot.token,original.map(c=>c.key),liveKey,cuts);if(closed)return;busy=false;close();onApplied(result);}catch(e){notice.textContent=e.message;}finally{busy=false;apply.disabled=false;}},actions);apply.className='primary';
    actions.classList.add('sticky-actions');dialog.append(heading,intro,timeline,el('h4','片段详情'),segments,el('h4','弹幕素材'),controls,calibration,highlights,filter,list,pager,notice,actions);dialog.oncancel=e=>{e.preventDefault();close();};shadow.append(style,dialog);document.body.append(layer);drawCuts();drawDanmaku();dialog.showModal();
  }
  function review(preservedDrafts={}){
    if(reviewLayer?.isConnected||active||invalid||!plan||!chosen.size)return;
    const snapshot=plan,clips=[...chosen].map(k=>plan.clips.find(c=>c.key===k)).sort((a,b)=>(a?.start||0)-(b?.start||0)),keys=clips.map(c=>c?.key);
    if(clips.some(c=>!c||c.blocked)){message('所选片段已被拦下，请重新扫描。',true);return;}
    let closed=false,running=false,started=false,stopRequested=false,session;try{session=engine.beginReview(snapshot.token,keys);}catch(error){message(error.message,true);return;}const entries=[],dialog=el('dialog'),body=el('div',undefined,'review');
    body.append(el('h3',`确认投稿 ${clips.length} 段`),el('p',`使用当前账号 ${snapshot.uid} 向B站投稿。可逐段修改标题、补充主题，请核对标题、时间和封面；将按窗口顺序逐段发布，失败先跳过，成功后视频可能公开可见。`),el('p','默认使用自动标题，可保留日期、序号并补充本段主题。封面时间自动保存；临时图片在确认后先上传为稳定地址，再投稿。随机取帧不会投稿，标题首尾空格会去除。','note'));
    const tools=el('div',undefined,'cover-tools'),progress=el('span','','cover-progress');button('全部使用默认封面',()=>{for(const entry of entries)useDefault(entry);},tools);tools.append(progress);body.append(tools);
    const timingButtons=[];for(const liveKey of new Set(clips.map(c=>c.liveKey))){const b=button('弹幕与切片 · '+(snapshot.sessions.find(s=>s.liveKey===liveKey)?.topic||liveKey),()=>{if(started||running)return;timingEditor(snapshot,liveKey,keys,result=>{const drafts=Object.fromEntries(entries.filter(e=>result.plan.clips.some(c=>c.key===e.clip.key&&c.topic===e.clip.topic)).map(e=>[e.clip.key,e.titleInput.value]));close();plan=result.plan;for(const c of clips.filter(c=>c.liveKey===liveKey))chosen.delete(c.key);for(const key of result.keys)chosen.add(key);render();review(drafts);});},tools);timingButtons.push(b);}
    const transportLine=el('div',undefined,'cover-tools'),transportLabel=el('label','请求方式'),transportSelect=el('select');
    for(const [value,text]of [['page-fetch','页面 fetch（Network可见）'],['extension-http','扩展 HTTP（旧方式）']]){const option=el('option',text);option.value=value;transportSelect.append(option);}
    transportSelect.value=env.transport();transportSelect.onchange=()=>{if(running)return;GM_setValue('request-mode-v1',transportSelect.value);requestHint.textContent=transportSelect.value==='page-fetch'?'F12 → Network → Fetch/XHR，筛选 AnchorPublishVideoSlice；不会自动切换请求方式。':'扩展后台HTTP请求，页面Network可能看不到。可在下方查看脱敏记录。';};
    const requestHint=el('span',transportSelect.value==='page-fetch'?'F12 → Network → Fetch/XHR，筛选 AnchorPublishVideoSlice。':'扩展后台HTTP请求，页面Network可能看不到。','note');transportLabel.append(transportSelect);transportLine.append(transportLabel,requestHint);body.append(transportLine);const interval=intervalControl(()=>update());transportLine.append(interval.label,el('small','扫描中的streams和实际publish前使用此间隔；投稿前不再读取streams。','note'));
    const list=el('div',undefined,'review-list');body.append(list);
    const close=()=>{if(running){stopRequested=true;engine.stop();queueMessage.textContent='正在停止后续片段；当前请求结束后可关闭，已发出的请求不能撤销。';return;}closed=true;engine.endReview(session);reviewRefresh=null;reviewRequests=null;reviewRefreshedCover=null;for(const e of entries)e.generation++;reviewLayer?.remove();reviewLayer=null;cancelReview=null;renderBusy();};cancelReview=()=>{if(started){stopRequested=true;engine.stop();queueMessage.textContent='已离开回放页，停止后续提交；本窗口保留标题和封面，请返回回放页后继续。';return;}close();};
    const queueMessage=el('p','复用扫描范围和初始投稿检查，提交前不再请求streams或投稿列表；失败不自动重试，窗口保留标题和封面。','queue-message');queueMessage.setAttribute('role','status');body.append(queueMessage);
    const requestDetails=el('details'),requestSummary=el('summary','请求记录（HTTP；不含Cookie/CSRF）'),requestLog=el('pre');requestLog.className='request-log';requestDetails.append(requestSummary,requestLog);body.append(requestDetails);
    reviewRequests=()=>{requestLog.textContent=[...new Set([...engine.events.filter(e=>e.route==='publish').slice(-24),...engine.events.slice(-16)])].sort((a,b)=>engine.events.indexOf(a)-engine.events.indexOf(b)).map(e=>`${new Date(e.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} ${e.method||''} ${e.route||''} [${e.transport||env.transport()}] ${e.phase==='start'?'开始请求':e.http!==undefined?'HTTP '+e.http+(e.code!==undefined?' / code '+e.code:'')+(Number.isFinite(e.elapsedMs)?' / '+e.elapsedMs+'ms':''):''}${e.message?' · '+e.message:''}${e.error?' · '+e.error:''}${e.traceId?' · trace '+e.traceId:''}`).join('\n');};reviewRequests();
    const actions=el('div',undefined,'dialog-actions');const closeButton=button('取消',close,actions);
    const stopButton=button('停止后续',()=>{stopRequested=true;engine.stop();queueMessage.textContent='已请求停止后续片段，正在发出的请求不能撤销。';},actions);stopButton.hidden=true;
    const checkButton=button('刷新投稿状态',()=>execute([],true),actions);
    const submit=button('确认并开始投稿',()=>execute(entries.filter(e=>e.queueState==='pending')),actions,'primary danger');submit.disabled=true;body.append(actions);
    function taskState(entry){return ledger.tasks[entry.clip.key]?.state;}
    function status(entry){
      const t=ledger.tasks[entry.clip.key],state=t?.state;if(state==='sending'){entry.result.textContent='正在提交…';entry.result.className='queue-result tone-blue';}
      if(['accepted','processing','posted','duplicate','unknown','remote_failed','rejected'].includes(state)){
        entry.queueState=['rejected','remote_failed'].includes(state)?'failed':state==='unknown'?'unknown':'done';
        entry.result.textContent=(LABEL[state]||state)+(t.message?' · '+t.message:'');entry.result.className='queue-result '+(['rejected','remote_failed','unknown','duplicate'].includes(state)?'tone-red':state==='posted'?'tone-green':'tone-blue');
      }
      const locked=running||entry.queueState==='done'||entry.queueState==='unknown';
      entry.titleInput.disabled=locked;entry.restore.disabled=locked;entry.random.disabled=locked||entry.pending;entry.defaultButton.disabled=locked;entry.refresh.disabled=locked||entry.pending||entry.choice.source!=='random'||!Number.isInteger(entry.choice.ts);
      entry.edit.hidden=!t?.avid;entry.edit.disabled=running;
      entry.retry.hidden=!['failed','unknown'].includes(entry.queueState);
      entry.retry.textContent=entry.queueState==='unknown'?'核对投稿结果':'发布此段';entry.retry.disabled=running||(entry.queueState!=='unknown'&&(entry.pending||entry.savePending||entry.saveError||entry.needsChoice||!entry.imageLoaded||entry.titleInput.getAttribute('aria-invalid')==='true'));
    }
    async function execute(targets,checkOnly=false){
      if(closed||running||active||invalid||plan!==snapshot||!inRoute())return;
      const checked=update();if(!checkOnly&&(!targets.length||targets.some(e=>e.pending||e.savePending||e.saveError||e.needsChoice||!e.imageLoaded||checked.errors[e.clip.key])))return;
      const frozen=targets.map(entry=>({entry,title:checked.titles[entry.clip.key],cover:{...entry.choice}}));
      running=true;stopRequested=false;started=started||!checkOnly;batchActive=!checkOnly;active=true;renderBusy();update();
      try{
        if(checkOnly){await engine.reconcile();for(const e of entries)status(e);queueMessage.textContent='已核对最新状态；结果不明的片段仍禁止重发。';return;}
        for(const {entry,title,cover}of frozen){
          if(stopRequested||closed)break;
          entry.result.textContent='等待提交…';entry.result.className='queue-result tone-blue';queueMessage.textContent=`正在处理第 ${entries.indexOf(entry)+1}/${entries.length} 段：${title}`;
          try{
            if(['rejected','remote_failed'].includes(taskState(entry)))await engine.allowRetry([entry.clip.key]);
            if(stopRequested||closed||!inRoute())break;
            await engine.publish([entry.clip.key],snapshot.token,{[entry.clip.key]:cover},{[entry.clip.key]:title});
            if(engine.stopped)stopRequested=true;status(entry);
            if(!stopRequested&&entry.queueState==='pending'){entry.queueState='failed';entry.result.textContent='本段未提交，请单独点击发布。';}
          }catch(error){
            status(entry);
            if(!['done','unknown','failed'].includes(entry.queueState))entry.queueState='failed';
            entry.result.textContent=error.message+(taskState(entry)==='unknown'?' · 先核对结果，禁止直接重发':' · 已跳过，请手动点击发布此段');entry.result.className='queue-result tone-red';addLog(entry.titleInput.value+'：'+error.message,'error');
          }
        }
        const failed=entries.filter(e=>['failed','unknown'].includes(e.queueState)).length,pending=entries.filter(e=>e.queueState==='pending').length;
        queueMessage.textContent=stopRequested?`队列已停止；还有 ${pending} 段未处理。标题和封面已保留。`:`本轮处理结束：${failed} 段失败或待核对，${pending} 段待发布。失败项请逐段点击，窗口将保持打开。`;
      }catch(error){queueMessage.textContent=error.message;addLog(error.message,'error');}
      finally{running=false;active=false;batchActive=false;render();renderBusy();update();}
    }
    function update(){
      if(closed)return;const drafts=Object.fromEntries(entries.map(e=>[e.clip.key,e.titleInput.value])),checked=validateTitleDrafts(clips,drafts,(snapshot.published||[]).filter(p=>!entries.some(e=>e.queueState==='done'&&ledger.tasks[e.clip.key]?.sliceId===p.sliceId)));
      for(const e of entries){const error=checked.errors[e.clip.key]||'';e.titleError.textContent=error;e.titleInput.setAttribute('aria-invalid',String(!!error));e.titleCount.textContent=`${e.titleInput.value.trim().length}/80`;const img=e.imageBox.querySelector('img');if(img)img.alt=(checked.titles[e.clip.key]||e.clip.title)+' 投稿封面';}
      const ready=entries.filter(e=>!e.pending&&!e.savePending&&!e.saveError&&!e.needsChoice&&e.imageLoaded).length,invalidTitles=Object.keys(checked.errors).length;progress.textContent=`封面已就绪 ${ready}/${clips.length}${invalidTitles?' · '+invalidTitles+' 个标题待修改':''}`;
      const pending=entries.filter(e=>e.queueState==='pending');submit.textContent=started?'继续发布未处理片段':'确认并开始投稿';submit.disabled=!pending.length||pending.some(e=>e.pending||e.savePending||e.saveError||e.needsChoice||!e.imageLoaded||checked.errors[e.clip.key])||running||active||invalid||plan!==snapshot;for(const b of timingButtons)b.disabled=running||started;checkButton.disabled=running;transportSelect.disabled=running;interval.input.disabled=running;closeButton.textContent=running?'停止后再关闭':started?'关闭窗口':'取消';stopButton.hidden=!running;for(const e of entries)status(e);return checked;
    }
    function showImage(entry){
      const version=++entry.imageVersion;entry.imageLoaded=false;const img=el('img');img.className='cover-preview';img.alt=entry.clip.title+' 投稿封面';img.referrerPolicy='no-referrer';
      img.onload=()=>{if(closed||version!==entry.imageVersion)return;entry.imageLoaded=true;update();};
      img.onerror=()=>{if(closed||version!==entry.imageVersion)return;entry.imageLoaded=false;entry.needsChoice=true;entry.status.textContent='封面无法加载，请重新随机或选择默认封面。';entry.status.classList.add('error');update();if(!running&&entry.choice.source==='random'&&!entry.previewRecoveryAttempted&&!['done','unknown'].includes(entry.queueState)){entry.previewRecoveryAttempted=true;queueMicrotask(()=>{if(!closed&&!running)void randomize(entry,true,entry.choice.ts,true);});}};
      entry.imageBox.replaceChildren(img);img.src=entry.choice.url;update();
    }
    function persist(entry){
      const version=++entry.saveVersion;entry.savePending=true;entry.saveError=false;update();
      void engine.saveCoverChoice(entry.clip.key,{...entry.choice}).then(()=>{
        if(closed||version!==entry.saveVersion)return;entry.saveError=false;
      }).catch(error=>{
        if(closed||version!==entry.saveVersion)return;entry.saveError=true;entry.status.textContent='封面选择保存失败：'+error.message+'。请重新选择封面。';entry.status.classList.add('error');
      }).finally(()=>{if(!closed&&version===entry.saveVersion){entry.savePending=false;update();}});
    }
    function useDefault(entry){
      if(running||['done','unknown'].includes(entry.queueState))return;entry.manual=true;entry.generation++;entry.pending=false;entry.needsChoice=false;entry.choice={source:'default',url:entry.clip.defaultCover||entry.clip.cover,ts:null};
      entry.random.disabled=false;entry.status.textContent='使用本场默认封面';entry.status.classList.remove('error');showImage(entry);persist(entry);
    }
    async function randomize(entry,manual,restoreTimestamp,recovering=false){
      if(closed||running||['done','unknown'].includes(entry.queueState)||entry.pending&&manual||!manual&&entry.manual)return;
      if(manual)entry.manual=true;entry.previewRecoveryAttempted=recovering;const generation=++entry.generation;entry.pending=true;entry.needsChoice=false;entry.random.disabled=true;entry.status.classList.remove('error');entry.status.textContent=restoreTimestamp===undefined?'正在随机读取本片段关键帧…':'正在复用上次封面时间 '+stamp(restoreTimestamp)+'…';update();
      try{
        const choice=await engine.randomCover(entry.clip.key,entry.lastTimestamp,restoreTimestamp);if(recovering&&choice.ts!==restoreTimestamp)throw new Error('重新取图返回了不同时间点，请手动选择并确认');
        if(closed||generation!==entry.generation)return;
        entry.choice=choice;entry.needsChoice=false;entry.lastTimestamp=choice.ts;entry.status.textContent=`${restoreTimestamp===undefined?'随机关键帧':'复用上次关键帧'} · ${stamp(choice.ts)} 附近`;entry.random.textContent='重新随机';showImage(entry);persist(entry);
      }catch(error){
        if(closed||generation!==entry.generation)return;
        entry.needsChoice=true;entry.status.textContent=`${restoreTimestamp===undefined?'随机帧未取得':'按原时间取图失败'}：${error.message}。请重试或选择默认封面。`;entry.status.classList.add('error');
      }finally{if(!closed&&generation===entry.generation){entry.pending=false;entry.random.disabled=false;update();}}
    }
    for(const clip of clips){
      const item=el('div',undefined,'cover-row'),imageBox=el('div'),info=el('div',undefined,'cover-info'),titleLine=el('div',undefined,'review-title-line'),label=el('label','标题'),titleCount=el('span','','review-title-count'),titleInput=el('input'),titleError=el('div','','review-title-error');
      titleInput.type='text';titleInput.className='title-input';titleInput.id='bcr-review-title-'+entries.length;titleInput.value=preservedDrafts[clip.key]??clip.title;titleInput.placeholder='补充本段主题';titleInput.setAttribute('aria-label','片段标题 '+clip.title);titleInput.setAttribute('aria-describedby',titleInput.id+'-error');label.htmlFor=titleInput.id;titleError.id=titleInput.id+'-error';titleError.setAttribute('role','alert');
      titleLine.append(label,titleCount);const restore=button('恢复自动标题',()=>{titleInput.value=clip.automaticTitle||clip.title;update();},titleLine,'restore-title');titleInput.oninput=update;titleInput.onblur=()=>{titleInput.value=titleInput.value.trim();update();};
      info.append(titleLine,titleInput,titleError,el('small',`${stamp(clip.start)} → ${stamp(clip.end)} · ${duration(clip.end-clip.start)}`));
      const buttons=el('div',undefined,'cover-actions'),status=el('div','等待随机读取关键帧','cover-message');
      const entry={clip:{...clip},previewRecoveryAttempted:false,saveVersion:0,savePending:false,saveError:false,queueState:'pending',restore,imageBox,status,titleInput,titleError,titleCount,choice:{source:'default',url:clip.defaultCover||clip.cover,ts:null},pending:false,needsChoice:true,imageLoaded:false,imageVersion:0,generation:0,manual:false,lastTimestamp:undefined};
      entry.random=button('随机一帧',()=>randomize(entry,true),buttons);entry.refresh=button('按原时间取图',()=>randomize(entry,true,entry.choice.ts),buttons);entry.defaultButton=button('默认封面',()=>useDefault(entry),buttons);entry.retry=button('发布此段',()=>execute(entry.queueState==='unknown'?[]:[entry],entry.queueState==='unknown'),buttons,'retry-publish');entry.retry.hidden=true;entry.edit=button('继续编辑稿件',()=>{const t=ledger.tasks[clip.key];if(!t?.avid)return;close();openManuscriptEditor([{avid:t.avid,title:t.clip.title,state:LABEL[t.state]}]);},buttons);entry.edit.hidden=true;entry.result=el('div','待确认发布','queue-result');info.append(buttons,status,entry.result);item.append(imageBox,info);list.append(item);entries.push(entry);showImage(entry);
    }
    dialog.append(body);dialog.oncancel=event=>{event.preventDefault();close();};reviewLayer=el('div');reviewLayer.id='bcr-review';const modalRoot=reviewLayer.attachShadow({mode:'open'});modalRoot.append(root.querySelector('style').cloneNode(true),dialog);document.body.append(reviewLayer);dialog.showModal();
    reviewRefreshedCover=(key,choice)=>{const entry=entries.find(e=>e.clip.key===key);if(closed||!entry)return;entry.generation++;entry.choice={...choice};entry.lastTimestamp=choice.ts;entry.previewRecoveryAttempted=true;entry.needsChoice=false;entry.status.classList.remove('error');entry.status.textContent='已按原时间重新取图 · '+stamp(choice.ts)+' 附近';showImage(entry);};
    reviewRefresh=()=>{if(!closed)for(const e of entries)status(e);};
    // Restore the saved timestamp with a fresh API read; never trust an expired image URL.
    const savedChoices=engine.savedCoverChoices(keys);savedChoices.catch(()=>{});
    let next=0;async function worker(){
      let saved;try{saved=await savedChoices;}catch(error){if(!closed){for(const e of entries)if(!e.manual){e.status.textContent='无法读取封面选择：'+error.message+'；可手动重新随机或选择默认封面。';e.status.classList.add('error');}update();}return;}
      while(!closed&&next<entries.length){const entry=entries[next++];if(entry.manual)continue;const old=saved[entry.clip.key];
        if(old?.source==='default')useDefault(entry);else await randomize(entry,false,old?.source==='random'?old.ts:undefined);
      }
    }
    void worker();void worker();update();
  }
  async function resetFailed(keys){
    if(!plan||invalid){message('请先扫描回放。');return;}
    const next=await engine.allowRetry(keys);syncLedger(uid,next);render();
    message(`已重置 ${keys.length} 段为待投稿，原序号已保留。可直接重新选择并确认；本次操作没有投稿。`);addLog('已按初始检查及本地记录重置明确失败的片段，保留编号与封面选择。');
  }
  async function retry(){
    if(!plan||invalid){message('请先扫描回放。');return;}
    const l=await engine.load(uid),keys=Object.keys(l.tasks).filter(k=>['rejected','remote_failed','duplicate'].includes(l.tasks[k].state)&&Number(l.tasks[k].attempts)>0&&plan.clips.some(c=>c.key===k));
    if(!keys.length){message('没有可重置的明确失败任务。结果不明的任务不会重发。');return;}
    await resetFailed(keys);
  }
  function mount(){
    if(host)return;host=el('div');host.id='bili-cloud-replay-helper';host.style.cssText='position:fixed;z-index:2147483646;overflow:hidden;min-width:280px;min-height:56px';document.body.append(host);root=host.attachShadow({mode:'open'});
    const style=el('style');style.textContent=`:host{font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#263445}*{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{outline-offset:3px}button{cursor:pointer;white-space:nowrap;background:#fff;color:#344559;border:1px solid #d9e1e9;border-radius:7px;padding:7px 11px}button:hover{background:#f0f7fc}button:disabled{opacity:.45;cursor:not-allowed}button.primary{background:#00a1d6;color:white;border-color:#00a1d6}button.danger{background:#ec5277;border-color:#ec5277}button.stop{color:#ba334d;border-color:#edbfca}a{color:#008dbb;text-decoration:none;margin-right:12px}input[type=text],input:not([type]),select{border:1px solid #dbe3ec;border-radius:6px;padding:7px 9px;background:#fff;color:#263445}input[type=checkbox]{accent-color:#00a1d6;flex-shrink:0;width:15px;height:15px}small{display:block;color:#6a7b8b;font-size:11px}.panel{height:100%;display:flex;flex-direction:column;background:#fff;border:1px solid #dbe3ec;border-radius:13px;box-shadow:0 12px 36px #18344d2b;overflow:hidden}.head{min-height:55px;display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f5fbfe;cursor:move;touch-action:none;border-bottom:1px solid #e8eef3}.head:focus-visible{outline:2px solid #00a1d6;outline-offset:-2px}.head-title{font-size:14px;flex:1}.phase{font-size:11px;color:#0088b4;background:#e3f7ff;border-radius:20px;padding:3px 7px}.toggle,.inline-mode{padding:4px 8px;font-size:11px}.body{min-height:0;display:flex;flex-direction:column;flex:1}.intro{padding:9px 14px 0;font-size:11px;color:#677b8c}.metrics{display:grid;grid-template-columns:repeat(4,1fr);padding:8px 14px;gap:7px}.metric{background:#f7f9fc;border:1px solid #edf1f5;border-radius:8px;padding:6px 10px;color:#687c8d;font-size:11px}.metric b{display:block;color:#233d52;font-size:20px;line-height:1.25}.tools{display:flex;gap:7px;flex-wrap:wrap;padding:2px 14px 8px}.options{padding:0 14px 7px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#697a8b}.options label,.session-actions label{display:flex;align-items:center;gap:5px}.progress-box{padding:0 14px 6px}.progress-label{font-size:11px;color:#0087b3;margin-bottom:3px}.progress-box.idle progress{opacity:.35}progress{width:100%;height:5px;accent-color:#00a1d6;display:block}.message{margin:0 14px 7px;padding:6px 9px;border-radius:6px;background:#f2f8fc;color:#49677d;font-size:11px;white-space:pre-wrap}.message.error{background:#fff0f2;color:#a92d48}.tabs{display:flex;gap:20px;border-bottom:1px solid #e4ebf2;margin:0 14px}.tabs button{border:none;border-bottom:2px solid transparent;border-radius:0;padding:7px 0;background:none}.tabs button[aria-selected=true]{color:#0092c6;border-bottom-color:#00a1d6;font-weight:650}.workspace{flex:1;min-height:0;display:flex;flex-direction:column}.plan-view{flex:1;min-height:0;display:flex;flex-direction:column}.filters{display:flex;gap:7px;padding:8px 14px}.search{width:100%;min-width:60px}.filter-state{width:112px}.list,.tasks-view,.logs-view{min-height:0;overflow:auto;flex:1;padding:0 14px 10px;scrollbar-width:thin}.session{border:1px solid #e2e9f0;border-radius:9px;margin-bottom:9px;overflow:hidden}.session summary{display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;background:#fafcfe;padding:9px 11px;list-style:none}.session summary:before{content:'▸';color:#86a0b3}.session[open] summary:before{content:'▾'}.session summary>div{flex:1}.badge{font-size:10px;color:#7e8a96;white-space:nowrap}.badge.good{color:#008d6f}.session-body{padding:0 10px 8px}.session-body>input{width:100%;margin:6px 0}.session-actions{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding-top:7px}.clip{border-top:1px solid #edf1f5;padding:8px 0}.clip label{display:flex;align-items:flex-start;gap:7px}.clip input{margin-top:3px}.clip-content{min-width:0;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}.clip b{font-size:12px;font-weight:600}.state{display:inline-block;font-size:11px;color:#008d6b;margin:0}.state.blocked{color:#8a7682}.muted{color:#8a98a6;font-size:11px}.note{font-size:11px;color:#8b98a7;margin:4px 0}.error{color:#bf3656}.foot{border-top:1px solid #e4ebf2;padding:9px 14px;display:flex;align-items:center;gap:12px;background:#fff}.foot .selection{flex:1;color:#576e82;font-size:12px}.foot button{padding:8px 16px}.empty{padding:30px 10px;text-align:center;color:#8c9baa}.task{border-bottom:1px solid #e7edf3;padding:12px 0}.task p{margin:4px 0}.task a{font-size:11px}.logs-view{padding-top:8px}.log{padding:5px 0;border-bottom:1px solid #f1f4f7;font-size:11px;overflow-wrap:anywhere}.log.error{color:#bf3656}.account{color:#8a98a7;font-size:10px}.collapsed .body{display:none}.collapsed .head{border:none;height:55px}.collapsed .head-title{font-size:12px}.collapsed .account{display:none}[hidden]{display:none!important}dialog{border:1px solid #d9e3ed;border-radius:12px;width:min(590px,90vw);padding:20px;color:#263445}dialog::backdrop{background:#12243588}.review h3{margin-top:0}.review p{font-size:12px}.review-list{max-height:36vh;overflow:auto;background:#f7f9fc;border-radius:8px;padding:0 12px}.review-list>div{padding:9px 0;border-bottom:1px solid #e7edf4}.review input{width:100%;margin-top:12px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}@media(max-width:540px){.tools button{padding:6px 8px}.metric{padding:5px}.metric b{font-size:18px}.metrics{gap:4px}.head{padding:8px}.phase{display:none}.tools{gap:4px}.session-actions>.muted{display:none}}`;
    style.textContent+=DETAIL_CSS+TITLE_CSS;root.append(style);
    const panel=el('div',undefined,'panel'),head=el('div',undefined,'head');head.tabIndex=0;head.setAttribute('aria-label','回放助手标题栏，可拖动或使用方向键移动');
    const title=el('div',undefined,'head-title');title.append(el('strong','云端回放助手'),el('small','尚未读取账号','account'));head.append(title,el('span','只读预览','phase'));button('页面模式',()=>{floating=false;host.style.display='none';queueInline();},head,'inline-mode');button('收起',()=>{layout.collapsed=!layout.collapsed;applyLayout();saveLayout();},head,'toggle');panel.append(head);
    const body=el('div',undefined,'body');body.append(el('div','同日同主题跨场次连续编号。每段最多1:59:50，预留10秒转码余量。','intro'));
    const metrics=el('div',undefined,'metrics');for(const [key,label]of [['scenes','回放场次'],['ready','待确认片段'],['blocked','已拦下片段'],['processing','云端处理中']]){const m=el('div',undefined,'metric'),b=el('b',key==='scenes'?'—':'0');b.dataset.stat=key;m.append(b,document.createTextNode(label));metrics.append(m);}body.append(metrics);
    const tools=el('div',undefined,'tools');body.append(tools);
    const work=(label,fn,cls)=>{const b=button(label,()=>run(fn,label),tools,cls);b.dataset.work='1';return b;};
    work('刷新扫描',()=>scan(true),'primary');work('刷新任务',refresh);work('选最早未投稿场次',selectOldest);work('清空选择',async()=>{chosen.clear();renderPlan();renderStats();});
    const options=el('div',undefined,'options');for(const [key,text]of [['autoScan','每5分钟发现新回放']]){const l=el('label'),c=el('input');c.type='checkbox';c.checked=settings[key];c.onchange=()=>{settings[key]=c.checked;GM_setValue('settings-v3',JSON.stringify(settings));};l.append(c,document.createTextNode(text));options.append(l);}const transportLabel=el('label','请求方式'),transportSelect=el('select');transportSelect.className='request-transport';transportSelect.setAttribute('aria-label','请求方式');for(const [value,text]of [['page-fetch','页面fetch（Network可见）'],['extension-http','扩展HTTP（旧方式）']]){const option=el('option',text);option.value=value;transportSelect.append(option);}transportSelect.value=env.transport();transportSelect.onchange=()=>{if(active||reviewLayer?.isConnected)return;GM_setValue('request-mode-v1',transportSelect.value);invalid=true;message('请求方式已切换，请点击刷新扫描。');renderBusy();};transportLabel.append(transportSelect);options.append(transportLabel,intervalControl().label);body.append(options);
    const progress=el('div',undefined,'progress-box idle');progress.append(el('div','等待扫描','progress-label'),el('progress'));progress.querySelector('progress').value=0;body.append(progress,el('div','扫描与预览不会投稿。','message'));
    const tabs=el('div',undefined,'tabs');tabs.setAttribute('role','tablist');for(const [key,text]of [['plan','回放计划'],['tasks','任务记录'],['logs','运行日志']]){const b=button(text,()=>setTab(key),tabs);b.dataset.tab=key;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(key===tab));}body.append(tabs);
    const workspace=el('div',undefined,'workspace'),planView=el('div',undefined,'plan-view'),filters=el('div',undefined,'filters');const search=el('input');search.type='text';search.className='search';search.placeholder='搜索直播主题或开播日期';search.setAttribute('aria-label','搜索回放');search.oninput=()=>{filterText=search.value;renderPlan();};filters.append(search);
    const select=el('select');select.className='filter-state';select.setAttribute('aria-label','筛选片段状态');for(const [value,text]of [['all','全部场次'],['ready','可确认场次'],['blocked','已拦下场次']]){const o=el('option',text);o.value=value;select.append(o);}select.onchange=()=>{filterState=select.value;renderPlan();};filters.append(select);planView.append(filters,el('div',undefined,'list'));workspace.append(planView,el('div',undefined,'tasks-view'));const logsView=el('div',undefined,'logs-view');const logActions=el('div');button('导出诊断',()=>run(async()=>{const account=engine.scannedAccount();download('bili-replay-diagnostics.json',{version:'0.8.0',exportedAt:new Date().toISOString(),plan,ledger:await env.read(account),requests:engine.events,logs});message('诊断已导出，不包含Cookie、CSRF或视频流签名。');}),logActions);logsView.append(logActions,el('div',undefined,'log-lines'));workspace.append(logsView);body.append(workspace);
    const foot=el('div',undefined,'foot');foot.append(el('span','已选 0 段','selection'));button('复核失败',()=>run(retry,'复核失败任务'),foot).dataset.work='1';button('停止队列',()=>{engine.stop();message('已请求停止。已发出的请求仍由B站继续处理。');addLog('用户请求停止队列。');},foot,'stop');button('确认投稿…',review,foot,'primary publish-main');body.append(foot);panel.append(body);root.append(panel);
    let drag=null;
    head.onpointerdown=e=>{if(e.button!==0||e.target.closest('button'))return;const r=host.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};head.setPointerCapture(e.pointerId);e.preventDefault();};
    head.onpointermove=e=>{if(!drag)return;layout.x=drag.left+e.clientX-drag.x;layout.y=drag.top+e.clientY-drag.y;applyLayout();};
    head.onpointerup=e=>{if(!drag)return;drag=null;const r=host.getBoundingClientRect();layout.x=r.left;layout.y=r.top;saveLayout();if(head.hasPointerCapture(e.pointerId))head.releasePointerCapture(e.pointerId);};head.onpointercancel=()=>{drag=null;};
    head.onkeydown=e=>{const dirs={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]},d=dirs[e.key];if(!d||e.target!==head)return;e.preventDefault();const r=host.getBoundingClientRect();layout.x=r.left+d[0];layout.y=r.top+d[1];applyLayout();saveLayout();};
    let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(layout.collapsed||host.style.display==='none'||host.offsetWidth<280||host.offsetHeight<56)return;layout.width=host.offsetWidth;layout.height=host.offsetHeight;saveLayout();},250);}).observe(host);
    function rememberSize(){if(!layout.collapsed&&host.style.display!=='none'&&host.offsetWidth>=280&&host.offsetHeight>=56){layout.width=host.offsetWidth;layout.height=host.offsetHeight;}saveLayout();}
    window.addEventListener('pointerup',rememberSize);window.addEventListener('pagehide',rememberSize);
    window.addEventListener('resize',applyLayout);applyLayout();render();renderBusy();
    setInterval(()=>{if(settings.autoScan&&!active&&!editLayer?.isConnected&&!timingLayer?.isConnected&&!reviewLayer?.isConnected&&location.hash.startsWith('#/my-room/live-record'))run(scan,'自动只读扫描。');},300000);
  }
  let inlineBar,inlineRoot,fallback,inlineTimer,observer,booted=false,lastMessage='',floating=false;
  const cardBindings=new WeakMap();
  const inRoute=()=>location.hash.startsWith('#/my-room/live-record');
  const INLINE_CSS=`:host{display:block;color:#344559;font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}button{font:inherit;border:1px solid #d8e5ed;border-radius:6px;background:#fff;color:#277085;padding:5px 9px;cursor:pointer}button.primary{background:#00a1d6;color:#fff;border-color:#00a1d6}button:disabled,input:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:2px solid #00a1d6;outline-offset:2px}input{accent-color:#00a1d6}label{display:inline-flex;align-items:center;gap:4px}.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:#f1faff;border:1px solid #cdeaf6;border-radius:8px;margin:12px 0;padding:10px 12px}.bar strong{color:#007a9f}.hint{width:100%;color:#75889a;font-size:11px;overflow-wrap:anywhere}.card{border:1px solid #dcecf3;border-radius:6px;background:#f6fbfe;padding:7px 9px;margin-top:6px}.line{display:flex;gap:7px;align-items:center;justify-content:space-between;flex-wrap:wrap}.state{color:#007a9f;font-weight:600}.error{color:#b53855}.detail{font-size:11px;color:#708497}[hidden]{display:none!important}`+DETAIL_CSS;
  function queueInline(){if(inlineTimer)return;inlineTimer=setTimeout(()=>{inlineTimer=null;paintInline();},80);}
  function openDetails(){floating=true;host.style.display='block';layout.collapsed=false;applyLayout();queueInline();}
  function selectSession(s,on){for(const c of plan.clips.filter(c=>c.liveKey===s.liveKey&&!c.blocked))on?chosen.add(c.key):chosen.delete(c.key);renderPlan();renderStats();}
  function styleShadow(shadow){const style=el('style');style.textContent=INLINE_CSS;shadow.append(style);}
  function currentListMode(list){
    const scope=list.closest('.replay')||document,selected=[...scope.querySelectorAll('.replay-tab .replay-btn.active,.replay-tab [aria-selected="true"],.replay-tab [aria-pressed="true"]')].filter(n=>n.getClientRects().length);
    const labels=new Set(selected.map(n=>n.textContent.trim()));
    if(labels.size===1){const label=[...labels][0];return label==='直播场次'?'replays':label==='已发布片段'?'published':label==='回放剪辑草稿'?'draft':'unknown';}
    if(list.closest('.draft-content'))return 'draft';
    if(!selected.length&&list.querySelector('.replay-edit .publish-section'))return 'replays';
    return 'unknown';
  }
  function publicationCardIdentity(card){
    const title=card.querySelector('.info .title'),created=card.querySelector('.info .date')?.textContent.trim(),duration=card.querySelector('.cover .duration')?.textContent.trim();
    // Official cards expose no ID currently; use exact title + ctime + encoded duration.
    return {title:title?.getAttribute('title')||title?.textContent.trim()||'',created,duration};
  }
  function openOrigin(liveKey){
    if(!plan?.sessions.some(s=>s.liveKey===liveKey)){message('来源场次已不在当前计划中，请刷新扫描。',true);return;}
    filterText='';filterState='all';tab='plan';root.querySelector('.search').value='';root.querySelector('.filter-state').value='all';openDetails();render();
    const details=[...root.querySelectorAll('.session')].find(n=>n.dataset.key===liveKey);if(details){details.open=true;details.scrollIntoView({block:'nearest'});}
  }
  function publishedCard(binding,pub){
    const sig=JSON.stringify(['published',pub,active,invalid]);if(sig===binding.signature)return;binding.signature=sig;
    binding.shadow.querySelector('.card')?.remove();const box=el('div',undefined,'card'),line=el('div',undefined,'line');
    if(!pub){line.append(el('span',invalid||active?'正在核对投稿记录':'投稿记录未能唯一识别','state tone-blue'));box.append(line,el('div','按投稿标题、投稿时间和成片时长识别，请刷新扫描；不会套用直播场次的匹配规则。','detail'));binding.shadow.append(box);return;}
    line.append(publicationBadge(pub.state,[pub],statusTone(pub.state)));link(pub.direct?'查看视频':'创作中心',publicationInfo({avid:pub.avid,bvid:pub.bvid}).href,line);
    button('编辑稿件',()=>openManuscriptEditor([pub]),line).disabled=active||!pub.direct;box.append(line);
    if(Number.isFinite(pub.start)&&Number.isFinite(pub.end))box.append(el('div',`切片 ${stamp(pub.start)} → ${stamp(pub.end)}`,'detail'));
    const origin=pub.origin||reversePublication(pub,plan?.sessions||[]);
    if(origin.kind==='matched'){
      const s=origin.session;box.append(el('div',`来源直播：${s.topic||s.originalTopic||'未命名直播'}`,'detail'),el('div',`开播 ${stamp(s.start)} · 归属日期 ${date(s.start)}`,'detail'));
      button('查看来源场次',()=>openOrigin(s.liveKey),box);
    }else{
      box.append(el('div',origin.reason||'来源场次待核对','detail tone-amber'));
      if(origin.candidates?.length)box.append(el('div',`候选：${origin.candidates.map(s=>`${s.topic||s.originalTopic} ${stamp(s.start)}`).join('；')}`,'detail'));
    }
    binding.shadow.append(box);
  }
  function paintInline(){
    if(!host)return;
    const list=inRoute()?[...document.querySelectorAll('.replay-list')].find(n=>n.getClientRects().length):null,mode=list?currentListMode(list):'unknown';
    if(!list||!['replays','published'].includes(mode)){
      if(inlineBar){inlineBar.hidden=true;if(inlineBar.style.display!=='none')inlineBar.style.display='none';}
      for(const n of document.querySelectorAll('[data-bcr-card]')){n.hidden=true;if(n.style.display!=='none')n.style.display='none';const c=n.parentElement,b=cardBindings.get(c);if(b&&c.style.height!==b.originalHeight)c.style.height=b.originalHeight;}
      if(fallback)fallback.hidden=!inRoute()||mode==='draft';return;
    }
    if(fallback)fallback.hidden=true;
    if(!inlineBar){inlineBar=el('div');inlineBar.dataset.bcrToolbar='1';inlineRoot=inlineBar.attachShadow({mode:'open'});styleShadow(inlineRoot);}
    inlineBar.hidden=false;if(inlineBar.style.display==='none')inlineBar.style.display='block';if(inlineBar.nextSibling!==list)list.before(inlineBar);inlineBar.dataset.mode=mode;
    const cards=[...list.querySelectorAll('.replay-item')],currentCards=new Set(cards);let matched=0,origins=0;
    for(const n of document.querySelectorAll('[data-bcr-card]'))if(!currentCards.has(n.parentElement)){n.hidden=true;if(n.style.display!=='none')n.style.display='none';}
    for(const card of cards){
      let binding=cardBindings.get(card);
      if(!binding||binding.node.parentElement!==card){const node=el('div');node.dataset.bcrCard='1';node.style.cssText='display:block;clear:both;position:relative;width:100%;padding-bottom:6px';node.onclick=e=>e.stopPropagation();card.append(node);const shadow=node.attachShadow({mode:'open'});styleShadow(shadow);binding={node,shadow,signature:'',originalHeight:card.style.height};cardBindings.set(card,binding);}
      if(card.style.height!=='auto')card.style.height='auto';binding.node.hidden=false;binding.node.dataset.mode=mode;if(binding.node.style.display==='none')binding.node.style.display='block';
      if(mode==='published'){
        const pub=matchPublishedCard(plan?.published||[],publicationCardIdentity(card));if(pub)matched++;if(pub?.origin?.kind==='matched')origins++;
        publishedCard(binding,pub);continue;
      }
      const originalTitle=card.querySelector('.info .title'),minute=card.querySelector('.info .date')?.textContent.trim();
      const s=plan&&matchSession(plan.sessions,originalTitle?.getAttribute('title')||originalTitle?.textContent||'',minute);if(s)matched++;
      const clips=s?plan.clips.filter(c=>c.liveKey===s.liveKey):[],available=clips.filter(c=>!c.blocked),all=available.length>0&&available.every(c=>chosen.has(c.key));
      const ownPending=clips.some(c=>['sending','accepted','processing','unknown'].includes(c.state));
      const status=!s?(plan?'未能唯一匹配':'等待后台扫描'):s.error?'暂不可投稿':ownPending?'处理中 / 待核对':s.coverage?.status||'状态待核对';
      const sig=JSON.stringify(['replays',s?.liveKey,status,available.map(c=>c.title),all,active,invalid,plan?.created,clips.map(c=>[c.state,chosen.has(c.key)]),s?sessionPublications(s):[]]);
      if(sig===binding.signature)continue;binding.signature=sig;
      binding.shadow.querySelector('.card')?.remove();const box=el('div',undefined,'card'),line=el('div',undefined,'line');
      line.append(publicationBadge(status,s?sessionPublications(s):[],s?.error?'tone-red':statusTone(status)));
      const label=el('label'),check=checkedInput('选择本场回放',on=>{if(currentListMode(list)==='replays')selectSession(s,on);},!s||!available.length||invalid,all);label.append(check,document.createTextNode('选择本场'));line.append(label);
      button('投稿本场',()=>{if(currentListMode(list)!=='replays'||active||invalid||!s)return;chosen.clear();selectSession(s,true);review();},line,'primary').disabled=active||invalid||!available.length;
      box.append(line,el('div',s?`${clips.length} 段 · ${available.length} 段可投稿${clips.some(c=>c.state==='duplicate')?' · 重叠 / 标题冲突已拦下':''}`:plan?'请用“详细面板”核对本场，暂不提供快捷投稿。':'缓存和扫描结果将自动显示。','detail'));
      if(s?.error)box.append(el('div',s.error,'detail error'));binding.shadow.append(box);
    }
    const signature=JSON.stringify([mode,chosen.size,active,invalid,phase.text,lastMessage,plan?.created,cards.length,matched,origins,floating]);
    if(inlineBar.dataset.signature===signature)return;inlineBar.dataset.signature=signature;inlineRoot.querySelector('.bar')?.remove();
    const bar=el('div',undefined,'bar');bar.append(el('strong','云端回放助手'));
    if(mode==='replays'){
      bar.append(el('span',`已选 ${chosen.size} 段`));button('批量投稿…',()=>{if(currentListMode(list)==='replays')review();},bar,'primary').disabled=active||invalid||!chosen.size;
      button('选择本页可投稿',()=>{if(currentListMode(list)!=='replays')return;for(const card of cards){const s=plan&&matchSession(plan.sessions,card.querySelector('.info .title')?.getAttribute('title')||card.querySelector('.info .title')?.textContent||'',card.querySelector('.info .date')?.textContent.trim());if(s)for(const c of plan.clips.filter(c=>c.liveKey===s.liveKey&&!c.blocked))chosen.add(c.key);}render();},bar).disabled=active||invalid||!plan;
      button('清空选择',()=>{chosen.clear();render();},bar).disabled=active||!chosen.size;
    }else {bar.append(el('span','历史投稿'));button('批量编辑稿件…',()=>openManuscriptEditor(plan?.published||[]),bar).disabled=active||invalid||!plan?.published?.length;}
    button(active?'正在核对…':'刷新扫描',()=>run(()=>scan(true),'强制刷新扫描。'),bar).disabled=active;button('详细面板',openDetails,bar);if(batchActive)button('停止队列',()=>engine.stop(),bar);
    const freshness=plan?`回放扫描 ${stamp(plan.created)} · 投稿检查 ${stamp(plan.publicationCheckedAt||plan.created)}${invalid?' · 正在核对 / 暂不可提交':''}`:'首次自动扫描中';
    const counts=mode==='replays'?`本页匹配 ${matched}/${cards.length} 场`:`已识别 ${matched}/${cards.length} 条 · 已关联 ${origins}/${cards.length} 条来源`;
    bar.append(el('div',`${freshness} · ${counts} · ${active?phase.text:mode==='published'?'按切片起止时间反查开播场次，不使用投稿时间作为开播日期。':lastMessage||'勾选回放后，点击批量投稿并确认明细。'}`,'hint'));inlineRoot.append(bar);
  }
  async function initialize(){
    const ticket=await engine.prepareScan(),account=ticket.uid;uid=account;
    let cached;try{cached=await env.cacheRead(uid);}catch(_){}
    if(cached?.policy===CACHE_POLICY&&cached.uid===uid&&cached.plan?.uid===uid&&Number.isFinite(cached.plan.created)&&env.now()-cached.plan.created>=0&&env.now()-cached.plan.created<86400&&Array.isArray(cached.plan.clips)&&Array.isArray(cached.plan.sessions)){
      try{
        plan=cached.plan;engine.snapshot=plan;invalid=true;
        ledger=await engine.load(uid);syncLedger(uid,ledger);render();message('已载入缓存，后台正在核对最新投稿；核对完成后可提交。');
      }catch(_){plan=null;engine.snapshot=null;chosen.clear();addLog('无法显示旧扫描缓存，改为重新扫描。');}
    }
    await scan(false,ticket);
  }
  function setupInline(){
    fallback=el('button','云端回放助手');fallback.type='button';fallback.id='bcr-fallback';fallback.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483645;background:#fff;border:1px solid #00a1d6;border-radius:8px;padding:10px;color:#008bb5;cursor:pointer';fallback.onclick=openDetails;document.body.append(fallback);
    observer=new MutationObserver(queueInline);observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','title','aria-selected','aria-pressed']});queueInline();
  }
  GM_registerMenuCommand('打开云端回放助手',()=>{mount();openDetails();});
  function route(){
    if(inRoute()){
      mount();host.style.display=floating?'block':'none';
      if(!observer)setupInline();
      if(!booted){booted=true;run(initialize,'自动载入缓存并后台核对。');}
      else if(!active&&!editLayer?.isConnected&&!timingLayer?.isConnected&&!reviewLayer?.isConnected&&(!plan||env.now()-plan.created>300))run(()=>scan(),'返回页面，后台核对。');
    }else{if(host)host.style.display='none';cancelTiming?.();cancelReview?.();if(editLayer?.isConnected)manuscriptEditor.stop();}
    queueInline();
  }
  window.addEventListener('hashchange',route);route();
})();
