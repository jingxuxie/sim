// Per-instrument workers isolate physics, optics, and failures from the gallery.
export class BrowserRuntime {
  constructor(onState,onStatus,onError){this.onState=onState;this.onStatus=onStatus;this.onError=onError;this.pending=new Map();this.next=0;}
  async open(item){
    this.close();
    this.worker=new Worker(new URL('./worker.js?v=clearance1',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      if(data.type==='state')this.onState(data.state);
      if(data.type==='status')this.onStatus(data.message);
      if(data.type==='fatal')this.onError(data.message);
      if(data.type==='reply'){
        const pending=this.pending.get(data.id);if(!pending)return;
        clearTimeout(pending.timer);this.pending.delete(data.id);
        if(data.error)pending.reject(Error(data.error));else pending.resolve(data.result);
      }
    };
    this.worker.onerror=e=>{const message=e.message||'The browser could not load the simulation worker. Reload to retry.';this.close(message);this.onError(message);};
    return this.request('init',{asset:item.id,physics:item.physics,metadata:item.metadata});
  }
  request(op,payload={}){
    if(!this.worker)return Promise.reject(Error('Open an instrument first'));
    return new Promise((resolve,reject)=>{
      const id=++this.next;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('The simulator took too long. Return to All instruments and reopen it to retry.'));},['init','task','specimen'].includes(op)?180000:45000);
      this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,op,...payload});
    });
  }
  close(reason='Instrument closed'){
    this.worker?.terminate();this.worker=null;
    for(const {reject,timer} of this.pending.values()){clearTimeout(timer);reject(Error(reason));}this.pending.clear();
  }
}
