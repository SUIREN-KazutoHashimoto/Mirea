// Browsers display their own confirmation text; it cannot be customized.
// Server-side processing alone must never prevent closing a transferred batch.
export function mountUploadLeaveGuard({win=window,hasPending}){
 let attached=false;
 const warn=event=>{if(!hasPending())return;event.preventDefault();event.returnValue='';};
 const sync=()=>{const required=Boolean(hasPending());if(required===attached)return;attached=required;if(attached)win.addEventListener('beforeunload',warn);else win.removeEventListener('beforeunload',warn);};
 win.addEventListener('mirea:transferchange',sync);sync();
 return ()=>{win.removeEventListener('mirea:transferchange',sync);win.removeEventListener('beforeunload',warn);};
}
