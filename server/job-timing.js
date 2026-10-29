export function jobTiming(db,id,scope){
 const row=scope?db.prepare('SELECT started_at,finished_at FROM job_timings WHERE id=? AND scope=?').get(id,scope):db.prepare("SELECT started_at,finished_at FROM job_timings WHERE id=? AND scope!='upload' LIMIT 1").get(id);
 return row?{startedAt:row.started_at,finishedAt:row.finished_at}:{};
}
