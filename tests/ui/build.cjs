const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'../..');
let source=fs.readFileSync(path.join(base,'bilibili-cloud-replay.user.js'),'utf8');
source=source.replace("  window.addEventListener('hashchange',route);route();",fs.readFileSync(path.join(__dirname,'scenario.js'),'utf8'));
const bootstrap=`const values={};window.GM_getValue=(key,fallback)=>values[key]??fallback;window.GM_setValue=(key,value)=>values[key]=value;window.GM_registerMenuCommand=()=>{};window.GM_xmlhttpRequest=()=>{throw new Error('Network prohibited in test')};window.fetch=()=>{throw new Error('Network prohibited in test')};`;
fs.writeFileSync(path.join(__dirname,'preview.html'),'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos;; style-src &apos;unsafe-inline&apos;; img-src data: blob:; form-action &apos;none&apos;"><title>Local manuscript UI test</title><body><script>'+bootstrap+'\n'+source.replaceAll('</script','<\\/script')+'</script></body>');
