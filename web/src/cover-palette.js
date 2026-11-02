export function coverPalette(pixels,seed=1){
  let n=2166136261;for(const char of String(seed))n=Math.imul(n^char.charCodeAt(0),16777619);const random=()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};
  const candidates=[];for(let i=0;i<96&&pixels.length>=4;i++){const at=Math.floor(random()*(pixels.length/4))*4,[r,g,b,a]=pixels.slice(at,at+4),max=Math.max(r,g,b),min=Math.min(r,g,b);if(a>=180&&max>45&&max-min>25&&(r+g+b)/3<235)candidates.push({rgb:[r,g,b],score:max-min});}
  candidates.sort((a,b)=>b.score-a.score);const colors=[];for(const value of candidates){if(colors.every(c=>Math.hypot(...c.map((v,i)=>v-value.rgb[i]))>70))colors.push(value.rgb);if(colors.length===3)break;}
  while(colors.length<3)colors.push([[68,99,163],[97,75,157],[34,104,139]][colors.length]);return colors;
}
export function applyCoverPalette(root,image,seed){try{const canvas=image.ownerDocument.createElement('canvas');canvas.width=32;canvas.height=32;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,32,32);const colors=coverPalette(context.getImageData(0,0,32,32).data,seed);colors.forEach((c,i)=>root.style.setProperty('--audio-glow-'+i,c.join(',')));return colors;}catch{return null;}}
