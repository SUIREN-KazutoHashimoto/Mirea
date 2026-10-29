package com.suiren.mirea.playback;

import android.content.Context;
import android.media.MediaPlayer;
import android.media.AudioAttributes;
import android.os.SystemClock;
import org.json.*;
import java.io.*;

/** One speculative, paused decoder. No view, journal or progress is created.
 * The owner must authorize again immediately before transferring ownership. */
final class PlaybackPreload implements AutoCloseable {
    static boolean permitted(Context context){android.app.ActivityManager manager=context.getSystemService(android.app.ActivityManager.class);if(manager==null||manager.isLowRamDevice())return false;android.app.ActivityManager.MemoryInfo memory=new android.app.ActivityManager.MemoryInfo();manager.getMemoryInfo(memory);Runtime runtime=Runtime.getRuntime();return !memory.lowMemory&&runtime.maxMemory()-runtime.totalMemory()+runtime.freeMemory()>=64L*1024*1024;}
    final PlaybackApi api;final JSONObject item,request;
    final String generation,path,quality;final long size,created=SystemClock.elapsedRealtime();
    final JSONArray qualities;final PlaybackSource source;
    private AdaptivePlayback adaptive;private MediaPlayer player;
    private boolean ready,failed,closed,transferred;
    private PlaybackPreload(PlaybackApi api,JSONObject item,JSONObject request,String generation,String path,long size,String quality,JSONArray qualities,PlaybackSource source){this.api=api;this.item=item;this.request=request;this.generation=generation;this.path=path;this.size=size;this.quality=quality;this.qualities=qualities;this.source=source;}
    static PlaybackPreload load(Context context,PlaybackApi api,JSONObject request,String selected)throws Exception{
        JSONObject item=request.getJSONObject("item");String id=item.getString("id"),generation=null,path=null,quality=selected;long size=0;JSONArray qualities=new JSONArray();PlaybackSource source=null;
        if(request.has("download")){
            JSONObject manifest=request.getJSONObject("download"),grant=new OfflineLease(context).load(api,manifest.getString("id")),verified=grant.getJSONObject("manifest");
            if(!verified.getString("assetId").equals(id)||!verified.getString("id").equals(manifest.getString("id")))throw new IOException("Preload identity changed");
            File folder=new PlaybackCache(context).folder(api.partition,manifest.getString("id"));if(!new File(folder,"complete").isFile())throw new IOException("Incomplete preload");
            source=new PlaybackSource(api,grant,folder);grant.remove("key");quality=verified.getJSONArray("files").getJSONObject(0).optString("quality","download");
        }else{
            JSONObject ticket=api.json("/items/"+id+"/playback-ticket","POST",null);size=ticket.optLong("size",item.getLong("size"));path=ticket.optBoolean("original")?ticket.getString("url"):"/api/v1/items/"+id+"/content";
            if(item.optString("kind").equals("video")){JSONObject info=api.json("/items/"+id+"/video","GET",null);qualities=info.optJSONArray("renditions");if(qualities==null)qualities=new JSONArray();quality=PlaybackQuality.resolve(qualities,selected);if(!quality.equals("legacy")){generation=info.optString("generation","base");if(!generation.equals("base")&&!PlaybackApi.uuid(generation))throw new IOException("Invalid preload generation");}}
            if(generation==null&&(size<1||size>8589934592L))throw new IOException("Invalid preload length");
        }
        return new PlaybackPreload(api,item,request,generation,path,size,quality,qualities,source);
    }
    void prepare(Context context){
        if(closed)return;
        try{
            if(source!=null){player=new MediaPlayer();player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build());player.setVolume(0,0);player.setDataSource(source);player.setOnPreparedListener(value->ready=true);player.setOnErrorListener((value,what,extra)->{discardFailed();return true;});player.prepareAsync();}
            else{adaptive=new AdaptivePlayback(context,api,item.optString("id"),generation,path,size,qualities,new AdaptivePlayback.Events(){public void ready(){ready=true;}public void buffering(boolean value){}public void ended(){}public void failed(){discardFailed();}public void changed(){}public void seeked(){}},true);adaptive.quality(quality);adaptive.player.setVolume(0);adaptive.player.prepare();}
        }catch(Exception failure){failed=true;}
    }
    private void discardFailed(){failed=true;new android.os.Handler(android.os.Looper.getMainLooper()).post(this::close);}
    boolean matches(PlaybackApi target,String id){return !closed&&!failed&&ready&&api.sameAuthorization(target)&&item.optString("id").equals(id)&&SystemClock.elapsedRealtime()-created<300000;}
    void authorize(Context context)throws Exception{
        if(request.has("download")){JSONObject grant=new OfflineLease(context).load(api,request.getJSONObject("download").getString("id"));if(source!=null)source.renew(grant.getLong("expiresAt"));grant.remove("key");}
        else api.json("/items/"+item.getString("id")+"/playback-ticket","POST",null);
    }
    void transfer(){transferred=true;}
    boolean isReady(){return ready&&!failed&&!closed;}
    AdaptivePlayback takeAdaptive(){AdaptivePlayback value=adaptive;adaptive=null;return value;}
    MediaPlayer takePlayer(){MediaPlayer value=player;player=null;return value;}
    @Override public void close(){if(closed||transferred)return;closed=true;api.close();if(adaptive!=null){adaptive.player.release();adaptive=null;}if(player!=null){try{player.release();}catch(Exception ignored){}player=null;}if(source!=null)source.close();}
}
