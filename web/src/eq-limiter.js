// Stereo-linked lookahead peak protection. The monotonic queue is O(1) per
// sample; buffers are reused instead of allocating in the audio callback.
export class PeakLimiter {
 constructor(sampleRate,channels=2){this.channels=channels;this.delay=Math.max(1,Math.ceil(sampleRate*.005));this.size=this.delay+1;this.capacity=this.size+1;this.audio=Array.from({length:channels},()=>new Float32Array(this.size));this.peaks=new Float64Array(this.capacity);this.times=new Float64Array(this.capacity);this.head=0;this.tail=0;this.time=0;this.write=0;this.gain=1;this.release=1-Math.exp(-1/(sampleRate*.08));}
 process(input,output){const frames=output[0]?.length??0;for(let n=0;n<frames;n++){
  let peak=0;for(let c=0;c<this.channels;c++){const channel=input[c]??(input.length===1?input[0]:undefined),value=channel?.[n]??0,v=Number.isFinite(value)?value:0;this.audio[c][this.write]=v;peak=Math.max(peak,Math.abs(v));}
  while(this.tail>this.head&&this.peaks[(this.tail-1)%this.capacity]<=peak)this.tail--;
  this.peaks[this.tail%this.capacity]=peak;this.times[this.tail%this.capacity]=this.time;this.tail++;
  while(this.tail>this.head&&this.times[this.head%this.capacity]<this.time-this.delay)this.head++;
  const maximum=this.peaks[this.head%this.capacity],target=maximum>.999?.999/maximum:1;this.gain=Math.min(target,this.gain+(1-this.gain)*this.release);const read=(this.write+1)%this.size;
  for(let c=0;c<this.channels;c++)output[c][n]=this.audio[c][read]*this.gain;
  this.write=read;this.time++;
 }}
}
if(typeof AudioWorkletProcessor!=='undefined'){
 class MireaPeakLimiter extends AudioWorkletProcessor {
  process(inputs,outputs){const out=outputs[0];if(!out?.length)return true;if(!this.limiter||this.limiter.channels!==out.length)this.limiter=new PeakLimiter(sampleRate,out.length);this.limiter.process(inputs[0]??[],out);return true;}
 }
 registerProcessor('mirea-peak-limiter',MireaPeakLimiter);
}
