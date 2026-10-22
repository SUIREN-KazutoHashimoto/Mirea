const active=new Set(['queued','running','processing','uploading']);
export function partitionJobs(rows){return {current:rows.filter(row=>!row.state||active.has(row.state)),history:rows.filter(row=>row.state&&!active.has(row.state))};}
export function jobStateClass(state){return state==='complete'?'job-complete':state==='failed'?'job-failed':state==='cancelled'?'job-cancelled':'job-active';}
