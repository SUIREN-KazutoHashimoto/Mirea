package com.suiren.mirea.playback;

import android.content.pm.ActivityInfo;
import android.media.MediaPlayer;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.*;
import org.robolectric.annotation.*;
import org.robolectric.shadows.ShadowMediaPlayer;
import org.robolectric.shadows.util.DataSource;
import org.robolectric.util.ReflectionHelpers;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w800dp-h360dp-land-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PlaybackActivityTest {
    // Robolectric does not implement the native PlaybackParams accessor. Supply
    // that narrow API contract, retaining its real MediaPlayer state machine.
    @org.robolectric.annotation.Implements(android.media.MediaPlayer.class) public static class RatePlayer extends ShadowMediaPlayer {
        private android.media.PlaybackParams params=new android.media.PlaybackParams().allowDefaults().setSpeed(1);
        @org.robolectric.annotation.Implementation protected android.media.PlaybackParams getPlaybackParams(){return params;}
        @org.robolectric.annotation.Implementation protected void setPlaybackParams(android.media.PlaybackParams value){params=value;}
    }
    @Test @Config(shadows=RatePlayer.class) public void temporaryBoostRestoresSelectedRateOnPauseBackgroundAndManualSpeedWithoutRestartingPausedMedia()throws Exception{
        ServiceController<PlaybackService> controller=Robolectric.buildService(PlaybackService.class).create();PlaybackService service=controller.get();
        try{
            ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("boost-test.mp4"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer player=new MediaPlayer();player.setDataSource("boost-test.mp4");player.prepare();player.start();ReflectionHelpers.setField(service,"player",player);ReflectionHelpers.setField(service,"prepared",true);ReflectionHelpers.setField(service,"foreground",true);ReflectionHelpers.setField(service,"item",new JSONObject().put("kind","video"));
            // ShadowMediaPlayer has no initial PlaybackParams; real prepared
            // MediaPlayer supplies defaults. Seed the documented default here.
            player.setPlaybackParams(new android.media.PlaybackParams().allowDefaults().setSpeed(1));
            service.speed(1.25f);assertTrue(service.startBoost());assertEquals(2f,player.getPlaybackParams().getSpeed(),.001f);assertEquals(1.25,service.status().getDouble("rate"),.001);service.endBoost();assertEquals(1.25f,player.getPlaybackParams().getSpeed(),.001f);
            assertTrue(service.startBoost());service.speed(1.5f);service.endBoost();assertEquals(1.5f,player.getPlaybackParams().getSpeed(),.001f);
            assertTrue(service.startBoost());service.pause();assertFalse(service.playing());assertFalse(service.startBoost());assertEquals(1.5f,player.getPlaybackParams().getSpeed(),.001f);
            player.start();assertTrue(service.startBoost());service.visibility(false,false);assertEquals(1.5f,player.getPlaybackParams().getSpeed(),.001f);assertTrue(service.playing());assertFalse(service.startBoost());
        }finally{controller.destroy();service.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void orientationButtonAndConfigurationChangesKeepSamePlayerPositionAndPlayback()throws Exception{
        ServiceController<PlaybackService> serviceController=Robolectric.buildService(PlaybackService.class).create();PlaybackService service=serviceController.get();
        try{
            ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("synthetic-test.mp4"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer player=new MediaPlayer();player.setDataSource("synthetic-test.mp4");player.prepare();Shadows.shadowOf(player).setCurrentPosition(42000);long started=android.os.SystemClock.uptimeMillis();player.start();
            ReflectionHelpers.setField(service,"player",player);ReflectionHelpers.setField(service,"prepared",true);ReflectionHelpers.setField(service,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("title","Synthetic rotation test").put("kind","video"));
            try(ActivityController<PlaybackActivity> controller=Robolectric.buildActivity(PlaybackActivity.class).setup()){
                PlaybackActivity activity=controller.get();activity.getWindow().getDecorView().findViewWithTag("player-rotate").performClick();assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT,activity.getRequestedOrientation());
                RuntimeEnvironment.setQualifiers("+port");controller.configurationChange();assertSame(activity,controller.get());assertSame(player,ReflectionHelpers.getField(service,"player"));assertEquals(42000+android.os.SystemClock.uptimeMillis()-started,service.position());assertTrue(service.playing());
                activity.getWindow().getDecorView().findViewWithTag("player-rotate").performClick();assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,activity.getRequestedOrientation());RuntimeEnvironment.setQualifiers("+land");controller.configurationChange();assertSame(player,ReflectionHelpers.getField(service,"player"));assertEquals(42000+android.os.SystemClock.uptimeMillis()-started,service.position());assertTrue(service.playing());
                ReflectionHelpers.setField(activity,"orientation",new PlaybackPresentation.Orientation(0));ReflectionHelpers.setField(service,"prepared",false);ReflectionHelpers.callInstanceMethod(activity,"render");assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,activity.getRequestedOrientation());ReflectionHelpers.setField(service,"prepared",true);
                service.pause();long paused=service.position();activity.getWindow().getDecorView().findViewWithTag("player-rotate").performClick();RuntimeEnvironment.setQualifiers("+port");controller.configurationChange();assertSame(player,ReflectionHelpers.getField(service,"player"));assertEquals(paused,service.position());assertFalse(service.playing());
            }
        }finally{serviceController.destroy();service.stopped.get(5,TimeUnit.SECONDS);}
    }
}
