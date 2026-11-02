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
    public volatile boolean conflicted;
    public volatile JSONObject remotePosition;
    private boolean initialRemoteChecked;
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
        JSONObject saved=store.load();if(saved!=null){revision=saved.optLong("revision",-1);pending=saved.optJSONObject("pending");desired=saved.optJSONObject("desired");last=saved.optJSONObject("last");conflicted=saved.optBoolean("conflicted");remotePosition=saved.optJSONObject("remotePosition");}
        if(localOnly)return;
        try{
            if(pending!=null&&!conflicted){try{send();}catch(PlaybackApi.Failure e){if(e.status==409)conflicted=true;else throw e;}}
            JSONObject initial=remote.call("GET",null);long remoteRevision=initial.getLong("revision");
            if((desired!=null||pending!=null)&&revision>=0&&remoteRevision!=revision)conflicted=true;
            if(conflicted){remotePosition=initial.optJSONObject("progress");persist();return;}
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
    /** Call after local playback begins. A newer remote position never seeks or
     * replaces a local checkpoint without the listener's choice. */
    public void refreshInitialFromRemote()throws Exception{
        if(initialRemoteChecked)return;JSONObject snapshot=remote.call("GET",null),remoteValue=snapshot.optJSONObject("progress");long incoming=snapshot.getLong("revision");
        JSONObject baseline=last!=null?last:pending!=null?pending:desired;
        if(incoming!=revision&&baseline!=null&&(remoteValue==null||baseline.optLong("positionMs")!=remoteValue.optLong("positionMs")||baseline.optBoolean("completed")!=remoteValue.optBoolean("completed"))){conflicted=true;remotePosition=remoteValue;}
        else if(!conflicted&&incoming!=revision){if(desired==null&&pending!=null)desired=new JSONObject(pending.toString());pending=null;if(desired!=null){desired.remove("revision");desired.remove("updateId");}revision=incoming;last=remoteValue;}
        initialRemoteChecked=true;persist();
    }
    // Bind an offline first play to the catalog's known revision. Reading a new
    // revision only on reconnect would silently overwrite another device.
    public void seed(JSONObject value)throws Exception{if(pending!=null||desired!=null||conflicted)return;long incoming=value==null?0:Math.max(0,value.optLong("revision",0));if(revision>=incoming&&revision>=0)return;revision=incoming;last=value==null?null:new JSONObject(value.toString());persist();}
    public void update(long position,long duration)throws Exception{if(duration<=0)return;desired=new JSONObject().put("positionMs",Math.max(0,Math.min(position,duration))).put("durationMs",duration);persist();}
    private void persist()throws Exception{store.save(new JSONObject().put("revision",revision).put("pending",pending==null?JSONObject.NULL:pending).put("desired",desired==null?JSONObject.NULL:desired).put("last",last==null?JSONObject.NULL:last).put("conflicted",conflicted).put("remotePosition",remotePosition==null?JSONObject.NULL:remotePosition));}
    public JSONObject resolve(boolean useLocal)throws Exception{
        JSONObject snapshot=remote.call("GET",null),local=desired!=null?new JSONObject(desired.toString()):pending!=null?new JSONObject(pending.toString()):null;
        revision=snapshot.getLong("revision");last=snapshot.optJSONObject("progress");pending=null;conflicted=false;remotePosition=null;
        desired=useLocal?local:null;if(desired!=null){desired.remove("revision");desired.remove("updateId");}persist();
        if(useLocal)flush();return initial();
    }
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
        }catch(PlaybackApi.Failure failure){if(failure.status==409){conflicted=true;persist();try{remotePosition=remote.call("GET",null).optJSONObject("progress");persist();}catch(Exception unavailable){/* Keep local position even while the server is unreachable. */}}throw failure;}
    }
}
