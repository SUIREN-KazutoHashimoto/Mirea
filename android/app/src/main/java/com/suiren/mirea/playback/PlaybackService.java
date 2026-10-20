package com.suiren.mirea.playback;

import android.app.*;
import android.content.*;
import android.media.*;
import android.media.session.*;
import android.os.*;
import android.view.Surface;
import com.suiren.mirea.R;
import com.suiren.mirea.update.UpdateEngine;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Playback and durable checkpoints live independently of the Capacitor Activity. */
public final class PlaybackService extends Service {
    public static final String EVENT="com.suiren.mirea.PLAYBACK_CHANGED";
    public static volatile PlaybackService current;
    private static final Map<String,JSONObject> requests=new ConcurrentHashMap<>();
    public static void discard(String id){requests.remove(id);}
    public static String offer(JSONObject request){String id=UUID.randomUUID().toString();requests.put(id,request);return id;}
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    public final CompletableFuture<Void> stopped=new CompletableFuture<>();
    private final java.util.concurrent.atomic.AtomicBoolean syncQueued=new java.util.concurrent.atomic.AtomicBoolean();
    private MediaPlayer player;
    public android.graphics.Bitmap artwork;
    private PlaybackSource source;
    private PlaybackApi api;
    private PlaybackJournal journal;
    private PlaybackProgress progress;
    private PlaybackRecorder recorder;
    private MediaSession session;
    private AudioManager audioManager;
    private AudioFocusRequest focus;
    private boolean ownsAudioFocus,ducked;
    private BroadcastReceiver noisy;
    private JSONObject item,request;
    private JSONArray qualities=new JSONArray();
    private String quality="legacy",error="",nextTitle="";
    private boolean prepared,seeking,buffering,foreground,pip,resumeFocus,continuous=true,ended,destroyed;
    private int generation,volume=100;
    private long lastInput=SystemClock.elapsedRealtime(),pausedAt;
    private Surface surface;
    private Runnable continuation;
    private final Runnable tick=new Runnable(){public void run(){if(destroyed)return;record(null);checkpoint(false);updateSession();if(!playing()&&!buffering&&!foreground&&pausedAt>0&&SystemClock.elapsedRealtime()-pausedAt>300000)stopSelf();main.postDelayed(this,1000);}};

    @Override public void onCreate(){
        super.onCreate();current=this;journal=new PlaybackJournal(this);audioManager=getSystemService(AudioManager.class);
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("mirea-playback","メディア再生",NotificationManager.IMPORTANCE_LOW));
        session=new MediaSession(this,"Mirea playback");session.setCallback(new MediaSession.Callback(){
            @Override public void onPlay(){play();}@Override public void onPause(){pause();}@Override public void onStop(){stopSelf();}
            @Override public void onSeekTo(long position){seek(position);}@Override public void onFastForward(){seek(position()+10000);}@Override public void onRewind(){seek(position()-10000);}
            @Override public void onSkipToNext(){navigate(1);}@Override public void onSkipToPrevious(){navigate(-1);}
        });session.setActive(true);
        focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
            .setOnAudioFocusChangeListener(change->{if(change==AudioManager.AUDIOFOCUS_GAIN){ownsAudioFocus=true;ducked=false;applyVolume();if(resumeFocus){resumeFocus=false;play();}}
                else if(change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK){ducked=true;applyVolume();}
                else {ownsAudioFocus=false;ducked=false;boolean resume=playing()&&change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT;pauseInternal(!resume);resumeFocus=resume;}},main).build();
        noisy=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){pause();}};registerReceiver(noisy,new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        main.post(tick);UpdateEngine.setPlaybackBusy(true);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        // Start foreground immediately, before network preparation/audio focus.
        startForeground(1904,notification());
        if(intent==null){stopSelf();return START_NOT_STICKY;}
        String action=intent.getAction();
        if("open".equals(action)){JSONObject next=requests.remove(intent.getStringExtra("request"));if(next==null){stopSelf();return START_NOT_STICKY;}open(next,false,0);}
        else if("play".equals(action))play();else if("pause".equals(action))pause();else if("stop".equals(action))stopSelf();
        else if("next".equals(action))navigate(1);else if("previous".equals(action))navigate(-1);
        return START_NOT_STICKY;
    }
    private void open(JSONObject next,boolean auto,long forcedPosition){
        try{
            JSONObject asset=next.getJSONObject("item");String id=asset.getString("id");
            if(!PlaybackApi.uuid(id)||!Arrays.asList("audio","video").contains(asset.getString("kind")))throw new IOException("Invalid media identity");
            PlaybackApi nextApi=new PlaybackApi(next.getString("origin"),next.getString("token"),next.getString("userId"));
            if(api!=null&&api.partition.equals(nextApi.partition)&&item!=null&&id.equals(item.optString("id"))&&prepared&&!next.optBoolean("restart")&&!next.has("quality")){nextApi.close();changed();return;}
            final int epoch=++generation;cancelContinuation();record("close");checkpoint(true);releasePlayer();
            PlaybackApi old=api;api=nextApi;if(old!=null)old.close();request=next;item=asset;error="";ended=false;prepared=false;seeking=false;buffering=true;quality=next.optString("quality",getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).getString(nextApi.partition,"legacy"));continuous=next.optBoolean("continuous",true);nextTitle="";pausedAt=SystemClock.elapsedRealtime();
            recorder=null;progress=null;qualities=new JSONArray();artwork=null;final String requestedQuality=quality;updateSession();changed();
            io.submit(()->{
                PlaybackSource candidate=null;String resolvedQuality=requestedQuality;JSONArray availableQualities=new JSONArray();android.graphics.Bitmap nextArtwork=null;
                try{
                    PlaybackProgress bookmark=new PlaybackProgress(nextApi,journal,id);JSONObject initial=bookmark.initial();
                    long resume=forcedPosition>0?forcedPosition:next.optBoolean("restart")||initial==null||initial.optBoolean("completed")?0:initial.optLong("positionMs");
                    if(next.has("download")){
                        JSONObject manifest=next.getJSONObject("download"),grant=nextApi.json("/downloads/"+manifest.getString("id")+"/open","POST",null);
                        JSONObject verified=grant.getJSONObject("manifest");if(!verified.getString("assetId").equals(id)||!verified.getString("id").equals(manifest.getString("id")))throw new IOException("Cache identity changed");
                        File folder=new PlaybackCache(this).folder(nextApi.partition,manifest.getString("id"));if(!new File(folder,"complete").isFile())throw new IOException("Encrypted cache incomplete");
                        candidate=new PlaybackSource(nextApi,grant,folder);grant.remove("key");resolvedQuality=verified.getJSONArray("files").getJSONObject(0).optString("quality","download");
                    }else{
                        long size=asset.getLong("size");String path="/api/v1/items/"+id+"/content";
                        if("video".equals(asset.getString("kind"))){JSONObject info=nextApi.json("/items/"+id+"/video","GET",null);availableQualities=info.optJSONArray("renditions");if(availableQualities==null)availableQualities=new JSONArray();resolvedQuality=PlaybackQuality.resolve(availableQualities,resolvedQuality);
                            if(!"legacy".equals(resolvedQuality)){boolean found=false;for(int n=0;n<availableQualities.length();n++){JSONObject r=availableQualities.getJSONObject(n);if(resolvedQuality.equals(r.getString("quality"))){size=r.getLong("size");String mediaGeneration=info.optString("generation","base");if(!mediaGeneration.equals("base")&&!mediaGeneration.matches("[0-9a-f-]{36}"))throw new IOException("Invalid media generation");path="/api/v1/items/"+id+"/renditions/"+resolvedQuality+"/content?generation="+mediaGeneration;found=true;break;}}if(!found)throw new IOException("Quality unavailable");}}
                        if(size<1||size>8589934592L)throw new IOException("Invalid media size");candidate=new PlaybackSource(nextApi,path,size);
                    }
                    try{java.net.HttpURLConnection c=nextApi.connection("/api/v1/items/"+id+"/thumbnail","GET");try{if(c.getResponseCode()==200){byte[] bytes=PlaybackApi.read(c.getInputStream(),3*1024*1024);nextArtwork=android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.length);}}finally{c.disconnect();}}catch(Exception ignored){}
                    final PlaybackSource ready=candidate;final String readyQuality=resolvedQuality;final JSONArray readyQualities=availableQualities;final android.graphics.Bitmap readyArtwork=nextArtwork;main.post(()->{if(destroyed||epoch!=generation){ready.close();return;}progress=bookmark;source=ready;quality=readyQuality;qualities=readyQualities;artwork=readyArtwork;prepare(resume,auto||next.optBoolean("autoplay"));});
                }catch(Exception failure){if(candidate!=null)candidate.close();main.post(()->{if(epoch==generation)fail("再生準備に失敗しました。アクセス権・接続・保存データを確認して開き直してください。");});}
            });
        }catch(Exception failure){fail("再生情報が不正です。ライブラリから開き直してください。");}
    }
    private void prepare(long resume,boolean autoplay){
        try{
            MediaPlayer created=new MediaPlayer();player=created;applyVolume();created.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build());created.setWakeMode(getApplicationContext(),PowerManager.PARTIAL_WAKE_LOCK);
            created.setDataSource(source);if(surface!=null)created.setSurface(surface);
            created.setOnPreparedListener(p->{if(player!=p)return;prepared=true;buffering=false;try{if(resume>0){seeking=true;p.seekTo(Math.min(resume,Math.max(0,p.getDuration()-250)),MediaPlayer.SEEK_CLOSEST);}if(autoplay)play();record("ready");changed();}catch(Exception e){fail("再生を開始できません。");}});
            created.setOnSeekCompleteListener(p->{if(player==p){seeking=false;record("seeked");checkpoint(true);changed();}});
            created.setOnInfoListener((p,what,extra)->{if(player==p){if(what==MediaPlayer.MEDIA_INFO_BUFFERING_START)buffering=true;if(what==MediaPlayer.MEDIA_INFO_BUFFERING_END)buffering=false;record("buffering");}return false;});
            created.setOnVideoSizeChangedListener((p,w,h)->changed());
            created.setOnCompletionListener(p->{if(player!=p)return;ended=true;pausedAt=SystemClock.elapsedRealtime();record("ended");checkpoint(true);updateSession();changed();if(continuous){continuation=()->navigate(1);main.postDelayed(continuation,5000);}});
            created.setOnErrorListener((p,what,extra)->{if(player==p)fail("メディアを再生できません。接続・権限を確認し、再接続してください。");return true;});
            if(request.optBoolean("analytics")){recorder=new PlaybackRecorder(item.getString("id"),request.optString("version","development"),SystemClock.elapsedRealtime(),(v,e)->journal.event(api.partition,v,e));}
            record(null);created.prepareAsync();changed();
        }catch(Exception e){fail("メディアを準備できません。");}
    }
    public boolean playing(){try{return prepared&&player!=null&&player.isPlaying();}catch(Exception e){return false;}}
    public long position(){try{return ended?duration():prepared?Math.max(0,player.getCurrentPosition()):0;}catch(Exception e){return 0;}}
    public long duration(){try{return prepared?Math.max(0,player.getDuration()):0;}catch(Exception e){return 0;}}
    public boolean video(){return item!=null&&"video".equals(item.optString("kind"));}
    public void play(){if(!prepared||player==null)return;cancelContinuation();lastInput=SystemClock.elapsedRealtime();try{if(!ownsAudioFocus){if(audioManager.requestAudioFocus(focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){error="他の音声再生が優先されています。再生ボタンで再試行してください。";changed();return;}ownsAudioFocus=true;ducked=false;}applyVolume();if(ended){ended=false;seek(0);}player.start();pausedAt=0;record("play");updateSession();changed();}catch(Exception e){fail("再生を開始できません。");}}
    public void pause(){pauseInternal(true);}
    private void pauseInternal(boolean abandon){cancelContinuation();resumeFocus=false;record(null);try{if(playing())player.pause();}catch(Exception ignored){}pausedAt=SystemClock.elapsedRealtime();record("pause");checkpoint(true);if(abandon){audioManager.abandonAudioFocusRequest(focus);ownsAudioFocus=false;}updateSession();changed();}
    public void seek(long position){if(!prepared)return;cancelContinuation();lastInput=SystemClock.elapsedRealtime();record(null);seeking=true;ended=false;record("seeking");player.seekTo(Math.max(0,Math.min(position,duration())),MediaPlayer.SEEK_CLOSEST);}
    public void speed(float rate){if(!prepared||rate<.5f||rate>2)return;record(null);boolean wasPlaying=playing();player.setPlaybackParams(player.getPlaybackParams().setSpeed(rate));if(!wasPlaying)player.pause();record("rate_change");updateSession();}
    public void quality(String value){if(request==null||request.has("download")||!value.matches("[0-9]{2,4}p|legacy"))return;try{getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).edit().putString(api.partition,value).apply();JSONObject next=new JSONObject(request.toString());next.put("quality",value);open(next,playing(),position());}catch(Exception ignored){}}
    public void clearSurface(Surface value){if(surface==value)setSurface(null);}
    private void applyVolume(){if(player!=null){float level=(volume/100f)*(ducked?.2f:1f);player.setVolume(level,level);}}
    public void mute(){volume=volume==0?100:0;applyVolume();record("viewport");changed();}
    public void setSurface(Surface value){surface=value;try{if(player!=null)player.setSurface(value);}catch(Exception ignored){}}
    public void visibility(boolean visible,boolean inPip){if(foreground==visible&&pip==inPip)return;record(null);foreground=visible;pip=inPip;record("visibility");changed();}
    public void continuous(boolean value){continuous=value;try{if(request!=null)request.put("continuous",value);}catch(JSONException ignored){}cancelContinuation();}
    public void cancelContinuation(){if(continuation!=null){main.removeCallbacks(continuation);continuation=null;}}
    public void navigate(int direction){
        if(item==null||api==null)return;cancelContinuation();final int epoch=generation;final PlaybackApi target=api;final String id=item.optString("id");
        io.submit(()->{try{JSONObject context=target.json("/items/"+id+"/series","GET",null);JSONArray items=context.getJSONArray("items");int index=context.getInt("currentIndex")+direction;if(index<0||index>=items.length())return;JSONObject next=items.getJSONObject(index);
            main.post(()->{if(epoch!=generation||destroyed)return;try{if(!Arrays.asList("audio","video").contains(next.optString("kind"))){nextTitle="次は本「"+next.optString("title")+"」です。ライブラリから開いてください。";changed();return;}JSONObject nextRequest=new JSONObject(request.toString());nextRequest.put("item",next).put("restart",direction>0&&ended).put("autoplay",playing()||ended).remove("download");nextRequest.remove("quality");open(nextRequest,true,0);}catch(Exception e){fail("次のアセットを開けません。");}});
        }catch(Exception failure){main.post(()->{if(epoch==generation)fail("シリーズのアクセス権を確認できません。接続を確認してください。");});}});
    }
    public void reconnect(){if(request==null)return;try{open(new JSONObject(request.toString()).put("quality",quality),playing(),position());}catch(Exception ignored){}}
    private float playbackRate(){try{return prepared?player.getPlaybackParams().getSpeed():1f;}catch(Exception ignored){return 1f;}}
    private JSONObject snapshot()throws Exception{
        float rate=playbackRate();
        return new JSONObject().put("visible",foreground||pip).put("focused",foreground&&!pip).put("idle",!playing()&&SystemClock.elapsedRealtime()-lastInput>120000)
            .put("backgroundPlayback",!foreground&&!pip).put("pictureInPicture",pip).put("playing",playing()).put("seeking",seeking).put("buffering",buffering).put("rate",rate).put("toMs",position())
            .put("durationMs",Math.max(1,duration())).put("muted",volume==0).put("volume",volume/100d).put("selectedQuality",quality).put("actualQuality",quality).put("streamKind",request!=null&&request.has("download")?"download":"mp4");
    }
    private void record(String event){if(recorder==null)return;try{if("close".equals(event)){recorder.close(SystemClock.elapsedRealtime(),snapshot());recorder=null;}else recorder.sample(SystemClock.elapsedRealtime(),snapshot(),event);}catch(Exception failure){error="再生記録を端末へ保存できません。空き容量を確認してください。";}}
    private int ticks;
    private void checkpoint(boolean force){
        if(progress==null||!prepared||seeking)return;if(!force&&++ticks%5!=0)return;
        PlaybackProgress bookmark=progress;PlaybackApi target=api;long position=position(),duration=duration();int epoch=generation;
        if(!force&&!syncQueued.compareAndSet(false,true))return;if(force)syncQueued.set(true);
        io.submit(()->{try{bookmark.update(position,duration);bookmark.flush();journal.flush(target);}catch(PlaybackApi.Failure failure){main.post(()->{if(epoch!=generation)return;if(failure.denied())fail("アクセス権またはログインが失効したため再生を停止しました。");else if(failure.status==409){error="別の端末で続き位置が更新されました。保存を停止しています。";changed();}});}catch(Exception ignored){/* Exact pending update and raw events remain durable for retry. */}finally{syncQueued.set(false);}});
    }
    private void releasePlayer(){MediaPlayer old=player;player=null;prepared=false;if(old!=null){try{old.setSurface(null);old.release();}catch(Exception ignored){}}PlaybackSource oldSource=source;source=null;if(oldSource!=null)io.submit(oldSource::close);}
    private void fail(String message){audioManager.abandonAudioFocusRequest(focus);ownsAudioFocus=false;cancelContinuation();record("error");checkpoint(true);releasePlayer();buffering=false;error=message;pausedAt=SystemClock.elapsedRealtime();updateSession();changed();}
    public JSONObject status(){try{return new JSONObject().put("active",item!=null).put("item",item==null?JSONObject.NULL:item).put("playing",playing()).put("prepared",prepared).put("buffering",buffering).put("rate",playbackRate()).put("muted",volume==0).put("positionMs",position()).put("durationMs",duration()).put("video",video()).put("error",error).put("notice",nextTitle).put("quality",quality).put("qualities",qualities).put("download",request!=null&&request.has("download")).put("continuous",continuous).put("width",prepared?Math.max(1,player.getVideoWidth()):16).put("height",prepared?Math.max(1,player.getVideoHeight()):9);}catch(Exception e){return new JSONObject();}}
    private PendingIntent action(String value){return PendingIntent.getService(this,value.hashCode(),new Intent(this,PlaybackService.class).setAction(value),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    public PendingIntent activityIntent(){return PendingIntent.getActivity(this,1904,new Intent(this,PlaybackActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private Notification notification(){
        return new Notification.Builder(this,"mirea-playback").setSmallIcon(R.drawable.mirea_icon).setContentTitle(item==null?"Mirea":item.optString("title","Mirea"))
            .setContentText(error.isEmpty()?(video()?"動画 · バックグラウンド再生":"音楽 · バックグラウンド再生"):error).setContentIntent(activityIntent()).setDeleteIntent(action("stop")).setOnlyAlertOnce(true).setOngoing(playing()).setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,"前へ",action("previous")).build())
            .addAction(new Notification.Action.Builder(playing()?android.R.drawable.ic_media_pause:android.R.drawable.ic_media_play,playing()?"一時停止":"再生",action(playing()?"pause":"play")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,"次へ",action("next")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,"停止",action("stop")).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0,1,2)).build();
    }
    private void updateSession(){if(session==null)return;
        session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,item==null?"Mirea":item.optString("title")).putString(MediaMetadata.METADATA_KEY_ARTIST,"Mirea").putLong(MediaMetadata.METADATA_KEY_DURATION,duration()).build());
        session.setPlaybackState(new PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY|PlaybackState.ACTION_PAUSE|PlaybackState.ACTION_STOP|PlaybackState.ACTION_SEEK_TO|PlaybackState.ACTION_FAST_FORWARD|PlaybackState.ACTION_REWIND|PlaybackState.ACTION_SKIP_TO_NEXT|PlaybackState.ACTION_SKIP_TO_PREVIOUS)
            .setState(playing()?PlaybackState.STATE_PLAYING:buffering?PlaybackState.STATE_BUFFERING:PlaybackState.STATE_PAUSED,position(),playing()?playbackRate():0f).build());
        // This is the existing foreground service notification, with a live
        // MediaSession token (notification-permission media-session exemption).
        startForeground(1904,notification());
    }
    private void changed(){sendBroadcast(new Intent(EVENT).setPackage(getPackageName()));}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onTaskRemoved(Intent root){if(!playing())stopSelf();}
    @Override public void onDestroy(){destroyed=true;generation++;cancelContinuation();main.removeCallbacks(tick);record("close");checkpoint(true);releasePlayer();audioManager.abandonAudioFocusRequest(focus);try{unregisterReceiver(noisy);}catch(Exception ignored){}session.release();stopForeground(STOP_FOREGROUND_REMOVE);if(api!=null)api.close();io.submit(()->{try{journal.close();}finally{stopped.complete(null);}});io.shutdown();current=null;UpdateEngine.setPlaybackBusy(false);changed();super.onDestroy();}
}
