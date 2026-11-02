// Hide only presentation. Analytics, progress and download keys are untouched.
export function registerHistoryRemoval(app,{db,authenticate,findItem}){
  const auth={onRequest:async req=>authenticate(req)};
  app.delete('/api/v1/history',auth,async(req,reply)=>{
    db.prepare("INSERT INTO history_hidden SELECT user_id,asset_id,? FROM analytics_views WHERE user_id=? AND context='viewer' GROUP BY user_id,asset_id ON CONFLICT(user_id,asset_id) DO UPDATE SET hidden_at=excluded.hidden_at").run(Date.now(),req.user.id);
    return reply.code(204).send();
  });
  app.delete('/api/v1/history/:id',auth,async(req,reply)=>{
    findItem(req.params.id,req.user.id);
    db.prepare('INSERT INTO history_hidden VALUES(?,?,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET hidden_at=excluded.hidden_at').run(req.user.id,req.params.id,Date.now());
    return reply.code(204).send();
  });
}
