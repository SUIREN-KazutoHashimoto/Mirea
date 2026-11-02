import {normalizeDiagnostic} from './error-diagnostic-schema.js';
import {httpError} from './security.js';
export function registerDiagnosticReports(app,{db,authenticate,adminAccess,rateLimit}){
  app.post('/api/v1/diagnostics/batches',{preHandler:async req=>authenticate(req),bodyLimit:128*1024,config:{rateLimit:rateLimit===false?false:{max:3,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['id','reports'],properties:{id:{type:'string',format:'uuid'},reports:{type:'array',minItems:1,maxItems:20,items:{type:'object'}}}}}},async req=>{
    const reports=req.body.reports.map(normalizeDiagnostic);
    if(reports.some(value=>!value))throw httpError(400,'送信できない診断情報が含まれています。');
    const existing=db.prepare('SELECT user_id FROM diagnostic_batches WHERE id=?').get(req.body.id);
    if(existing){if(existing.user_id!==req.user.id)throw httpError(409,'送信番号が使用されています。');return {id:req.body.id,received:true};}
    db.prepare('INSERT INTO diagnostic_batches(id,user_id,reports_json,report_count,created_at) VALUES(?,?,?,?,?)').run(req.body.id,req.user.id,JSON.stringify(reports),reports.length,Date.now());
    return {id:req.body.id,received:true};
  });
  app.get('/api/v1/admin/diagnostics',{preHandler:async req=>adminAccess.requireAdmin(req),schema:{querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async req=>{
    const rows=db.prepare('SELECT id,created_at,report_count,reports_json FROM diagnostic_batches WHERE created_at<? ORDER BY created_at DESC,id DESC LIMIT 101').all(req.query.before??Number.MAX_SAFE_INTEGER);
    return {batches:rows.slice(0,100).map(row=>({id:row.id,createdAt:row.created_at,count:row.report_count,reports:JSON.parse(row.reports_json).map(normalizeDiagnostic).filter(Boolean)})),nextBefore:rows.length>100?rows[99].created_at:null};
  });
}
