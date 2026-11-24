const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=process.env.LAB_TEST_OUTPUT||path.join(root,'test-results'),url=process.env.LAB_TEST_URL||'http://localhost:8000/';
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--no-proxy-server']});
 const page=await browser.newPage();page.on('crash',()=>{console.error('Page crashed');process.exit(2);});
 const checks=[];
 try{
  await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.viewerReady);
  const result=await page.evaluate(async()=>{
   const {BrowserRuntime}=await import('./runtime.js'),catalog=JSON.parse(document.getElementById('instrument-catalog').textContent).instruments;
   const rt=new BrowserRuntime(()=>{},()=>{},e=>console.error(e)),checks=[];
   const check=(name,ok,evidence={})=>{checks.push({check:name,passed:!!ok,...evidence});if(!ok)throw Error(name);};
   const open=async id=>{await rt.open(catalog.find(x=>x.id===id));return rt.request('step',{seconds:.05});};
   const step=(action,seconds=1)=>rt.request('step',{action,seconds});
   await open('afm');
   let s=await step({drawer_travel:.1,door_angle:-1.8},.5);
   check('AFM locked door and scanner commands rejected',s.guard_events.length===2&&Math.abs(s.q.drawer_travel)<.0001&&Math.abs(s.q.door_angle)<.01);
   await step({door_latch_angle:1.1},1.5);await step({door_angle:-1.8},3.5);await step({scanner_latch_angle:1.2},1.5);
   s=await step({drawer_travel:.1},3);
   check('AFM release sequence opens scanner',s.q.drawer_travel>.09&&s.q.door_angle<-1.3);
   s=await step({door_angle:0,scanner_latch_angle:0},1);
   check('AFM drawer must return before door closure or scanner relatch',s.q.drawer_travel>.09&&s.q.door_angle<-1.1&&s.q.scanner_latch_angle>.65);
   await step({drawer_travel:0},3);await step({scanner_latch_angle:0},1.5);await step({door_angle:0},3.5);
   s=await step({door_latch_angle:0},1.5);
   check('AFM complete close and relatch sequence',s.q.drawer_travel<.002&&Math.abs(s.q.door_angle)<.025&&s.q.scanner_latch_angle<.15&&s.q.door_latch_angle<.15);
   for(const asset of ['nikon','zeiss','transfer','probe']){
    await open(asset);
    for(const position of [0,.006,.012]){
     await step({light_path_travel:position},.6);
     const cam=await rt.request('specimen',{channel:'camera'}),eye=await rt.request('specimen',{channel:'eyepiece'});
     const fraction=position===0?0:position===.012?1:asset==='nikon'?.8:.5;
     check(asset+' optical routing '+position+' m',cam.throughput===fraction&&eye.throughput===1-fraction&&cam.indexed&&eye.indexed,{camera_throughput:cam.throughput,eyepiece_throughput:eye.throughput});
     for(const [channel,frame] of [['camera',cam],['eyepiece',eye]]){
      const image=new Image();image.src=frame.image;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const pixels=ctx.getImageData(0,0,256,256).data;let energy=0;for(let i=0;i<pixels.length;i+=4)energy+=pixels[i]+pixels[i+1]+pixels[i+2];
      check(asset+' '+channel+' actual image pixels at '+position+' m',frame.throughput===0?energy===0:energy>0,{pixel_sum:energy});
     }
    }
    await step({light_path_travel:.003},.5);
    const transit=await rt.request('specimen',{channel:'camera'});
    check(asset+' selector transit blocks image',transit.optical_status==='splitter_in_transit'&&transit.throughput===0);
    if(asset==='nikon'){
     await step({light_path_travel:.012,turret:2},2);
     let frame=await rt.request('specimen',{channel:'camera'});
     check('Nikon empty objective socket is dark',frame.optical_status==='empty_objective_port'&&frame.throughput===0);
     await step({turret:0,coarse:0},2);const focused=await rt.request('specimen',{channel:'camera'});
     await step({coarse:.0001/.005*2*Math.PI},2);const defocused=await rt.request('specimen',{channel:'camera'});
     check('Measured Nikon focus changes specimen sharpness',focused.sharpness>defocused.sharpness*2,{focused:focused.sharpness,defocused:defocused.sharpness});
    }
   }
   await open('tweezers');await step({jaw_left_angle:-1e9},.01);s=await rt.request('snapshot');
   check('Jaw command clamps to physical actuator range',s.targets.jaw_left_angle>=-.052);
   let rejected=false;try{await rt.request('command',{action:{jaw_left_angle:NaN}});}catch{rejected=true;}
   check('Nonfinite commands rejected',rejected);
   rt.close();return checks;
  });
  checks.push(...result);
 }finally{await browser.close();}
 const report={url,engine:'MuJoCo 4.0.1 WASM',checked_utc:new Date().toISOString(),checks,passed:checks.every(x=>x.passed)};
 fs.writeFileSync(out+'/mechanisms.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1);});
