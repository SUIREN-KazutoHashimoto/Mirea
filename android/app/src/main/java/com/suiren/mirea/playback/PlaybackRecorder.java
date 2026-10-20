package com.suiren.mirea.playback;

import org.json.*;
import java.util.*;

/** Pure monotonic recorder; native playback, not WebView timers, drives samples. */
public final class PlaybackRecorder {
    public interface Sink {void emit(JSONObject view,JSONObject event)throws Exception;}
    private final JSONObject view;
    private final Sink sink;
    private final long start;
    private long last;
    private int seq;
    private boolean counted,closed;
    private JSONObject previous;
    public PlaybackRecorder(String asset,String version,long now,Sink sink)throws Exception{
        this.start=now;this.last=now;this.sink=sink;view=new JSONObject().put("id",UUID.randomUUID().toString()).put("assetId",asset).put("platform","android").put("context","viewer").put("clientVersion",version);
    }
    private void emit(String type,long now,JSONObject state)throws Exception{
        JSONObject event=new JSONObject(state.toString());event.put("id",UUID.randomUUID().toString()).put("seq",++seq).put("type",type).put("at",System.currentTimeMillis()).put("elapsedMs",Math.min(7*86400000L,Math.max(0,now-start)));sink.emit(view,event);
    }
    public void sample(long now,JSONObject current,String type)throws Exception{
        if(closed)return;long raw=Math.max(0,now-last),interval=Math.min(2000,raw);
        if(previous!=null&&interval>0){
            JSONObject e=new JSONObject(previous.toString());long visible=e.optBoolean("visible")?interval:0,active=visible>0&&e.optBoolean("focused")&&(!e.optBoolean("idle")||e.optBoolean("playing"))?interval:0;
            long from=e.optLong("toMs"),to=current.optLong("toMs"),delta=to-from;double rate=e.optDouble("rate",1);
            long watch=e.optBoolean("playing")&&!e.optBoolean("seeking")&&!current.optBoolean("seeking")&&!e.optBoolean("buffering")&&raw<=2000&&delta>0&&delta<=interval*rate*1.5+300?Math.min(interval,Math.round(delta/rate)):0;
            e.put("fromMs",from).put("toMs",to).put("intervalMs",interval).put("visibleMs",visible).put("activeMs",active).put("watchMs",watch).put("gapMs",raw-interval)
                .put("backgroundMs",e.optBoolean("backgroundPlayback")?watch:0).put("pipMs",e.optBoolean("pictureInPicture")?watch:0);
            emit("interval",now,e);
        }
        if(previous==null)emit("open",now,current);
        last=now;previous=new JSONObject(current.toString());
        if(!counted&&current.optBoolean("playing")&&!current.optBoolean("seeking")&&!current.optBoolean("buffering")){counted=true;emit("view_start",now,current);}
        if(type!=null)emit(type,now,current);
    }
    public void close(long now,JSONObject current)throws Exception{if(closed)return;sample(now,current,"close");closed=true;}
}
