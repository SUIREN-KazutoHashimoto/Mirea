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
    private final ExecutorService preparation=Executors.newSingleThreadExecutor(),metadata=Executors.newSingleThreadExecutor(),cleanup=Executors.newSingleThreadExecutor();
    private final PlaybackRetry retry=new PlaybackRetry();
    private android.net.ConnectivityManager connectivity;
    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    public final CompletableFuture<Void> stopped=new CompletableFuture<>();
    private final java.util.concurrent.atomic.AtomicBoolean syncQueued=new java.util.concurrent.atomic.AtomicBoolean();
    private MediaPlayer player;
    private AdaptivePlayback adaptive;
    private String hlsGeneration;
    private String contentPath;private long contentSize;
    public JSONObject navigation;
    public android.graphics.Bitmap storyboard;
    private String captionId="off";
    public android.graphics.Bitmap artwork;
    private PlaybackSource source;
    private PlaybackApi api;
    private PlaybackJournal journal;
    private PlaybackProgress progress;
    private PlaybackRecorder recorder;
    private MediaSession session;
    private boolean notificationStarted;private String metadataIdentity="",notificationIdentity="";private android.graphics.Bitmap metadataArtwork,notificationArtwork;private long sessionUpdated,lastSessionPosition;private int lastSessionState=-1;private float lastSessionRate;
    private AudioManager audioManager;
    private AudioFocusRequest focus;
    private boolean ownsAudioFocus,ducked;
    private BroadcastReceiver noisy;
    private JSONObject item,request;
    private volatile String progressIdentity="";
    private JSONArray qualities=new JSONArray();
    private String quality="legacy",error="",nextTitle="";
    private boolean prepared,seeking,buffering,foreground,pip,resumeFocus,continuous=true,ended,destroyed,resumeAfterSeek;
    private boolean desiredPlaying,retryAutoplay;
    private long rememberedPosition,rememberedDuration;
    private float selectedRate=1f;
    private int generation,volume=100,transitionEpoch;
    private String repeat="off";private boolean shuffle;private PlaybackOrder order=new PlaybackOrder();
    private boolean holdBoost;
    private float boostRestoreRate=1f;
    private JSONObject heatmap;
    private long lastInput=SystemClock.elapsedRealtime(),pausedAt;
    private Surface surface;
    private Runnable continuation;
    private final Runnable tick=new Runnable(){public void run(){if(destroyed)return;if(prepared){rememberedPosition=position();rememberedDuration=duration();}record(null);checkpoint(false);updateSession();if(!foreground)sendBroadcast(new Intent(EVENT).setPackage(getPackageName()).putExtra("progressOnly",true));if(!playing()&&!buffering&&!foreground&&pausedAt>0&&SystemClock.elapsedRealtime()-pausedAt>300000)stopSelf();main.postDelayed(this,1000);}};

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
                else {ownsAudioFocus=false;ducked=false;boolean resume=desiredPlaying&&change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT;pauseInternal(!resume);resumeFocus=resume;}},main).build();
        noisy=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){pause();}};registerReceiver(noisy,new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        connectivity=getSystemService(android.net.ConnectivityManager.class);
        networkCallback=new android.net.ConnectivityManager.NetworkCallback(){@Override public void onAvailable(android.net.Network network){retry.connected();}};
        try{if(connectivity!=null)connectivity.registerDefaultNetworkCallback(networkCallback);}catch(SecurityException ignored){}
        main.post(tick);UpdateEngine.setPlaybackBusy(true);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        // Start foreground immediately, before network preparation/audio focus.
        startForeground(1904,notification());notificationStarted=true;
        if(intent==null){stopSelf();return START_NOT_STICKY;}
        String action=intent.getAction();
        if("open".equals(action)){JSONObject next=requests.remove(intent.getStringExtra("request"));if(next==null){stopSelf();return START_NOT_STICKY;}open(next,false,-1);}
        else if("play".equals(action))play();else if("pause".equals(action))pause();else if("stop".equals(action))stopSelf();
        else if("next".equals(action))navigate(1);else if("previous".equals(action))navigate(-1);
        return START_NOT_STICKY;
    }
    private void open(JSONObject next,boolean auto,long forcedPosition){
        try{
            JSONObject asset=next.getJSONObject("item");String id=asset.getString("id");
            if(!PlaybackApi.uuid(id)||!Arrays.asList("audio","video").contains(asset.getString("kind")))throw new IOException("Invalid media identity");
            PlaybackApi nextApi=new PlaybackApi(next.getString("origin"),next.getString("token"),next.getString("userId"),next.optString("shelfUnlock",""));
            if(api!=null&&api.partition.equals(nextApi.partition)&&item!=null&&id.equals(item.optString("id"))&&prepared&&!next.optBoolean("restart")&&!next.has("quality")&&request.has("download")==next.has("download")){nextApi.close();changed();return;}
            boolean sameOrder=api!=null&&api.partition.equals(nextApi.partition)&&(next.optBoolean("orderContinuation")||item!=null&&id.equals(item.optString("id")));if(!sameOrder)order=new PlaybackOrder();
            endBoost();final int epoch=++generation;cancelContinuation();record("close");checkpoint(true);if(api!=null)api.close();releasePlayer();
            api=nextApi;request=next;item=asset;android.content.SharedPreferences modes=getSharedPreferences("mirea-playback-modes",MODE_PRIVATE);repeat=next.optString("repeat",modes.getString(nextApi.partition+":repeat","off"));if(!Arrays.asList("off","one","series").contains(repeat))repeat="off";shuffle=next.optBoolean("shuffle",modes.getBoolean(nextApi.partition+":shuffle",false));error="";ended=false;prepared=false;seeking=false;buffering=true;quality=next.optString("quality",getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).getString(nextApi.partition,"legacy"));continuous=next.optBoolean("continuous",true);nextTitle="";pausedAt=SystemClock.elapsedRealtime();
            progressIdentity=nextApi.partition+"|"+id;desiredPlaying=auto||next.optBoolean("autoplay");retryAutoplay=desiredPlaying;rememberedPosition=Math.max(0,forcedPosition);rememberedDuration=0;
            if(next.optBoolean("offline"))retry.unavailable(SystemClock.elapsedRealtime());
            recorder=null;progress=null;qualities=new JSONArray();artwork=null;heatmap=null;navigation=null;storyboard=null;hlsGeneration=null;captionId=getSharedPreferences("mirea-captions",MODE_PRIVATE).getString("language","off");final String requestedQuality=next.has("quality")?quality:networkQuality(nextApi);updateSession();changed();
            preparation.submit(()->{
                PlaybackSource candidate=null;String resolvedQuality=requestedQuality,adaptiveGeneration=null,progressivePath=null;long progressiveSize=0;JSONArray availableQualities=new JSONArray();android.graphics.Bitmap nextArtwork=null;
                try{
                    boolean offline=next.has("download")&&next.optBoolean("offline");PlaybackProgress bookmark=new PlaybackProgress(nextApi,journal,id,next.has("download"));if(next.has("download"))bookmark.seed(asset.optJSONObject("progress"));JSONObject initial=bookmark.initial();if(initial==null)initial=asset.optJSONObject("progress");
                    long resume=forcedPosition>=0?forcedPosition:next.optBoolean("restart")||initial==null||initial.optBoolean("completed")?0:initial.optLong("positionMs");
                    if(next.has("download")){
                        // The bridge already authorizes (with a cached-lease fallback).
                        // Starting a saved file must not wait for another network request.
                        JSONObject manifest=next.getJSONObject("download"),grant=new OfflineLease(this).load(nextApi,manifest.getString("id"));
                        JSONObject verified=grant.getJSONObject("manifest");if(!verified.getString("assetId").equals(id)||!verified.getString("id").equals(manifest.getString("id")))throw new IOException("Cache identity changed");
                        File folder=new PlaybackCache(this).folder(nextApi.partition,manifest.getString("id"));if(!new File(folder,"complete").isFile())throw new IOException("Encrypted cache incomplete");
                        candidate=new PlaybackSource(nextApi,grant,folder);grant.remove("key");resolvedQuality=verified.getJSONArray("files").getJSONObject(0).optString("quality","download");
                    }else{
                        JSONObject ticket=nextApi.json("/items/"+id+"/playback-ticket","POST",null);long size=ticket.optLong("size",asset.getLong("size"));String path=ticket.optBoolean("original")?ticket.getString("url"):"/api/v1/items/"+id+"/content";
                        if("video".equals(asset.getString("kind"))){JSONObject info=nextApi.json("/items/"+id+"/video","GET",null);availableQualities=info.optJSONArray("renditions");if(availableQualities==null)availableQualities=new JSONArray();resolvedQuality=PlaybackQuality.resolve(availableQualities,resolvedQuality);
                            if(!"legacy".equals(resolvedQuality)){adaptiveGeneration=info.optString("generation","base");if(!adaptiveGeneration.equals("base")&&!PlaybackApi.uuid(adaptiveGeneration))throw new IOException("Invalid media generation");}}
                        if(adaptiveGeneration==null){if(size<1||size>8589934592L)throw new IOException("Invalid media size");progressivePath=path;progressiveSize=size;}
                    }
                    if(next.optString("artwork").length()<=350000&&!next.optString("artwork").isEmpty())try{byte[] cover=Base64.getDecoder().decode(next.getString("artwork"));nextArtwork=PlaybackArtwork.decode(cover);Arrays.fill(cover,(byte)0);}catch(Exception ignored){}
                    final PlaybackSource ready=candidate;final String readyQuality=resolvedQuality,readyGeneration=adaptiveGeneration,readyPath=progressivePath;final long readySize=progressiveSize;final JSONArray readyQualities=availableQualities;final android.graphics.Bitmap readyArtwork=nextArtwork;main.post(()->{if(destroyed||epoch!=generation){if(ready!=null)ready.close();return;}progress=bookmark;source=ready;hlsGeneration=readyGeneration;contentPath=readyPath;contentSize=readySize;quality=readyQuality;qualities=readyQualities;artwork=readyArtwork;rememberedPosition=resume;prepare(resume,desiredPlaying);});
                    if(nextArtwork==null&&!offline)metadata.submit(()->{try{java.net.HttpURLConnection c=nextApi.connection("/api/v1/items/"+id+"/thumbnail","GET");try{if(c.getResponseCode()==200){android.graphics.Bitmap cover=PlaybackArtwork.decode(PlaybackApi.read(c.getInputStream(),3*1024*1024));main.post(()->{if(!destroyed&&epoch==generation){artwork=cover;updateSession();changed();}});}}finally{c.disconnect();}}catch(Exception ignored){}});
                    if(!offline&&"video".equals(asset.optString("kind")))metadata.submit(()->{try{final JSONObject graph=nextApi.json("/items/"+id+"/replay-heatmap","GET",null);main.post(()->{if(!destroyed&&epoch==generation){heatmap=graph;changed();}});}catch(Exception ignored){}if(!destroyed&&epoch==generation)loadNavigation(nextApi,id,epoch,0);});
                }catch(Exception failure){
                    if(failure instanceof PlaybackApi.Failure&&((PlaybackApi.Failure)failure).denied()&&next.optJSONObject("download")!=null)try{new OfflineLease(this).revoke(nextApi.partition,next.getJSONObject("download").getString("id"));}catch(Exception ignored){}
                    if(candidate!=null)candidate.close();main.post(()->{if(epoch==generation)fail("再生準備に失敗しました。アクセス権・接続・保存データを確認して開き直してください。");});}
            });
        }catch(Exception failure){fail("再生情報が不正です。ライブラリから開き直してください。");}
    }
    private void prepare(long resume,boolean autoplay){
        try{
            if(hlsGeneration!=null||contentPath!=null){prepareAdaptive(resume,autoplay);return;}
            MediaPlayer created=new MediaPlayer();player=created;applyVolume();created.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build());created.setWakeMode(getApplicationContext(),PowerManager.PARTIAL_WAKE_LOCK);
            created.setDataSource(source);if(surface!=null)created.setSurface(surface);
            created.setOnPreparedListener(p->{if(player!=p)return;prepared=true;buffering=false;try{setRate(selectedRate);if(resume>0){seeking=true;resumeAfterSeek=desiredPlaying;p.seekTo(Math.min(resume,Math.max(0,p.getDuration()-250)),MediaPlayer.SEEK_CLOSEST);}else if(desiredPlaying)play();record("ready");changed();}catch(Exception e){fail("再生を開始できません。");}});
            created.setOnSeekCompleteListener(this::seekComplete);
            created.setOnInfoListener((p,what,extra)->{if(player==p){if(what==MediaPlayer.MEDIA_INFO_BUFFERING_START){endBoost();buffering=true;}if(what==MediaPlayer.MEDIA_INFO_BUFFERING_END)buffering=false;record("buffering");}return false;});
            created.setOnVideoSizeChangedListener((p,w,h)->{if(player==p)changed();});
            created.setOnCompletionListener(p->{if(player!=p)return;endBoost();ended=true;pausedAt=SystemClock.elapsedRealtime();record("ended");checkpoint(true);updateSession();changed();scheduleEnded();});
            created.setOnErrorListener((p,what,extra)->{if(player==p)fail("メディアを再生できません。接続・権限を確認し、再接続してください。");return true;});
            if(request.optBoolean("analytics")){recorder=new PlaybackRecorder(item.getString("id"),request.optString("version","development"),SystemClock.elapsedRealtime(),(v,e)->journal.event(api.partition,v,e));}
            record(null);created.prepareAsync();changed();
        }catch(Exception e){fail("メディアを準備できません。");}
    }
    private void prepareAdaptive(long resume,boolean autoplay)throws Exception{
        final int epoch=generation;
        adaptive=new AdaptivePlayback(this,api,item.getString("id"),hlsGeneration,contentPath,contentSize,qualities,new AdaptivePlayback.Events(){
            public void ready(){if(epoch!=generation||destroyed)return;prepared=true;buffering=false;setRate(selectedRate);if(resume>0)adaptive.player.seekTo(Math.min(resume,Math.max(0,duration()-250)));if(desiredPlaying)play();record("ready");changed();}
            public void buffering(boolean value){if(epoch!=generation)return;if(value)endBoost();buffering=value;record("buffering");}
            public void ended(){if(epoch!=generation)return;endBoost();ended=true;pausedAt=SystemClock.elapsedRealtime();record("ended");checkpoint(true);updateSession();changed();scheduleEnded();}
            public void failed(){if(epoch==generation)fail("配信を再生できません。接続・アクセス権を確認して再接続してください。");}
            public void changed(){if(epoch==generation)PlaybackService.this.changed();}
            public void seeked(){if(epoch==generation){seeking=false;record("seeked");checkpoint(true);changed();}}
        });
        adaptive.quality(quality);adaptive.player.setVideoSurface(surface);applyVolume();
        if(request.optBoolean("analytics"))recorder=new PlaybackRecorder(item.getString("id"),request.optString("version","development"),SystemClock.elapsedRealtime(),(v,e)->journal.event(api.partition,v,e));
        record(null);adaptive.player.prepare();changed();
    }
    private void seekComplete(MediaPlayer p){if(player!=p)return;seeking=false;record("seeked");checkpoint(true);boolean resume=resumeAfterSeek;resumeAfterSeek=false;if(resume)play();changed();}
    public boolean ownsProgress(String partition,String asset){return progressIdentity.equals(partition+"|"+asset);}
    public void revokeDownload(String partition,String id){main.post(()->{if(api!=null&&api.partition.equals(partition)&&request!=null&&request.optJSONObject("download")!=null&&id.equals(request.optJSONObject("download").optString("id")))fail("ダウンロードの閲覧権限が失効しました。");});}
    public boolean playing(){try{return prepared&&(adaptive!=null?adaptive.player.isPlaying():player!=null&&player.isPlaying());}catch(Exception e){return false;}}
    public long position(){try{return ended?duration():prepared?Math.max(0,adaptive!=null?adaptive.player.getCurrentPosition():player.getCurrentPosition()):rememberedPosition;}catch(Exception e){return rememberedPosition;}}
    public long duration(){try{return prepared?Math.max(0,adaptive!=null?adaptive.player.getDuration():player.getDuration()):rememberedDuration;}catch(Exception e){return rememberedDuration;}}
    public boolean video(){return item!=null&&"video".equals(item.optString("kind"));}
    public void play(){desiredPlaying=true;retryAutoplay=true;if(!prepared||player==null&&adaptive==null){if(!error.isEmpty()&&request!=null)reconnect();return;}cancelContinuation();lastInput=SystemClock.elapsedRealtime();try{if(!ownsAudioFocus){if(audioManager.requestAudioFocus(focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){desiredPlaying=false;error="他の音声再生が優先されています。再生ボタンで再試行してください。";changed();return;}ownsAudioFocus=true;ducked=false;}error="";applyVolume();if(player!=null&&seeking){resumeAfterSeek=true;return;}if(ended){ended=false;if(player!=null){seek(0,true);return;}seek(0);}if(adaptive!=null)adaptive.player.play();else player.start();pausedAt=0;record("play");updateSession();changed();}catch(Exception e){fail("再生を開始できません。");}}
    public void pause(){pauseInternal(true);}
    private void pauseInternal(boolean abandon){desiredPlaying=false;retryAutoplay=false;resumeAfterSeek=false;endBoost();cancelContinuation();resumeFocus=false;record(null);try{if(adaptive!=null)adaptive.player.pause();else if(playing())player.pause();}catch(Exception ignored){}pausedAt=SystemClock.elapsedRealtime();record("pause");checkpoint(true);if(abandon){audioManager.abandonAudioFocusRequest(focus);ownsAudioFocus=false;}updateSession();changed();}
    public void seek(long position){seek(position,false);}
    private void seek(long position,boolean resume){resumeAfterSeek=resume;endBoost();if(!prepared)return;cancelContinuation();lastInput=SystemClock.elapsedRealtime();record(null);seeking=true;ended=false;record("seeking");long target=Math.max(0,Math.min(position,duration()));if(adaptive!=null)adaptive.player.seekTo(target);else player.seekTo(target,MediaPlayer.SEEK_CLOSEST);}
    public void speed(float rate){endBoost();if(!Float.isFinite(rate)||rate<.25f||rate>2)return;selectedRate=rate;if(prepared)setRate(rate);changed();}
    private void setRate(float rate){record(null);if(adaptive!=null)adaptive.player.setPlaybackSpeed(rate);else{boolean wasPlaying=playing();player.setPlaybackParams(player.getPlaybackParams().setSpeed(rate));if(!wasPlaying)player.pause();}record("rate_change");updateSession();}
    public boolean startBoost(){if(holdBoost)return true;if(!video()||!playing()||buffering||seeking||!foreground||pip)return false;boostRestoreRate=playbackRate();try{setRate(2f);holdBoost=true;changed();return true;}catch(Exception ignored){return false;}}
    public void endBoost(){if(!holdBoost)return;holdBoost=false;try{if(prepared&&(player!=null||adaptive!=null))setRate(boostRestoreRate);}catch(Exception ignored){fail("再生速度を戻せません。再接続してください。");}changed();}
    private String networkKey(){android.net.ConnectivityManager c=getSystemService(android.net.ConnectivityManager.class);android.net.NetworkCapabilities n=c==null?null:c.getNetworkCapabilities(c.getActiveNetwork());return n!=null&&n.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)?"mobile":"wifi";}
    private String networkQuality(PlaybackApi target){return getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).getString(target.partition+":"+networkKey(),getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).getString(target.partition,"auto"));}
    public void networkPreference(String network,String value){if(api!=null&&Arrays.asList("wifi","mobile").contains(network)&&Arrays.asList("auto","higher","data").contains(value))getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).edit().putString(api.partition+":"+network,value).apply();}
    public void quality(String value){endBoost();if(request==null||request.has("download")||!value.matches("[0-9]{2,4}p|legacy|auto|higher|data"))return;try{value=PlaybackQuality.resolve(qualities,value);getSharedPreferences("mirea-playback-quality",MODE_PRIVATE).edit().putString(api.partition,value).putString(api.partition+":"+networkKey(),value).apply();if(adaptive!=null&&!value.equals("legacy")){record(null);quality=value;request.put("quality",value);adaptive.quality(value);record("quality_change");changed();}else{JSONObject next=new JSONObject(request.toString());next.put("quality",value).put("autoplay",desiredPlaying&&!ended);open(next,false,position());}}catch(Exception ignored){}}
    public void clearSurface(Surface value){if(surface==value)setSurface(null);}
    private void applyVolume(){float level=(volume/100f)*(ducked?.2f:1f);if(adaptive!=null)adaptive.player.setVolume(level);else if(player!=null)player.setVolume(level,level);}
    public void mute(){volume=volume==0?100:0;applyVolume();record("viewport");changed();}
    public void setSurface(Surface value){surface=value;try{if(adaptive!=null)adaptive.player.setVideoSurface(value);else if(player!=null)player.setSurface(value);}catch(Exception ignored){}}
    public void visibility(boolean visible,boolean inPip){if(!visible||inPip)endBoost();if(foreground==visible&&pip==inPip)return;record(null);foreground=visible;pip=inPip;record("visibility");changed();}
    public void continuous(boolean value){continuous=value;try{if(request!=null)request.put("continuous",value);}catch(JSONException ignored){}cancelContinuation();if(value&&ended)scheduleEnded();changed();}
    public void repeat(String value){if(!Arrays.asList("off","one","series").contains(value))return;repeat=value;if(!value.equals("off"))continuous=true;saveModes();cancelContinuation();if(ended)scheduleEnded();changed();}
    public void shuffle(boolean value){shuffle=value;order=new PlaybackOrder();if(value)continuous=true;saveModes();cancelContinuation();if(ended)scheduleEnded();changed();}
    private void saveModes(){if(api==null)return;getSharedPreferences("mirea-playback-modes",MODE_PRIVATE).edit().putString(api.partition+":repeat",repeat).putBoolean(api.partition+":shuffle",shuffle).apply();try{if(request!=null)request.put("repeat",repeat).put("shuffle",shuffle).put("continuous",continuous);}catch(JSONException ignored){}}
    public void cancelContinuation(){transitionEpoch++;if(continuation!=null){main.removeCallbacks(continuation);continuation=null;}}
    private void scheduleEnded(){if(!continuous)return;final int epoch=transitionEpoch;continuation=()->{if(epoch!=transitionEpoch||destroyed||!ended)return;if(repeat.equals("one"))play();else navigate(1,true);};main.postDelayed(continuation,repeat.equals("one")?100:shuffle||repeat.equals("series")?250:5000);}
    public void navigate(int direction){navigate(direction,false);}
    private void navigate(int direction,boolean automatic){
        if(item==null||api==null)return;cancelContinuation();final int epoch=generation,transition=transitionEpoch;final PlaybackApi target=api;final String id=item.optString("id");final JSONObject offlineRequest=request!=null&&request.optBoolean("offline")?request:null;
        final JSONObject cachedRequest=request;
        metadata.submit(()->{try{JSONObject context;boolean cached=false;try{if(offlineRequest!=null&&!retry.ready(SystemClock.elapsedRealtime()))throw new IOException("offline");context=target.json("/items/"+id+"/series","GET",null);retry.connected();}catch(IOException unavailable){if(unavailable instanceof PlaybackApi.Failure&&((PlaybackApi.Failure)unavailable).denied())throw unavailable;if(cachedRequest==null||!cachedRequest.has("offlineSeries"))throw unavailable;context=OfflineSeries.context(cachedRequest,id);cached=true;retry.unavailable(SystemClock.elapsedRealtime());}final boolean cachedContext=cached;JSONArray entries=context.getJSONArray("items");int current=context.optInt("currentIndex",-1);JSONObject series=context.optJSONObject("series");
            main.post(()->{if(epoch!=generation||transition!=transitionEpoch||destroyed)return;try{
                JSONObject original=item.optJSONObject("series");if(series==null||current<0||current>=entries.length()||!entries.getJSONObject(current).getString("id").equals(id)||original!=null&&!original.optString("id").equals(series.optString("id"))){nextTitle="シリーズの所属を確認できません。閉じて開き直してください。";changed();return;}
                JSONObject next;PlaybackOrder.Plan plan=null;
                if(shuffle||repeat.equals("series")){plan=order.plan(entries,id,series.getString("id"),direction,repeat.equals("series"),shuffle);next=plan==null?null:plan.target;}
                else{int index=current+direction;next=index<0||index>=entries.length()?null:entries.getJSONObject(index);}
                if(next==null){nextTitle="シリーズの最後（または先頭）の作品です。";changed();return;}
                if(!Arrays.asList("audio","video").contains(next.optString("kind"))){nextTitle="次は本「"+next.optString("title")+"」です。ライブラリから開いてください。";changed();return;}
                if(cachedContext&&next.optJSONObject("offlineDownload")==null){nextTitle="次の作品は未保存・期限切れのため、オフラインでは開けません。";changed();return;}
                if(plan!=null)order=plan.order;if(next.getString("id").equals(id)){if(automatic)play();return;}
                JSONObject nextRequest=cachedContext?OfflineSeries.nextRequest(cachedRequest,next,automatic||direction>0&&ended,playing()||ended||automatic):new JSONObject(request.toString());if(!cachedContext)nextRequest.put("item",next).put("offline",false).put("restart",automatic||direction>0&&ended).put("autoplay",playing()||ended||automatic).put("orderContinuation",true).remove("download");nextRequest.remove("quality");nextRequest.remove("artwork");open(nextRequest,false,-1);
            }catch(Exception e){fail("次のアセットを開けません。");}});
        }catch(Exception failure){main.post(()->{if(epoch==generation&&transition==transitionEpoch){nextTitle="シリーズのアクセス権を確認できません。接続を確認してから再試行してください。";changed();}});}});
    }
    public void reconnect(){if(request==null)return;try{retry.connected();open(new JSONObject(request.toString()).put("quality",quality).put("autoplay",error.isEmpty()?desiredPlaying:retryAutoplay),false,position());}catch(Exception ignored){}}
    private float playbackRate(){try{return prepared?adaptive!=null?adaptive.player.getPlaybackParameters().speed:player.getPlaybackParams().getSpeed():selectedRate;}catch(Exception ignored){return selectedRate;}}
    private JSONObject snapshot()throws Exception{
        float rate=playbackRate();
        return new JSONObject().put("visible",foreground||pip).put("focused",foreground&&!pip).put("idle",!playing()&&SystemClock.elapsedRealtime()-lastInput>120000)
            .put("backgroundPlayback",!foreground&&!pip).put("pictureInPicture",pip).put("playing",playing()).put("seeking",seeking).put("buffering",buffering).put("rate",rate).put("toMs",position())
            .put("durationMs",Math.max(1,duration())).put("muted",volume==0).put("volume",volume/100d).put("selectedQuality",Arrays.asList("higher","data").contains(quality)?"auto":quality).put("actualQuality",hlsGeneration!=null&&adaptive!=null?adaptive.actual():quality).put("streamKind",request!=null&&request.has("download")?"download":hlsGeneration!=null?"hls":"mp4");
    }
    private void record(String event){if(recorder==null)return;try{if("close".equals(event)){recorder.close(SystemClock.elapsedRealtime(),snapshot());recorder=null;}else recorder.sample(SystemClock.elapsedRealtime(),snapshot(),event);}catch(Exception failure){error="再生記録を端末へ保存できません。空き容量を確認してください。";}}
    private int ticks;
    private void checkpoint(boolean force){
        if(progress==null||!prepared||seeking)return;if(!force&&++ticks%5!=0)return;
        PlaybackProgress bookmark=progress;PlaybackApi target=api;PlaybackSource activeSource=source;String download=request!=null&&request.optJSONObject("download")!=null?request.optJSONObject("download").optString("id"):null;String asset=item.optString("id");long position=position(),duration=duration();int epoch=generation;boolean renew=force||ticks%30==0;
        if(!force&&!syncQueued.compareAndSet(false,true))return;if(force)syncQueued.set(true);
        io.submit(()->{try{bookmark.update(position,duration);
            if(download!=null){
                // Bound an active session even if the decoder has buffered ahead.
                JSONObject lease=new OfflineLease(this).load(target,download);lease.remove("key");
                if(activeSource!=null&&epoch==generation)activeSource.renew(lease.getLong("expiresAt"));
            }
            if(!retry.ready(SystemClock.elapsedRealtime())||connectivity!=null&&connectivity.getActiveNetwork()==null)return;
            try(PlaybackApi remote=target.background()){
                if(download!=null&&renew){JSONObject renewed=new OfflineLease(this).authorize(remote,download);if(activeSource!=null&&epoch==generation)activeSource.renew(renewed.getLong("expiresAt"));renewed.remove("key");}
                bookmark.transport(remote,asset);bookmark.flush();journal.flush(remote);retry.connected();
            }
        }catch(PlaybackApi.Failure failure){retry.unavailable(SystemClock.elapsedRealtime());main.post(()->{if(epoch!=generation||destroyed)return;if(failure.denied()){
                    if(download!=null)try{new OfflineLease(this).revoke(target.partition,download);}catch(Exception ignored){}
                    fail("アクセス権またはログインが失効したため再生を停止しました。");
                }else if(failure.status==409){error="別の端末で続き位置が更新されました。保存を停止しています。";changed();}});}catch(IllegalStateException expired){main.post(()->{if(epoch==generation&&!destroyed)fail("オフライン視聴期限が切れています。オンラインで接続してください。");});}
        catch(Exception ignored){retry.unavailable(SystemClock.elapsedRealtime());/* Exact pending update and raw events remain durable for retry. */}finally{syncQueued.set(false);}});
    }
    private void releasePlayer(){resumeAfterSeek=false;endBoost();AdaptivePlayback oldAdaptive=adaptive;adaptive=null;if(oldAdaptive!=null){oldAdaptive.player.clearVideoSurface();oldAdaptive.player.release();}MediaPlayer old=player;player=null;prepared=false;if(old!=null){try{old.setSurface(null);old.release();}catch(Exception ignored){}}PlaybackSource oldSource=source;source=null;if(oldSource!=null)cleanup.submit(oldSource::close);}
    private void loadNavigation(PlaybackApi target,String id,int epoch,int attempt){
        try{JSONObject nav=target.json("/items/"+id+"/navigation","GET",null);String state=nav.optString("state");if(state.equals("missing")&&attempt==0)nav=target.json("/items/"+id+"/navigation/prepare","POST",new JSONObject());
            final JSONObject ready=nav;android.graphics.Bitmap image=null;JSONObject sheet=nav.optJSONObject("storyboard");if(sheet!=null){java.net.HttpURLConnection c=target.connection(sheet.getString("url"),"GET");try{if(c.getResponseCode()==200){byte[] bytes=PlaybackApi.read(c.getInputStream(),8*1024*1024);android.graphics.BitmapFactory.Options options=new android.graphics.BitmapFactory.Options();options.inJustDecodeBounds=true;android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);if(options.outWidth<=1600&&options.outHeight<=1080&&options.outWidth>0&&options.outHeight>0){options.inJustDecodeBounds=false;image=android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);}}}finally{c.disconnect();}}
            final android.graphics.Bitmap bitmap=image;main.post(()->{if(!destroyed&&epoch==generation){navigation=ready;storyboard=bitmap;changed();}});
            if(attempt<20&&Arrays.asList("queued","running","busy").contains(nav.optString("state")))main.postDelayed(()->{if(!destroyed&&epoch==generation&&!target.closed)metadata.submit(()->loadNavigation(target,id,epoch,attempt+1));},3000);
        }catch(Exception ignored){/* Optional navigation must not stop playback. */}
    }
    public void captions(String id){captionId=id;String language="off";if(navigation!=null){JSONArray tracks=navigation.optJSONArray("captions");if(tracks!=null)for(int n=0;n<tracks.length();n++){JSONObject t=tracks.optJSONObject(n);if(t!=null&&id.equals(t.optString("id")))language=t.optString("language","und");}}getSharedPreferences("mirea-captions",MODE_PRIVATE).edit().putString("language",language).apply();changed();}
    public void captionSize(int size){if(size>=14&&size<=32)getSharedPreferences("mirea-captions",MODE_PRIVATE).edit().putInt("size",size).apply();changed();}
    private String captionText(){return VideoNavigation.caption(navigation,captionId,position());}
    private void fail(String message){rememberedPosition=position();rememberedDuration=duration();retryAutoplay=desiredPlaying;audioManager.abandonAudioFocusRequest(focus);ownsAudioFocus=false;cancelContinuation();record("error");checkpoint(true);if(api!=null)api.close();releasePlayer();buffering=false;error=message;pausedAt=SystemClock.elapsedRealtime();updateSession();changed();}
    public JSONObject status(){try{return new JSONObject().put("active",item!=null).put("item",item==null?JSONObject.NULL:item).put("playing",playing()).put("prepared",prepared).put("buffering",buffering).put("rate",holdBoost?boostRestoreRate:playbackRate()).put("holdBoost",holdBoost).put("heatmap",heatmap).put("muted",volume==0).put("positionMs",position()).put("durationMs",duration()).put("video",video()).put("error",error).put("notice",nextTitle).put("quality",quality).put("actualQuality",hlsGeneration!=null&&adaptive!=null?adaptive.actual():quality).put("adaptive",hlsGeneration!=null&&adaptive!=null).put("qualities",qualities).put("caption",captionText()).put("captionSize",getSharedPreferences("mirea-captions",MODE_PRIVATE).getInt("size",20)).put("chapter",VideoNavigation.chapter(navigation,position())).put("download",request!=null&&request.has("download")).put("continuous",continuous).put("repeat",repeat).put("shuffle",shuffle).put("hasSeries",item!=null&&item.optJSONObject("series")!=null).put("width",prepared?Math.max(1,adaptive!=null?adaptive.player.getVideoSize().width:player.getVideoWidth()):16).put("height",prepared?Math.max(1,adaptive!=null?adaptive.player.getVideoSize().height:player.getVideoHeight()):9);}catch(Exception e){return new JSONObject();}}
    public JSONObject dockStatus(){try{return new JSONObject().put("active",item!=null).put("item",item==null?JSONObject.NULL:new JSONObject().put("id",item.optString("id")).put("title",item.optString("title"))).put("playing",playing()).put("positionMs",position()).put("durationMs",duration()).put("video",video());}catch(Exception e){return new JSONObject();}}
    private PendingIntent action(String value){return PendingIntent.getService(this,value.hashCode(),new Intent(this,PlaybackService.class).setAction(value),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    public PendingIntent activityIntent(){return PendingIntent.getActivity(this,1904,new Intent(this,PlaybackActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private Notification notification(){
        return new Notification.Builder(this,"mirea-playback").setSmallIcon(R.drawable.mirea_icon).setContentTitle(item==null?"Mirea":item.optString("title","Mirea"))
            .setLargeIcon(artwork).setContentText(error.isEmpty()?(video()?"動画 · バックグラウンド再生":"音楽 · バックグラウンド再生"):error).setContentIntent(activityIntent()).setDeleteIntent(action("stop")).setOnlyAlertOnce(true).setOngoing(playing()).setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,"前へ",action("previous")).build())
            .addAction(new Notification.Action.Builder(playing()?android.R.drawable.ic_media_pause:android.R.drawable.ic_media_play,playing()?"一時停止":"再生",action(playing()?"pause":"play")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,"次へ",action("next")).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,"停止",action("stop")).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0,1,2)).build();
    }
    private void updateSession(){if(session==null)return;
        String id=item==null?"":item.optString("id"),title=item==null?"Mirea":item.optString("title");long length=duration(),position=position(),now=SystemClock.elapsedRealtime();boolean playing=playing();float rate=playing?playbackRate():0f;
        String identity=id+"|"+title+"|"+length;
        if(!identity.equals(metadataIdentity)||metadataArtwork!=artwork){metadataIdentity=identity;metadataArtwork=artwork;session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,title).putString(MediaMetadata.METADATA_KEY_ARTIST,"Mirea").putLong(MediaMetadata.METADATA_KEY_DURATION,length).putBitmap(MediaMetadata.METADATA_KEY_ART,artwork).putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART,artwork).putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON,artwork).build());}
        int state=playing?PlaybackState.STATE_PLAYING:buffering?PlaybackState.STATE_BUFFERING:PlaybackState.STATE_PAUSED;
        if(state!=lastSessionState||rate!=lastSessionRate||now-sessionUpdated>=5000||Math.abs(position-lastSessionPosition-(now-sessionUpdated)*lastSessionRate)>1000){session.setPlaybackState(new PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY|PlaybackState.ACTION_PAUSE|PlaybackState.ACTION_STOP|PlaybackState.ACTION_SEEK_TO|PlaybackState.ACTION_FAST_FORWARD|PlaybackState.ACTION_REWIND|PlaybackState.ACTION_SKIP_TO_NEXT|PlaybackState.ACTION_SKIP_TO_PREVIOUS).setState(state,position,rate).build());lastSessionState=state;lastSessionRate=rate;lastSessionPosition=position;sessionUpdated=now;}
        String notice=id+"|"+title+"|"+error+"|"+playing;
        if(!notice.equals(notificationIdentity)||notificationArtwork!=artwork){notificationIdentity=notice;notificationArtwork=artwork;if(notificationStarted)getSystemService(NotificationManager.class).notify(1904,notification());else{startForeground(1904,notification());notificationStarted=true;}}
    }
    private void changed(){sendBroadcast(new Intent(EVENT).setPackage(getPackageName()));}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onTaskRemoved(Intent root){if(!playing())stopSelf();}
    @Override public void onDestroy(){destroyed=true;generation++;cancelContinuation();main.removeCallbacks(tick);record("close");checkpoint(true);if(api!=null)api.close();releasePlayer();audioManager.abandonAudioFocusRequest(focus);try{unregisterReceiver(noisy);if(connectivity!=null)connectivity.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}session.release();stopForeground(STOP_FOREGROUND_REMOVE);preparation.shutdown();metadata.shutdownNow();cleanup.shutdown();io.submit(()->{try{preparation.awaitTermination(30,TimeUnit.SECONDS);journal.close();}catch(InterruptedException e){Thread.currentThread().interrupt();}finally{stopped.complete(null);}});io.shutdown();current=null;UpdateEngine.setPlaybackBusy(false);changed();super.onDestroy();}
}
