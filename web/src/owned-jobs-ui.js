import {mountAdminJobs} from './admin-jobs-ui.js';
import {aiIdentity,sameAiIdentity} from './ai-ui.js';
export async function openOwnedJobs({api,dialog,esc,bytes}){
 const actor=aiIdentity(),node=dialog('自分のジョブ','<div class="modal-body owned-jobs"><p class="owned-job-status" role="status"></p><div class="admin-panel"></div></div>','owned-jobs-modal');
 let disposed=false,timer;const valid=()=>!disposed&&node.isConnected&&sameAiIdentity(actor);
 const status=error=>{if(valid())node.querySelector('.owned-job-status').textContent=error?.message??String(error);};
 node.addEventListener('close',()=>{disposed=true;clearInterval(timer);},{once:true});
 try{const refresh=await mountAdminJobs({panel:node.querySelector('.admin-panel'),api,esc,bytes,ownerOnly:true,valid,status});if(valid())timer=setInterval(()=>refresh().catch(status),4000);}catch(error){status(error);}
}
