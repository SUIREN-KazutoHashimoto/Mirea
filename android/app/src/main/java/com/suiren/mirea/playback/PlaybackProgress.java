package com.suiren.mirea.playback;

import org.json.*;
import java.util.*;

/** Retry exact IDs/revisions; never silently overwrite another device on 409. */
public final class PlaybackProgress {
    public interface Transport {JSONObject call(String method,JSONObject body)throws Exception;}
    public interface Store {JSONObject load()throws Exception;void save(JSONObject value)throws Exception;}
    private Transport remote;
    private final Store store;
    private long revision;
    private JSONObject pending,desired,last;
    public boolean conflicted;
    public PlaybackProgress(PlaybackApi api,PlaybackJournal journal,String asset)throws Exception{
        this(api,journal,asset,false);
    }
    public PlaybackProgress(PlaybackApi api,PlaybackJournal journal,String asset,boolean localOnly)throws Exception{
        this((method,body)->api.json("/items/"+asset+"/progress",method,body),new Store(){public JSONObject load()throws Exception{return journal.progress(api.partition,asset);}public void save(JSONObject value){journal.progress(api.partition,asset,value);}},localOnly);
    }
    public PlaybackProgress(Transport remote,Store store)throws Exception{
        this(remote,store,false);
    }
    public PlaybackProgress(Transport remote,Store store,boolean localOnly)throws Exception{
        this.remote=remote;this.store=store;
        revision=-1;
        JSONObject saved=store.load();if(saved!=null){revision=saved.optLong("revision",-1);pending=saved.optJSONObject("pending");desired=saved.optJSONObject("desired");last=saved.optJSONObject("last");}
        if(localOnly)return;
        try{
            if(pending!=null){try{send();}catch(PlaybackApi.Failure e){if(e.status==409){pending=null;desired=null;}else throw e;}}
            JSONObject initial=remote.call("GET",null);long remoteRevision=initial.getLong("revision");
            if(desired!=null&&saved!=null&&revision>=0&&remoteRevision!=revision)desired=null;
            revision=remoteRevision;last=initial.optJSONObject("progress");persist();
            if(desired!=null)flush();
        }catch(PlaybackApi.Failure failure){if(failure.status<500&&failure.status!=429)throw failure;}
        catch(java.io.IOException offline){/* Retain cached revision, position and exact pending IDs. */}
    }
    public JSONObject initial()throws Exception{
        JSONObject local=desired!=null?desired:pending;
        if(local!=null)return new JSONObject(local.toString()).put("completed",local.optLong("durationMs")>0&&local.optLong("positionMs")>=local.optLong("durationMs"));
        return last;
    }
    public void transport(PlaybackApi api,String asset){remote=(method,body)->api.json("/items/"+asset+"/progress",method,body);}
    // Bind an offline first play to the catalog's known revision. Reading a new
    // revision only on reconnect would silently overwrite another device.
    public void seed(JSONObject value)throws Exception{if(revision>=0||last!=null||pending!=null||desired!=null)return;revision=value==null?0:Math.max(0,value.optLong("revision",0));last=value==null?null:new JSONObject(value.toString());persist();}
    public void update(long position,long duration)throws Exception{if(conflicted||duration<=0)return;desired=new JSONObject().put("positionMs",Math.max(0,Math.min(position,duration))).put("durationMs",duration);persist();}
    private void persist()throws Exception{store.save(new JSONObject().put("revision",revision).put("pending",pending==null?JSONObject.NULL:pending).put("desired",desired==null?JSONObject.NULL:desired).put("last",last==null?JSONObject.NULL:last));}
    private void send()throws Exception{
        JSONObject response=remote.call("PUT",pending);last=response.getJSONObject("progress");revision=last.getLong("revision");
        if(desired!=null&&desired.optLong("positionMs")==pending.optLong("positionMs")&&desired.optLong("durationMs")==pending.optLong("durationMs"))desired=null;
        pending=null;persist();
    }
    public void flush()throws Exception{
        if(conflicted)return;
        try{
            if(revision<0){JSONObject initial=remote.call("GET",null);revision=initial.getLong("revision");last=initial.optJSONObject("progress");}
            if(pending!=null)send();
            if(desired!=null){pending=new JSONObject(desired.toString()).put("revision",revision).put("updateId",UUID.randomUUID().toString());persist();send();}
        }catch(PlaybackApi.Failure failure){if(failure.status==409){conflicted=true;pending=null;desired=null;store.save(null);}throw failure;}
    }
}
