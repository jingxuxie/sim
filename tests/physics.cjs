const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const out=process.env.LAB_TEST_OUTPUT||path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
const url=process.env.LAB_TEST_URL||'http://localhost:8000/';
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--no-proxy-server','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('crash',()=>{console.error('PAGE CRASHED');process.exit(2);});
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message)});
 page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});
 await page.goto(url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.viewerReady);
 await page.evaluate(async()=>{
  const {BrowserRuntime}=await import('./runtime.js');
  window.testRuntime=new BrowserRuntime(s=>window.testState=s,s=>console.log(s),s=>{throw Error(s)});
  window.catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments;
 });
 const reports=[],negatives=[];let audit;
 try{
  const assets=process.env.LAB_ASSETS?process.env.LAB_ASSETS.split(','):['nikon','transfer','probe','zeiss','bonder','afm','tweezers'];
  for(const asset of assets){
   console.log('OPEN',asset);
   const initial=await page.evaluate(async asset=>{
    const item=window.catalog.find(x=>x.id===asset);
    await window.testRuntime.open(item);
    return window.testRuntime.request('step',{seconds:.1});
   },asset);
   console.log('INITIAL',asset,initial.time,initial.warnings,initial.contacts.length);
   const tasks=await page.evaluate(asset=>window.catalog.find(x=>x.id===asset).tasks.map(t=>t.id),asset);
   for(const task of tasks){
    if(process.env.LAB_TASKS&&!process.env.LAB_TASKS.split(',').includes(task))continue;
    if(process.env.LAB_SKIP_IMAGES&&task.includes('.image_'))continue;
    for(const seed of (process.env.LAB_SEEDS||'0,1,2').split(',').map(Number)){
    const start=Date.now();
    console.log('TASK',task);
    const result=await page.evaluate(async ({task,seed})=>{
     const rt=window.testRuntime;
     await rt.request('task',{task,seed,run:false,paused:true});
     let s;
     for(let i=0;i<3200;i++){
      s=await rt.request('taskTick',{auto:true});
      if(s.done)return s;
     }
     throw Error('Task did not terminate');
    },{task,seed});
    reports.push({task,seed,wall_ms:Date.now()-start,success:result.success,failure:result.failure,time:result.time,metrics:result.metrics,events:result.events,warnings:result.warnings});
    console.log('RESULT',JSON.stringify(reports.at(-1)));
    fs.writeFileSync(out+'/physics.json',JSON.stringify({url,engine:'MuJoCo 4.0.1 WASM',checked_utc:new Date().toISOString(),reports,errors,passed:reports.every(x=>x.success&&!x.failure)},null,2));
    if(!result.success||result.failure)throw Error('Baseline failed: '+task+' seed '+seed);
    }
   }
   if(!process.env.LAB_TASKS){
    for(const task of tasks){
     const r=await page.evaluate(async task=>{
      const rt=window.testRuntime;await rt.request('task',{task,seed:0,run:false,paused:true});let s;
      for(let i=0;i<3200;i++){s=await rt.request('taskTick',{auto:false});if(s.done)break;}
      return {task,success:s.success,failure:s.failure,time:s.time,warnings:s.warnings};
     },task);
     negatives.push(r);console.log('NO ACTION',JSON.stringify(r));
     if(r.success)throw Error('False positive: '+task);
    }
   }
   if(asset==='tweezers'){
    audit=await page.evaluate(async()=>{
     const rt=window.testRuntime;await rt.request('task',{task:'tweezers.place',seed:0,run:false,paused:true});await rt.request('startAudit');
     let s;for(let i=0;i<1000;i++)s=await rt.request('taskTick',{auto:true});
     return {...await rt.request('audit'),final:s.metrics,warnings:s.warnings};
    });
    if(audit.steps!==20000||audit.unintended_contacts!==0||audit.warnings.some(Boolean)||!audit.final.success)throw Error('Tweezer contact audit failed');
    console.log('CONTACT AUDIT',JSON.stringify(audit));
   }
  }
  fs.writeFileSync(out+'/physics.json',JSON.stringify({url,engine:'MuJoCo 4.0.1 WASM',checked_utc:new Date().toISOString(),reports,negatives,audit,errors,passed:reports.every(x=>x.success&&!x.failure)&&negatives.every(x=>!x.success)&&errors.length===0},null,2)+'\n');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
