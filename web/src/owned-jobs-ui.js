import {mountAdminJobs} from './admin-jobs-ui.js';
import {openAiJobs} from './ai-jobs-ui.js';
import {aiIdentity,sameAiIdentity} from './ai-ui.js';
export async function openOwnedJobs({api,dialog,esc,bytes}){
 const actor=aiIdentity(),node=dialog('自分のジョブ','<div class="modal-body owned-jobs"><button type="button" class="button secondary owned-analysis-status">AI解析・一括登録の状況</button><p class="owned-job-status" role="status"></p><div class="admin-panel"></div></div>','owned-jobs-modal');
 node.querySelector('.owned-analysis-status').onclick=()=>{if(valid())openAiJobs({api,dialog});};
 let disposed=false,timer;const valid=()=>!disposed&&node.isConnected&&sameAiIdentity(actor);
 const status=error=>{if(valid())node.querySelector('.owned-job-status').textContent=error?.message??String(error);};
 node.addEventListener('close',()=>{disposed=true;clearInterval(timer);},{once:true});
 try{const refresh=await mountAdminJobs({panel:node.querySelector('.admin-panel'),api,esc,bytes,ownerOnly:true,valid,status});if(valid())timer=setInterval(()=>{if(valid())refresh().catch(status);else{clearInterval(timer);if(node.isConnected)node.close();}},4000);}catch(error){status(error);}
}
