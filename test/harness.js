const fs=require('fs'),os=require('os'),path=require('path');
const {SesameTrigger}=require('../dist/nodes/SesameTrigger/SesameTrigger.node.js');
const tokensJson=fs.readFileSync(path.join(os.homedir(),'.config','sesame-kit','tokens.json'),'utf8');
const UUID=process.env.SESAME_UUID;
if(!UUID){console.error('set SESAME_UUID=<device uuid>');process.exit(1);}
const params={eventFilter:'all',emitOnlyOnChange:true};
const ctx={
  getCredentials:async()=>({deviceUuids:UUID,tokensJson,companyID:'ch_CandyhouseMobile'}),
  getNodeParameter:(n)=>params[n],
  getMode:()=>'trigger',
  emit:(data)=>console.log(new Date().toISOString(),'>>> EMIT',JSON.stringify(data[0],null,1)),
  emitError:(e)=>console.log('>>> EMIT ERROR',e.message),
  helpers:{returnJsonArray:(arr)=>arr.map(json=>({json}))},
  logger:{info:(m)=>console.log('[info]',m),error:(m,e)=>console.log('[error]',m,e||''),warn:(m)=>console.log('[warn]',m),debug:(m)=>console.log('[debug]',m)},
};
(async()=>{
 const node=new SesameTrigger();
 const res=await node.trigger.call(ctx);
 console.log('trigger() returned; watching', UUID);
 const SEC=Number(process.env.WAIT_SEC||300);
 await new Promise(r=>setTimeout(r,SEC*1000));
 await res.closeFunction();
 console.log('closed cleanly');
 process.exit(0);
})().catch(e=>{console.error('HARNESS FAILED:',e.message);process.exit(1);});
