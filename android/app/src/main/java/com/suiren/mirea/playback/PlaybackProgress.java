package com.suiren.mirea.playback;

import org.json.*;
import java.util.*;

/** Retry exact IDs/revisions; never silently overwrite another device on 409. */
public final class PlaybackProgress {
    public interface Transport {JSONObject call(String method,JSONObject body)throws Exception;}
    public interface Store {JSONObject load()throws Exception;void save(JSONObject value)throws Exception;}
    private final Transport remote;
    private final Store store;
    private long revision;
    private JSONObject pending,desired;
    public boolean conflicted;
    public PlaybackProgress(PlaybackApi api,PlaybackJournal journal,String asset)throws Exception{
        this((method,body)->api.json("/items/"+asset+"/progress",method,body),new Store(){public JSONObject load()throws Exception{return journal.progress(api.partition,asset);}public void save(JSONObject value){journal.progress(api.partition,asset,value);}});
    }
    public PlaybackProgress(Transport remote,Store store)throws Exception{
        this.remote=remote;this.store=store;
        JSONObject saved=store.load();if(saved!=null){revision=saved.optLong("revision",-1);pending=saved.optJSONObject("pending");desired=saved.optJSONObject("desired");}
        if(pending!=null){try{send();}catch(PlaybackApi.Failure e){if(e.status==409){pending=null;desired=null;store.save(null);}else throw e;}}
        JSONObject initial=remote.call("GET",null);long remoteRevision=initial.getLong("revision");
        if(desired!=null&&saved!=null&&revision>=0&&remoteRevision!=revision){desired=null;store.save(null);}
        revision=remoteRevision;
        if(desired!=null)flush();
    }
    public JSONObject initial()throws Exception{return remote.call("GET",null).optJSONObject("progress");}
    public void update(long position,long duration)throws Exception{if(conflicted||duration<=0)return;desired=new JSONObject().put("positionMs",Math.max(0,Math.min(position,duration))).put("durationMs",duration);persist();}
    private void persist()throws Exception{store.save(new JSONObject().put("revision",revision).put("pending",pending==null?JSONObject.NULL:pending).put("desired",desired==null?JSONObject.NULL:desired));}
    private void send()throws Exception{
        JSONObject response=remote.call("PUT",pending);revision=response.getJSONObject("progress").getLong("revision");
        if(desired!=null&&desired.optLong("positionMs")==pending.optLong("positionMs")&&desired.optLong("durationMs")==pending.optLong("durationMs"))desired=null;
        pending=null;persist();
    }
    public void flush()throws Exception{
        if(conflicted)return;
        try{
            if(pending!=null)send();
            if(desired!=null){pending=new JSONObject(desired.toString()).put("revision",revision).put("updateId",UUID.randomUUID().toString());persist();send();}
        }catch(PlaybackApi.Failure failure){if(failure.status==409){conflicted=true;pending=null;desired=null;store.save(null);}throw failure;}
    }
}
