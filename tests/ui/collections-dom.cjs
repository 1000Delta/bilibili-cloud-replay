// Optional DOM smoke test, not a real-browser/layout test. Requires happy-dom.
// BCR_HAPPY_DOM may point to a temporary install's lib/index.js; no production dependency.
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const {Window}=await import(process.env.BCR_HAPPY_DOM||'happy-dom');
 const window=new Window({url:'https://link.bilibili.com/p/center/index#/my-room/live-record',settings:{enableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,enableCSSFileLoading:false,enableImageFileLoading:false,enableIframePageLoading:false,suppressInsecureJavaScriptEnvironmentWarning:true}});
 window.structuredClone=structuredClone;window.GM_getValue=(_,fallback)=>fallback;window.GM_setValue=()=>{};window.GM_registerMenuCommand=()=>{};window.GM_xmlhttpRequest=()=>{throw new Error('Unexpected network request');};window.fetch=()=>{throw new Error('Unexpected network request');};
 const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'bilibili-cloud-replay.user.js'),'utf8'),scenario=fs.readFileSync(path.join(__dirname,'scenario.js'),'utf8');
 const start=scenario.indexOf('    // Collection manager:'),end=scenario.indexOf("    const report=document.createElement('pre');",start);if(start<0||end<0)throw new Error('Missing collection browser scenario');
 const setup=`(async()=>{const results=[],check=(condition,name)=>{if(!condition)throw new Error(name);results.push(name);};const tick=()=>new Promise(r=>setTimeout(r,0));const wait=async()=>{for(let i=0;i<200&&active;i++)await tick();check(!active,'async UI operation finished');};mount();uid='123';env.sleep=async()=>{};env.csrf=()=> 'a'.repeat(32);env.lock=async(_,fn)=>fn();env.read=async()=>structuredClone(window.testLedger||{version:1,tasks:{}});env.write=async(_,data)=>{window.testLedger=structuredClone(data);};`;
 window.eval(source.replace("  window.addEventListener('hashchange',route);route();",setup+scenario.slice(start,end)+`window.collectionDOMResult={passed:true,checks:results};})().catch(error=>window.collectionDOMResult={passed:false,error:error.stack});`));
 for(let i=0;i<300&&!window.collectionDOMResult;i++)await new Promise(r=>setTimeout(r,10));
 const result=window.collectionDOMResult||{passed:false,error:'DOM test timed out'};await window.happyDOM.abort();await window.close();console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
