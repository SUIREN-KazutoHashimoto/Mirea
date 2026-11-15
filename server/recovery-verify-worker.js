import {parentPort,workerData} from 'node:worker_threads';
import {checkDatabase} from './recovery-store.js';
try{parentPort.postMessage({ok:true,value:checkDatabase(workerData.file,{full:workerData.full})});}
catch{parentPort.postMessage({ok:false});}
finally{parentPort.close();}
