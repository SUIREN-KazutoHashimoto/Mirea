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
    @Test public void repeatOneRestartsSamePlayerAndDisablingContinuationCancelsPendingRepeat()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();try{ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("repeat.m4a"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer p=new MediaPlayer();p.setDataSource("repeat.m4a");p.prepare();p.setOnSeekCompleteListener(value->ReflectionHelpers.callInstanceMethod(s,"seekComplete",ReflectionHelpers.ClassParameter.from(MediaPlayer.class,value)));Shadows.shadowOf(p).setCurrentPosition(119999);ReflectionHelpers.setField(s,"player",p);ReflectionHelpers.setField(s,"prepared",true);ReflectionHelpers.setField(s,"ended",true);ReflectionHelpers.setField(s,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","audio"));s.repeat("one");Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(150,TimeUnit.MILLISECONDS);assertSame(p,ReflectionHelpers.getField(s,"player"));assertTrue(s.status().toString(),s.playing());assertTrue("Position "+s.position(),s.position()<1000);s.pause();ReflectionHelpers.setField(s,"ended",true);s.repeat("one");s.continuous(false);Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(500,TimeUnit.MILLISECONDS);assertFalse(s.playing());assertEquals("one",s.status().getString("repeat"));}finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void pauseDuringRepeatSeekDoesNotResumeWhenSeekCompletes()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();try{ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("repeat-pause.m4a"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer p=new MediaPlayer();p.setDataSource("repeat-pause.m4a");p.prepare();Shadows.shadowOf(p).setSeekDelay(200);p.setOnSeekCompleteListener(value->ReflectionHelpers.callInstanceMethod(s,"seekComplete",ReflectionHelpers.ClassParameter.from(MediaPlayer.class,value)));Shadows.shadowOf(p).setCurrentPosition(119999);ReflectionHelpers.setField(s,"player",p);ReflectionHelpers.setField(s,"prepared",true);ReflectionHelpers.setField(s,"ended",true);ReflectionHelpers.setField(s,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","audio"));s.repeat("one");Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(100,TimeUnit.MILLISECONDS);assertTrue((Boolean)ReflectionHelpers.getField(s,"seeking"));s.pause();Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(250,TimeUnit.MILLISECONDS);assertFalse(s.playing());assertFalse((Boolean)ReflectionHelpers.getField(s,"resumeAfterSeek"));}finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void audioReturnKeepsServicePlayerAndPositionWhileExplicitStopRemainsSeparate()throws Exception{
        ServiceController<PlaybackService> serviceController=Robolectric.buildService(PlaybackService.class).create();PlaybackService service=serviceController.get();
        try{
            ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("audio-return.m4a"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer player=new MediaPlayer();player.setDataSource("audio-return.m4a");player.prepare();Shadows.shadowOf(player).setCurrentPosition(42000);player.start();
            ReflectionHelpers.setField(service,"player",player);ReflectionHelpers.setField(service,"prepared",true);ReflectionHelpers.setField(service,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("title","Return test").put("kind","audio"));
            ActivityController<PlaybackActivity> controller=Robolectric.buildActivity(PlaybackActivity.class).setup();PlaybackActivity activity=controller.get();
            activity.getWindow().getDecorView().findViewWithTag("action-library").performClick();assertTrue(activity.isFinishing());assertTrue(service.playing());assertSame(player,ReflectionHelpers.getField(service,"player"));assertTrue(service.position()>=42000);
            android.content.Intent library=Shadows.shadowOf(activity).getNextStartedActivity();assertEquals("com.suiren.mirea.MainActivity",library.getComponent().getClassName());assertTrue((library.getFlags()&android.content.Intent.FLAG_ACTIVITY_NEW_TASK)!=0);
            controller.pause().stop().destroy();assertSame(service,PlaybackService.current);assertTrue(service.playing());assertTrue((Boolean)ReflectionHelpers.getField(activity,"preserve"));
        }finally{serviceController.destroy();service.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void videoBackEntersPipAndReturnsToLibraryWithoutRecreatingOrPausingPlayer()throws Exception{
        Shadows.shadowOf(RuntimeEnvironment.getApplication().getPackageManager()).setSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE,true);
        ServiceController<PlaybackService> serviceController=Robolectric.buildService(PlaybackService.class).create();PlaybackService service=serviceController.get();
        try{
            ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("video-return.mp4"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer player=new MediaPlayer();player.setDataSource("video-return.mp4");player.prepare();Shadows.shadowOf(player).setCurrentPosition(37000);player.start();
            ReflectionHelpers.setField(service,"player",player);ReflectionHelpers.setField(service,"prepared",true);ReflectionHelpers.setField(service,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("title","PiP return test").put("kind","video"));
            try(ActivityController<PlaybackActivity> controller=Robolectric.buildActivity(PlaybackActivity.class).setup()){
                PlaybackActivity activity=controller.get();activity.getOnBackPressedDispatcher().onBackPressed();assertTrue(activity.isInPictureInPictureMode());assertFalse(activity.isFinishing());assertTrue(service.playing());assertSame(player,ReflectionHelpers.getField(service,"player"));assertTrue(service.position()>=37000);
                assertNull("The library must wait for PiP entry confirmation",Shadows.shadowOf(activity).getNextStartedActivity());
                assertEquals(android.view.View.GONE,activity.getWindow().getDecorView().findViewWithTag("playback-screen").getVisibility());
                activity.onPictureInPictureModeChanged(true,activity.getResources().getConfiguration());assertEquals(android.view.View.GONE,activity.getWindow().getDecorView().findViewWithTag("playback-screen").getVisibility());assertFalse((Boolean)ReflectionHelpers.getField(activity,"preserve"));
                android.content.Intent library=Shadows.shadowOf(activity).getNextStartedActivity();assertEquals("com.suiren.mirea.MainActivity",library.getComponent().getClassName());assertTrue((library.getFlags()&android.content.Intent.FLAG_ACTIVITY_NEW_TASK)!=0);
                activity.onPictureInPictureModeChanged(true,activity.getResources().getConfiguration());assertNull("Repeated PiP callbacks must not reopen the library",Shadows.shadowOf(activity).getNextStartedActivity());
                ReflectionHelpers.setField(Shadows.shadowOf(activity),"isInPictureInPictureMode",false);activity.onPictureInPictureModeChanged(false,activity.getResources().getConfiguration());
                assertEquals(android.view.View.VISIBLE,activity.getWindow().getDecorView().findViewWithTag("playback-screen").getVisibility());assertSame(player,ReflectionHelpers.getField(service,"player"));assertTrue(service.playing());assertTrue(service.position()>=37000);assertFalse(activity.isFinishing());
            }
        }finally{serviceController.destroy();service.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void libraryCannotBecomePipAndPlayerHasItsOwnTask()throws Exception{
        android.content.Context context=RuntimeEnvironment.getApplication();android.content.pm.PackageManager pm=context.getPackageManager();
        ActivityInfo library=pm.getActivityInfo(new android.content.ComponentName(context,com.suiren.mirea.MainActivity.class),0),player=pm.getActivityInfo(new android.content.ComponentName(context,PlaybackActivity.class),0);
        int pipFlag=ReflectionHelpers.getStaticField(ActivityInfo.class,"FLAG_SUPPORTS_PICTURE_IN_PICTURE");
        assertEquals(0,library.flags&pipFlag);assertNotEquals(0,player.flags&pipFlag);
        assertNotEquals(library.taskAffinity,player.taskAffinity);assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK,player.launchMode);
    }
    @Test @Config(sdk={29,30}) @GraphicsMode(GraphicsMode.Mode.LEGACY) public void legacyAndroidStillCreatesPlayerAndEntersPip()throws Exception{
        android.app.Application app=RuntimeEnvironment.getApplication();String receiverPermission=app.getPackageName()+".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";android.content.pm.PackageManager pm=app.getPackageManager();
        assertEquals(android.content.pm.PermissionInfo.PROTECTION_SIGNATURE,pm.getPermissionInfo(receiverPermission,0).protectionLevel&android.content.pm.PermissionInfo.PROTECTION_MASK_BASE);
        assertTrue(java.util.Arrays.asList(pm.getPackageInfo(app.getPackageName(),android.content.pm.PackageManager.GET_PERMISSIONS).requestedPermissions).contains(receiverPermission));
        // Android grants an app its own signature permission on installation;
        // Robolectric's older SDK PackageManager does not simulate that grant.
        Shadows.shadowOf(app).grantPermissions(receiverPermission);
        Shadows.shadowOf(RuntimeEnvironment.getApplication().getPackageManager()).setSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE,true);
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{
            ReflectionHelpers.setField(s,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","video"));
            try(ActivityController<PlaybackActivity> controller=Robolectric.buildActivity(PlaybackActivity.class).setup()){
                PlaybackActivity a=controller.get();a.getOnBackPressedDispatcher().onBackPressed();assertTrue(a.isInPictureInPictureMode());assertNull(Shadows.shadowOf(a).getNextStartedActivity());a.onPictureInPictureModeChanged(true,a.getResources().getConfiguration());assertNotNull(Shadows.shadowOf(a).getNextStartedActivity());assertEquals(android.view.View.GONE,a.getWindow().getDecorView().findViewWithTag("playback-screen").getVisibility());
            }
        }finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void pipTransitionHidesControlsBeforeModeChangeAndCancelledEntryRestoresThem()throws Exception{
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{
            ReflectionHelpers.setField(s,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","video"));
            try(ActivityController<PlaybackActivity> controller=Robolectric.buildActivity(PlaybackActivity.class).setup()){
                PlaybackActivity a=controller.get();android.view.View screen=a.getWindow().getDecorView().findViewWithTag("playback-screen");
                android.app.AlertDialog dialog=new android.app.AlertDialog.Builder(a).setTitle("Synthetic settings").create();ReflectionHelpers.callInstanceMethod(a,"show",ReflectionHelpers.ClassParameter.from(android.app.Dialog.class,dialog));assertTrue(dialog.isShowing());
                int requestedOrientation=a.getRequestedOrientation();ReflectionHelpers.setField(a,"orientation",new PlaybackPresentation.Orientation(PlaybackPresentation.Orientation.PORTRAIT));
                android.app.PictureInPictureUiState state=ReflectionHelpers.callConstructor(android.app.PictureInPictureUiState.class,ReflectionHelpers.ClassParameter.from(boolean.class,false),ReflectionHelpers.ClassParameter.from(boolean.class,true));
                assertFalse(a.isInPictureInPictureMode());a.onPictureInPictureUiStateChanged(state);
                assertEquals(android.view.View.GONE,screen.getVisibility());ReflectionHelpers.callInstanceMethod(a,"render");assertEquals(android.view.View.GONE,screen.getVisibility());
                assertFalse(dialog.isShowing());assertEquals(requestedOrientation,a.getRequestedOrientation());
                Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(3100,TimeUnit.MILLISECONDS);
                assertEquals(android.view.View.VISIBLE,screen.getVisibility());assertFalse(a.isFinishing());assertNull(Shadows.shadowOf(a).getNextStartedActivity());
            }
        }finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void switchingPipVideoToAudioClosesOnlyTheWindowAndKeepsPlayback()throws Exception{
        Shadows.shadowOf(RuntimeEnvironment.getApplication().getPackageManager()).setSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE,true);
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();
        try{
            ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("pip-audio.m4a"),new ShadowMediaPlayer.MediaInfo(120000,0));MediaPlayer player=new MediaPlayer();player.setDataSource("pip-audio.m4a");player.prepare();player.start();ReflectionHelpers.setField(s,"player",player);ReflectionHelpers.setField(s,"prepared",true);ReflectionHelpers.setField(s,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","video"));
            ActivityController<PlaybackActivity> controller=Robolectric.buildActivity(PlaybackActivity.class).setup();PlaybackActivity a=controller.get();a.getOnBackPressedDispatcher().onBackPressed();a.onPictureInPictureModeChanged(true,a.getResources().getConfiguration());
            ReflectionHelpers.setField(s,"item",new JSONObject().put("id","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").put("kind","audio"));ReflectionHelpers.callInstanceMethod(a,"render");assertTrue(a.isFinishing());assertTrue((Boolean)ReflectionHelpers.getField(a,"preserve"));controller.pause().stop().destroy();assertTrue(s.playing());assertSame(s,PlaybackService.current);
        }finally{c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void stoppingServiceClosesPipInsteadOfLeavingAnUnusableWindow()throws Exception{
        Shadows.shadowOf(RuntimeEnvironment.getApplication().getPackageManager()).setSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE,true);
        ServiceController<PlaybackService> c=Robolectric.buildService(PlaybackService.class).create();PlaybackService s=c.get();ActivityController<PlaybackActivity> controller=null;boolean stopped=false;
        try{
            ReflectionHelpers.setField(s,"item",new JSONObject().put("id","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").put("kind","video"));controller=Robolectric.buildActivity(PlaybackActivity.class).setup();PlaybackActivity a=controller.get();a.getOnBackPressedDispatcher().onBackPressed();a.onPictureInPictureModeChanged(true,a.getResources().getConfiguration());
            c.destroy();stopped=true;s.stopped.get(5,TimeUnit.SECONDS);ReflectionHelpers.callInstanceMethod(a,"render");assertTrue(a.isFinishing());
        }finally{if(controller!=null)controller.pause().stop().destroy();if(!stopped){c.destroy();s.stopped.get(5,TimeUnit.SECONDS);}}
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
