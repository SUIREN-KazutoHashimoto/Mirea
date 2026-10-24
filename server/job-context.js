import {AsyncLocalStorage} from 'node:async_hooks';
export const jobContext=new AsyncLocalStorage();
export const jobCancellationSignal=()=>jobContext.getStore()?.signal;
