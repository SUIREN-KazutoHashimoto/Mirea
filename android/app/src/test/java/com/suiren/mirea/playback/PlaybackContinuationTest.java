package com.suiren.mirea.playback;

import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.shadows.ShadowMediaPlayer;
import org.robolectric.shadows.util.DataSource;
import org.robolectric.util.ReflectionHelpers;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows=PlaybackActivityTest.RatePlayer.class)
public class PlaybackContinuationTest {
    private static final String FIRST="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",NEXT="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",SERIES="cccccccc-cccc-cccc-cccc-cccccccccccc",USER="dddddddd-dddd-dddd-dddd-dddddddddddd";

    static final class QueuedExecutor extends AbstractExecutorService {
        final ArrayDeque<Runnable> tasks=new ArrayDeque<>();boolean stopped;
        public void execute(Runnable task){if(stopped)throw new RejectedExecutionException();tasks.add(task);}
        public void shutdown(){stopped=true;}
        public List<Runnable> shutdownNow(){stopped=true;List<Runnable> result=new ArrayList<>(tasks);tasks.clear();return result;}
        public boolean isShutdown(){return stopped;}public boolean isTerminated(){return stopped;}
        public boolean awaitTermination(long value,TimeUnit unit){return stopped;}
        void runNext(){assertFalse("Expected a queued worker task",tasks.isEmpty());tasks.removeFirst().run();}
        void runAll(){while(!tasks.isEmpty())runNext();}
    }

    static JSONObject asset(String id,String kind)throws Exception {
        return new JSONObject().put("id",id).put("kind",kind).put("title","Synthetic media").put("size",100)
            .put("series",new JSONObject().put("id",SERIES))
            .put("progress",new JSONObject().put("positionMs",42000).put("durationMs",120000).put("revision",2).put("completed",false))
            .put("offlineDownload",new JSONObject().put("id",id).put("assetId",id));
    }
    static JSONObject request(JSONObject item)throws Exception {
        return new JSONObject().put("origin","https://mirea.test").put("token","a".repeat(43)).put("userId",USER)
            .put("item",item).put("offline",true).put("autoplay",false).put("download",item.getJSONObject("offlineDownload"));
    }
    static PlaybackApi api()throws Exception {return new PlaybackApi("https://mirea.test","a".repeat(43),USER);}
    static MediaPlayer decoder(String name)throws Exception {
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(name),new ShadowMediaPlayer.MediaInfo(120000,0));
        MediaPlayer player=new MediaPlayer();player.setDataSource(name);player.prepare();
        player.setPlaybackParams(new android.media.PlaybackParams().allowDefaults().setSpeed(1));
        return player;
    }
    static PlaybackPreload warm(JSONObject next)throws Exception {
        PlaybackPreload result=ReflectionHelpers.callConstructor(PlaybackPreload.class,
            ReflectionHelpers.ClassParameter.from(PlaybackApi.class,api()),ReflectionHelpers.ClassParameter.from(JSONObject.class,next.getJSONObject("item")),ReflectionHelpers.ClassParameter.from(JSONObject.class,next),
            ReflectionHelpers.ClassParameter.from(String.class,null),ReflectionHelpers.ClassParameter.from(String.class,null),ReflectionHelpers.ClassParameter.from(long.class,100L),
            ReflectionHelpers.ClassParameter.from(String.class,"download"),ReflectionHelpers.ClassParameter.from(JSONArray.class,new JSONArray()),ReflectionHelpers.ClassParameter.from(PlaybackSource.class,null));
        ReflectionHelpers.setField(result,"player",decoder("prepared-next-"+next.getJSONObject("item").getString("kind")+".m4a"));ReflectionHelpers.setField(result,"ready",true);return result;
    }
    static final class Fixture implements AutoCloseable {
        final ServiceController<PlaybackService> controller=Robolectric.buildService(PlaybackService.class).create();
        final PlaybackService service=controller.get();final QueuedExecutor preparation=new QueuedExecutor(),metadata=new QueuedExecutor(),io=new QueuedExecutor();
        Fixture()throws Exception {
            ((Handler)ReflectionHelpers.getField(service,"main")).removeCallbacks(ReflectionHelpers.getField(service,"tick"));
            replace("preparation",preparation);replace("metadata",metadata);replace("io",io);
            JSONObject first=asset(FIRST,"audio"),second=asset(NEXT,"audio"),current=request(first);
            current.put("offlineSeries",new JSONObject().put("series",new JSONObject().put("id",SERIES)).put("items",new JSONArray().put(first).put(second)));
            MediaPlayer player=decoder("current.m4a");Shadows.shadowOf(player).setCurrentPosition(42000);
            ReflectionHelpers.setField(service,"api",api());ReflectionHelpers.setField(service,"item",first);ReflectionHelpers.setField(service,"request",current);
            ReflectionHelpers.setField(service,"player",player);ReflectionHelpers.setField(service,"prepared",true);
            ((PlaybackRetry)ReflectionHelpers.getField(service,"retry")).unavailable(android.os.SystemClock.elapsedRealtime());
        }
        private void replace(String name,ExecutorService next){ExecutorService old=ReflectionHelpers.getField(service,name);old.shutdownNow();ReflectionHelpers.setField(service,name,next);}
        void seedConflict(String asset)throws Exception {
            PlaybackApi context=ReflectionHelpers.getField(service,"api");PlaybackJournal journal=ReflectionHelpers.getField(service,"journal");
            journal.progress(context.partition,asset,new JSONObject().put("revision",2).put("conflicted",true)
                .put("pending",new JSONObject().put("positionMs",42000).put("durationMs",120000).put("updateId","eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee").put("revision",2))
                .put("remotePosition",new JSONObject().put("positionMs",73000).put("durationMs",120000)));
        }
        void adopt(JSONObject next,long forced,PlaybackPreload warm){
            ReflectionHelpers.callInstanceMethod(service,"openPrepared",ReflectionHelpers.ClassParameter.from(JSONObject.class,next),ReflectionHelpers.ClassParameter.from(boolean.class,false),ReflectionHelpers.ClassParameter.from(long.class,forced),ReflectionHelpers.ClassParameter.from(PlaybackPreload.class,warm));
            preparation.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();
        }
        public void close()throws Exception {
            preparation.tasks.clear();controller.destroy();io.runAll();service.stopped.get(5,TimeUnit.SECONDS);
        }
    }

    @Test public void customAnalysisRangePreservesBoundsAndCannotOutliveTheMonotonicGrant()throws Exception {
        try(Fixture f=new Fixture()){
            JSONObject pack=new JSONObject().put("expiresAt",System.currentTimeMillis()+10000);
            ReflectionHelpers.callInstanceMethod(f.service,"acceptAnalysis",ReflectionHelpers.ClassParameter.from(JSONObject.class,pack));
            assertTrue(f.service.analysisRange(2000,4000));assertTrue(f.service.analysisLooping());
            assertFalse(f.service.analysisRange(-1,4000));assertFalse(f.service.analysisRange(2000,120001));assertFalse(f.service.analysisRange(4000,2000));
            assertEquals(2000L,(long)ReflectionHelpers.getField(f.service,"analysisLoopStart"));
            ReflectionHelpers.setField(f.service,"analysisDeadline",android.os.SystemClock.elapsedRealtime()-1);
            assertNull(f.service.currentAnalysis());assertFalse(f.service.analysisLooping());assertFalse(f.service.analysisRange(2000,4000));
        }
    }

    @Test public void analysisLoopAtMediaEndSeeksBackWithoutAdvancingTheSeriesAndHonorsExpiry()throws Exception {
        try(Fixture f=new Fixture()){
            ReflectionHelpers.setField(f.service,"analysis",new JSONObject());
            ReflectionHelpers.setField(f.service,"analysisLoopStart",1000L);
            ReflectionHelpers.setField(f.service,"analysisLoopEnd",120000L);
            ReflectionHelpers.setField(f.service,"analysisLoopExpires",System.currentTimeMillis()+10000);
            ReflectionHelpers.setField(f.service,"analysisLoopDeadline",android.os.SystemClock.elapsedRealtime()+10000);
            ReflectionHelpers.setField(f.service,"desiredPlaying",true);
            ReflectionHelpers.setField(f.service,"ended",true);
            assertTrue((Boolean)ReflectionHelpers.callInstanceMethod(f.service,"repeatAnalysisEnd"));
            assertTrue((Boolean)ReflectionHelpers.getField(f.service,"seeking"));
            assertTrue((Boolean)ReflectionHelpers.getField(f.service,"resumeAfterSeek"));
            assertFalse((Boolean)ReflectionHelpers.getField(f.service,"ended"));
            assertTrue(f.metadata.tasks.isEmpty());
            ReflectionHelpers.setField(f.service,"analysisLoopDeadline",android.os.SystemClock.elapsedRealtime());
            assertFalse((Boolean)ReflectionHelpers.callInstanceMethod(f.service,"repeatAnalysisEnd"));
            assertEquals(-1L,(long)ReflectionHelpers.getField(f.service,"analysisLoopStart"));
        }
    }

    @Test public void playerNextAndPreviousStartNewTracksAtZeroWhileKeepingPauseIntent()throws Exception {
        for(int direction:new int[]{1,-1})try(Fixture f=new Fixture()){
            if(direction<0){JSONObject first=asset(NEXT,"audio");ReflectionHelpers.setField(f.service,"item",first);JSONObject current=ReflectionHelpers.getField(f.service,"request");current.put("item",first);}
            f.service.pause();f.service.navigate(direction);f.metadata.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();
            JSONObject next=ReflectionHelpers.getField(f.service,"request");assertEquals(direction>0?NEXT:FIRST,next.getJSONObject("item").getString("id"));
            assertTrue(next.getBoolean("restart"));assertEquals(42000,next.getJSONObject("item").getJSONObject("progress").getLong("positionMs"));
            assertFalse(next.getBoolean("autoplay"));assertFalse((Boolean)ReflectionHelpers.getField(f.service,"desiredPlaying"));
            assertEquals(0,f.service.position());
        }
    }

    @Test public void endedSeriesWrapAndShuffleAlsoRequestTheBeginning()throws Exception {
        for(boolean shuffle:new boolean[]{false,true})try(Fixture f=new Fixture()){
            JSONObject last=asset(NEXT,"audio");ReflectionHelpers.setField(f.service,"item",last);((JSONObject)ReflectionHelpers.getField(f.service,"request")).put("item",last);
            ReflectionHelpers.setField(f.service,"repeat","series");ReflectionHelpers.setField(f.service,"shuffle",shuffle);ReflectionHelpers.setField(f.service,"ended",true);
            ReflectionHelpers.callInstanceMethod(f.service,"scheduleEnded");Shadows.shadowOf(Looper.getMainLooper()).idleFor(250,TimeUnit.MILLISECONDS);
            f.metadata.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();JSONObject next=ReflectionHelpers.getField(f.service,"request");
            assertEquals(FIRST,next.getJSONObject("item").getString("id"));assertTrue(next.getBoolean("restart"));assertTrue(next.getBoolean("autoplay"));
        }
    }

    @Test public void preparedDownloadsStartAtZeroDespiteConflictingProgressConnectedOrDisconnected()throws Exception {
        for(String kind:new String[]{"audio","video"})for(boolean offline:new boolean[]{false,true})try(Fixture f=new Fixture()){
            f.seedConflict(NEXT);JSONObject next=request(asset(NEXT,kind)).put("restart",true).put("offline",offline);PlaybackPreload prepared=warm(next);
            MediaPlayer player=ReflectionHelpers.getField(prepared,"player");f.adopt(next,-1,prepared);
            assertSame(player,ReflectionHelpers.getField(f.service,"player"));assertEquals(0,f.service.position());assertTrue(f.service.status().getBoolean("prepared"));
            PlaybackProgress progress=ReflectionHelpers.getField(f.service,"progress");assertTrue(progress.conflicted);assertEquals(42000,progress.initial().getLong("positionMs"));assertEquals(73000,progress.remotePosition.getLong("positionMs"));
        }
    }

    @Test public void directLibraryOpenStillResumesAndExplicitRecoveryPositionStillWins()throws Exception {
        for(long forced:new long[]{-1,15000})try(Fixture f=new Fixture()){
            f.seedConflict(NEXT);JSONObject next=request(asset(NEXT,"audio")).put("restart",forced>=0);PlaybackPreload prepared=warm(next);
            f.adopt(next,forced,prepared);Shadows.shadowOf(Looper.getMainLooper()).idleFor(100,TimeUnit.MILLISECONDS);
            assertEquals(forced<0?42000:15000,f.service.position());assertFalse(f.service.playing());assertTrue(((PlaybackProgress)ReflectionHelpers.getField(f.service,"progress")).conflicted);
        }
    }

    private static void finish(Fixture f,JSONObject next,PlaybackPreload prepared,int generation,int transition,boolean authorized){
        // Model authorization completion on the UI thread, with no live server or credentials.
        ReflectionHelpers.callInstanceMethod(f.service,"finishWarmOpen",ReflectionHelpers.ClassParameter.from(JSONObject.class,next),ReflectionHelpers.ClassParameter.from(boolean.class,false),ReflectionHelpers.ClassParameter.from(long.class,-1L),ReflectionHelpers.ClassParameter.from(PlaybackPreload.class,prepared),ReflectionHelpers.ClassParameter.from(int.class,generation),ReflectionHelpers.ClassParameter.from(int.class,transition),ReflectionHelpers.ClassParameter.from(boolean.class,authorized));
    }
    @Test public void consumedWarmPlanCannotSelectTheSameTrackAgainOnNextOrCompletion()throws Exception {
        for(boolean automatic:new boolean[]{false,true})try(Fixture f=new Fixture()){
            String third="ffffffff-ffff-ffff-ffff-ffffffffffff";JSONObject current=ReflectionHelpers.getField(f.service,"request");JSONArray entries=current.getJSONObject("offlineSeries").getJSONArray("items");entries.put(asset(third,"audio"));
            PlaybackOrder order=ReflectionHelpers.getField(f.service,"order");PlaybackOrder.Plan plan=order.plan(entries,FIRST,SERIES,1,false,false);ReflectionHelpers.setField(f.service,"plannedNext",plan);
            JSONObject next=OfflineSeries.nextRequest(current,entries.getJSONObject(1),true,false,true);PlaybackPreload prepared=warm(next);ReflectionHelpers.setField(f.service,"preparedNext",prepared);
            f.service.navigate(1);f.metadata.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertSame(prepared,ReflectionHelpers.getField(f.service,"pendingWarm"));assertNull(ReflectionHelpers.getField(f.service,"plannedNext"));
            int generation=ReflectionHelpers.getField(f.service,"generation"),transition=ReflectionHelpers.getField(f.service,"transitionEpoch");
            f.preparation.tasks.clear();finish(f,next,prepared,generation,transition,true);f.preparation.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();assertEquals(NEXT,f.service.status().getJSONObject("item").getString("id"));
            f.metadata.tasks.clear();
            if(automatic){ReflectionHelpers.setField(f.service,"ended",true);ReflectionHelpers.callInstanceMethod(f.service,"scheduleEnded");Shadows.shadowOf(Looper.getMainLooper()).idleFor(250,TimeUnit.MILLISECONDS);}else f.service.navigate(1);
            f.metadata.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();JSONObject selected=ReflectionHelpers.getField(f.service,"request");assertEquals(third,selected.getJSONObject("item").getString("id"));assertTrue(selected.getBoolean("restart"));
        }
    }
    @Test public void cancelledWarmAuthorizationCannotResumeOrReportStaleFailure()throws Exception {
        for(boolean authorized:new boolean[]{true,false})try(Fixture f=new Fixture()){
            f.service.play();MediaPlayer current=ReflectionHelpers.getField(f.service,"player");JSONObject next=request(asset(NEXT,"audio")).put("restart",true).put("autoplay",true);PlaybackPreload prepared=warm(next);
            ReflectionHelpers.setField(f.service,"preparedNext",prepared);int generation=ReflectionHelpers.getField(f.service,"generation"),transition=ReflectionHelpers.getField(f.service,"transitionEpoch");
            ReflectionHelpers.callInstanceMethod(f.service,"open",ReflectionHelpers.ClassParameter.from(JSONObject.class,next),ReflectionHelpers.ClassParameter.from(boolean.class,false),ReflectionHelpers.ClassParameter.from(long.class,-1L));
            assertSame(prepared,ReflectionHelpers.getField(f.service,"pendingWarm"));f.service.pause();assertTrue(prepared.api.closed);
            finish(f,next,prepared,generation,transition,authorized);assertSame(current,ReflectionHelpers.getField(f.service,"player"));assertEquals(FIRST,f.service.status().getJSONObject("item").getString("id"));
            assertFalse(f.service.playing());assertFalse((Boolean)ReflectionHelpers.getField(f.service,"desiredPlaying"));assertEquals("",f.service.status().getString("notice"));
        }
    }

    @Test public void currentWarmAuthorizationAdoptsNextButPauseBeforePreparationStillWins()throws Exception {
        try(Fixture f=new Fixture()){
            JSONObject next=request(asset(NEXT,"audio")).put("restart",true).put("autoplay",true);PlaybackPreload prepared=warm(next);
            ReflectionHelpers.setField(f.service,"pendingWarm",prepared);int generation=ReflectionHelpers.getField(f.service,"generation"),transition=ReflectionHelpers.getField(f.service,"transitionEpoch");
            finish(f,next,prepared,generation,transition,true);assertFalse(prepared.api.closed);f.service.pause();f.preparation.runNext();Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(NEXT,f.service.status().getJSONObject("item").getString("id"));assertEquals(0,f.service.position());assertTrue(f.service.status().getBoolean("prepared"));assertFalse(f.service.playing());
        }
    }
}
