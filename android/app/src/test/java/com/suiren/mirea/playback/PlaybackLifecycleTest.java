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
    static final class ParkedExecutor extends java.util.concurrent.AbstractExecutorService {
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
}
