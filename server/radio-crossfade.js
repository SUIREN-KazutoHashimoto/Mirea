export const radioFadeMs=2400;

export function layoutRadio(segments,fadeMs=0){
  // All eligible music must be long enough to prevent triple overlaps. The
  // fixed overlap count then does not vary with a shuffled permutation.
  const music=track=>!track.kind||track.kind==='music';
  const enabled=fadeMs===radioFadeMs&&segments.every(track=>!music(track)||track.durationMs>=2*fadeMs+250);
  let start=0;
  const spans=segments.map((track,i)=>{
    const next=segments[i+1];
    const overlap=enabled&&next&&music(track)&&music(next)?fadeMs:0;
    const span={track,start,end:start+track.durationMs,overlap};
    start=span.end-overlap;
    return span;
  });
  return {spans,durationMs:start};
}

export function onAir(layout,clock,anchor){
  const length=layout.durationMs;
  const offset=((clock-anchor)%length+length)%length;
  const index=layout.spans.findIndex(span=>offset<span.end);
  const span=layout.spans[index];
  return {span,index,cycleStart:clock-offset};
}
