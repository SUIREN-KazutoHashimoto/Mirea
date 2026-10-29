package com.suiren.mirea.playback;

import android.media.MediaPlayer;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.shadows.ShadowMediaPlayer;
import org.robolectric.shadows.util.DataSource;
import org.robolectric.util.ReflectionHelpers;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows=PlaybackActivityTest.RatePlayer.class)
public class PlaybackLifecycleTest {
    @Test public void taskDismissalPausesWithoutDestroyingTheDecoderAndHomeVisibilityKeepsPlaying()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{MediaPlayer player=seed(s,"background-handoff.m4a");s.visibility(true,false);s.play();s.visibility(false,false);assertTrue(s.playing());assertSame(player,ReflectionHelpers.getField(s,"player"));s.onTaskRemoved(new android.content.Intent());assertFalse(s.playing());assertSame(player,ReflectionHelpers.getField(s,"player"));assertEquals(42000,s.position());assertSame(s,PlaybackService.current);}
        finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    static final class ReleaseProbe extends MediaPlayer {PlaybackApi api;boolean cancelledBeforeRelease;@Override public void release(){cancelledBeforeRelease=api.closed;super.release();}}
    static class ParkedExecutor extends java.util.concurrent.AbstractExecutorService {
        boolean stopped;public void execute(Runnable task){}public void shutdown(){stopped=true;}public java.util.List<Runnable> shutdownNow(){stopped=true;return java.util.List.of();}public boolean isShutdown(){return stopped;}public boolean isTerminated(){return stopped;}public boolean awaitTermination(long n,TimeUnit unit){return stopped;}
    }
    private MediaPlayer seed(PlaybackService service,String name)throws Exception{
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(name),new ShadowMediaPlayer.MediaInfo(120000,0));
        MediaPlayer player=new MediaPlayer();player.setDataSource(name);player.prepare();
        player.setPlaybackParams(new android.media.PlaybackParams().allowDefaults().setSpeed(1));
        Shadows.shadowOf(player).setCurrentPosition(42000);
        ReflectionHelpers.setField(service,"player",player);ReflectionHelpers.setField(service,"prepared",true);
        ReflectionHelpers.setField(service,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","audio"));
        return player;
    }
    @Test public void equalizerEditsExposeSettingsWithoutReplacingSeekingOrPausingTheDecoder()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{MediaPlayer player=seed(s,"equalizer.m4a");s.play();long before=s.position();s.equalizer(true,new double[]{6,3,0,-1,-2});JSONObject settings=s.status().getJSONObject("equalizer");assertTrue(settings.getBoolean("enabled"));assertEquals(6,settings.getJSONArray("gains").getDouble(0),0);assertSame(player,ReflectionHelpers.getField(s,"player"));assertTrue(s.playing());assertEquals(before,s.position());JSONObject analytics=ReflectionHelpers.callInstanceMethod(s,"snapshot");assertFalse(analytics.has("equalizer"));s.equalizer(false,new double[]{6,3,0,-1,-2});assertFalse(s.status().getJSONObject("equalizer").getBoolean("enabled"));assertTrue(s.playing());}
        finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void decoderFailureRetainsResumePositionDurationRateAndPauseIntent()throws Exception{
        ServiceController<PlaybackService> controller=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=controller.get();
        try{MediaPlayer p=seed(s,"recover.m4a");s.speed(1.5f);s.play();s.pause();
            ReflectionHelpers.callInstanceMethod(s,"fail",ReflectionHelpers.ClassParameter.from(String.class,"Synthetic connection loss"));
            assertEquals(42000,s.position());assertEquals(120000,s.duration());assertEquals(1.5,s.status().getDouble("rate"),.001);
            assertFalse((Boolean)ReflectionHelpers.getField(s,"retryAutoplay"));assertFalse(s.playing());assertNull(ReflectionHelpers.getField(s,"player"));
        }finally{controller.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void playingConnectionLossRemembersPlayIntentAndPauseDuringPreparationCancelsIt()throws Exception{
        ServiceController<PlaybackService> controller=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=controller.get();
        try{seed(s,"recover-playing.m4a");s.play();ReflectionHelpers.callInstanceMethod(s,"fail",ReflectionHelpers.ClassParameter.from(String.class,"Synthetic connection loss"));assertTrue((Boolean)ReflectionHelpers.getField(s,"retryAutoplay"));assertTrue(s.position()>=42000);s.pause();assertFalse((Boolean)ReflectionHelpers.getField(s,"desiredPlaying"));assertFalse((Boolean)ReflectionHelpers.getField(s,"retryAutoplay"));
        }finally{controller.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void reachabilityBackoffIsBoundedAndNetworkReturnResetsIt(){PlaybackRetry retry=new PlaybackRetry();assertTrue(retry.ready(0));retry.unavailable(0);assertFalse(retry.ready(4999));assertTrue(retry.ready(5000));retry.unavailable(5000);assertFalse(retry.ready(14999));for(int n=0;n<20;n++)retry.unavailable(20000);assertFalse(retry.ready(79999));assertTrue(retry.ready(80000));retry.connected();assertTrue(retry.ready(0));}
    @Test public void pausedQualityChangeAndReconnectKeepPositionSpeedAndDoNotReuseOriginalAutoplayFlag()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{
            java.util.concurrent.ExecutorService preparation=ReflectionHelpers.getField(s,"preparation");preparation.shutdown();ReflectionHelpers.setField(s,"preparation",new ParkedExecutor());
            seed(s,"paused-quality.mp4");JSONObject item=new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","video").put("size",100);
            JSONObject request=new JSONObject().put("origin","https://mirea.example").put("token","a".repeat(43)).put("userId","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").put("item",item).put("autoplay",true);
            ReflectionHelpers.setField(s,"request",request);ReflectionHelpers.setField(s,"item",item);ReflectionHelpers.setField(s,"api",new PlaybackApi(request.getString("origin"),request.getString("token"),request.getString("userId")));
            s.speed(1.5f);s.pause();s.quality("legacy");assertFalse((Boolean)ReflectionHelpers.getField(s,"desiredPlaying"));assertFalse(((JSONObject)ReflectionHelpers.getField(s,"request")).getBoolean("autoplay"));assertEquals(42000,s.position());assertEquals(1.5,s.status().getDouble("rate"),.001);
            s.reconnect();assertEquals(42000,s.position());assertFalse((Boolean)ReflectionHelpers.getField(s,"desiredPlaying"));
        }finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void pausedOfflineSeriesNavigationKeepsPausedIntentAfterOnlineConnectionWasLost()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{
            java.util.concurrent.ExecutorService prep=ReflectionHelpers.getField(s,"preparation"),meta=ReflectionHelpers.getField(s,"metadata");prep.shutdown();meta.shutdown();ReflectionHelpers.setField(s,"preparation",new ParkedExecutor());ReflectionHelpers.setField(s,"metadata",new ParkedExecutor(){@Override public void execute(Runnable task){task.run();}});
            seed(s,"offline-series.m4a");String a="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",b="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",seriesId="cccccccc-cccc-cccc-cccc-cccccccccccc";
            JSONObject first=new JSONObject().put("id",a).put("kind","audio").put("series",new JSONObject().put("id",seriesId)),second=new JSONObject().put("id",b).put("kind","audio").put("series",new JSONObject().put("id",seriesId)).put("offlineDownload",new JSONObject().put("id","dddddddd-dddd-dddd-dddd-dddddddddddd").put("assetId",b));
            JSONObject request=new JSONObject().put("origin","https://mirea.example").put("token","a".repeat(43)).put("userId",b).put("item",first).put("autoplay",true).put("offline",true).put("offlineSeries",new JSONObject().put("series",new JSONObject().put("id",seriesId)).put("items",new org.json.JSONArray().put(first).put(second)));
            ReflectionHelpers.setField(s,"item",first);ReflectionHelpers.setField(s,"request",request);ReflectionHelpers.setField(s,"api",new PlaybackApi(request.getString("origin"),request.getString("token"),request.getString("userId")));PlaybackRetry retry=ReflectionHelpers.getField(s,"retry");retry.unavailable(android.os.SystemClock.elapsedRealtime());
            s.pause();s.navigate(1);Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();JSONObject next=ReflectionHelpers.getField(s,"request");assertEquals(b,next.getJSONObject("item").getString("id"));assertFalse(next.getBoolean("autoplay"));assertTrue(next.has("download"));assertFalse((Boolean)ReflectionHelpers.getField(s,"desiredPlaying"));
        }finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void connectionIsCancelledBeforeDecoderReleaseOnFailureStopAndReopen()throws Exception{
        for(String action:new String[]{"failure","stop","reopen"}){
            ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();boolean destroyed=false;
            try{
                String name="release-"+action+".m4a";ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(name),new ShadowMediaPlayer.MediaInfo(120000,0));ReleaseProbe p=new ReleaseProbe();p.setDataSource(name);p.prepare();p.api=new PlaybackApi("https://mirea.example","a".repeat(43),"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
                JSONObject asset=new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","audio").put("size",100);ReflectionHelpers.setField(s,"api",p.api);ReflectionHelpers.setField(s,"player",p);ReflectionHelpers.setField(s,"prepared",true);ReflectionHelpers.setField(s,"item",asset);
                if(action.equals("failure"))ReflectionHelpers.callInstanceMethod(s,"fail",ReflectionHelpers.ClassParameter.from(String.class,"Synthetic blocked transport"));
                else if(action.equals("stop")){c.destroy();destroyed=true;}
                else{java.util.concurrent.ExecutorService prep=ReflectionHelpers.getField(s,"preparation");prep.shutdown();ReflectionHelpers.setField(s,"preparation",new ParkedExecutor());ReflectionHelpers.setField(s,"request",new JSONObject().put("origin",p.api.origin).put("token","a".repeat(43)).put("userId",p.api.userId).put("item",asset));s.reconnect();}
                assertTrue(action+" must abort transport before decoder release can wait on readAt",p.cancelledBeforeRelease);
            }finally{if(!destroyed)c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
        }
    }
}
