package com.suiren.mirea.playback;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.util.*;

/** Private durable telemetry/progress outbox. No passwords, tokens or content keys. */
public final class PlaybackJournal implements AutoCloseable {
    private final SQLiteDatabase db;
    public PlaybackJournal(Context context){
        db=context.openOrCreateDatabase("playback-journal.sqlite",Context.MODE_PRIVATE,null);
        db.execSQL("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,partition TEXT NOT NULL,view_id TEXT NOT NULL,body TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS progress(partition TEXT NOT NULL,asset TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(partition,asset))");
    }
    public synchronized void event(String partition,JSONObject view,JSONObject event)throws Exception{
        ContentValues values=new ContentValues();values.put("partition",partition);values.put("view_id",view.getString("id"));values.put("body",new JSONObject().put("view",view).put("event",event).toString());db.insertOrThrow("events",null,values);
    }
    public synchronized JSONObject progress(String partition,String asset)throws Exception{
        try(Cursor c=db.rawQuery("SELECT body FROM progress WHERE partition=? AND asset=?",new String[]{partition,asset})){return c.moveToFirst()?new JSONObject(c.getString(0)):null;}
    }
    public synchronized void progress(String partition,String asset,JSONObject body){
        if(body==null){db.delete("progress","partition=? AND asset=?",new String[]{partition,asset});return;}
        ContentValues v=new ContentValues();v.put("partition",partition);v.put("asset",asset);v.put("body",body.toString());if(db.insertWithOnConflict("progress",null,v,SQLiteDatabase.CONFLICT_REPLACE)==-1)throw new android.database.sqlite.SQLiteException("Playback progress outbox could not be saved");
    }
    public void flush(PlaybackApi api)throws Exception{
        JSONArray events=new JSONArray();JSONObject view=null;List<Long> ids=new ArrayList<>();String first=null;
        synchronized(this){try(Cursor c=db.rawQuery("SELECT id,view_id,body FROM events WHERE partition=? ORDER BY id LIMIT 40",new String[]{api.partition})){
            while(c.moveToNext()){if(first!=null&&!first.equals(c.getString(1)))break;first=c.getString(1);JSONObject row=new JSONObject(c.getString(2));view=row.getJSONObject("view");events.put(row.getJSONObject("event"));ids.add(c.getLong(0));}
        }}
        if(view==null)return;
        try{api.json("/analytics/events","POST",new JSONObject().put("view",view).put("events",events));}
        catch(PlaybackApi.Failure failure){if(!Arrays.asList(400,403,404,409,422).contains(failure.status))throw failure;/* Same rejected-batch policy as the web outbox. */}
        synchronized(this){for(Long id:ids)db.delete("events","id=?",new String[]{id.toString()});}
    }
    @Override public synchronized void close(){db.close();}
    public synchronized void clear(String partition){db.delete("events","partition=?",new String[]{partition});db.delete("progress","partition=?",new String[]{partition});}
}
