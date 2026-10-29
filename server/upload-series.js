import {orderSeriesItems} from './series-order.js';
import {uploadSeriesDestination} from './name-integrity.js';
// Called inside the media publication transaction, never from a client callback.
// A deleted/full destination must not destroy an otherwise valid uploaded asset.
export function attachUploadSeries(db,upload){
  const row=db.prepare('SELECT target_series_id,series_requested FROM upload_sessions WHERE id=?').get(upload.id);
  if(!row?.series_requested)return;
  const destination=uploadSeriesDestination(db,upload),series=destination.seriesId?db.prepare('SELECT * FROM series WHERE id=?').get(destination.seriesId):null;
  let warning=destination.warning;
  if(!series||series.shelf_id!==upload.shelf_id)warning='追加先のシリーズが変更・削除されたため、単独のアセットとして保存しました。';
  else if(db.prepare('SELECT COUNT(*) n FROM series_items WHERE series_id=?').get(series.id).n>=1000)warning='シリーズの上限に達したため、単独のアセットとして保存しました。';
  else{
    const position=db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM series_items WHERE series_id=?').get(series.id).n;
    db.prepare('INSERT INTO series_items(series_id,asset_id,position,label) VALUES(?,?,?,?)').run(series.id,upload.id,position,'');
    orderSeriesItems(db,series.id);
    db.prepare('UPDATE series SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),series.id);
  }
  db.prepare('UPDATE upload_sessions SET series_warning=? WHERE id=?').run(warning,upload.id);
}
