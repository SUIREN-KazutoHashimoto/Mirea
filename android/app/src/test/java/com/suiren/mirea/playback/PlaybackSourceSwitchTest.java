package com.suiren.mirea.playback;

import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.shadows.ShadowMediaSession;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={PlaybackActivityTest.RatePlayer.class,PlaybackSourceSwitchTest.MetadataSession.class})
public class PlaybackSourceSwitchTest {
    // Robolectric's controller does not round-trip MediaSession metadata through
    // the OS binder. Observe the actual metadata sent by the service instead.
    @Implements(MediaSession.class)
    public static class MetadataSession extends ShadowMediaSession {
        MediaMetadata metadata;
        @Implementation protected void setMetadata(MediaMetadata value){metadata=value;}
    }
    private static final String FIRST="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",NEXT="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    private static final AdaptivePlayback.Events EVENTS=new AdaptivePlayback.Events(){public void ready(){}public void buffering(boolean value){}public void ended(){}public void failed(){}public void changed(){}public void seeked(){}};
    private static JSONArray renditions()throws Exception {return new JSONArray().put(new JSONObject().put("quality","480p").put("width",854).put("height",480)).put(new JSONObject().put("quality","720p").put("width",1280).put("height",720));}
    private static AdaptivePlayback stream(PlaybackContinuationTest.Fixture f,boolean hls,boolean playing)throws Exception {
        ReflectionHelpers.callInstanceMethod(f.service,"releasePlayer");
        JSONObject item=PlaybackContinuationTest.asset(FIRST,"video"),request=PlaybackContinuationTest.request(item);request.remove("download");request.put("offline",false).put("autoplay",playing);
        PlaybackApi api=ReflectionHelpers.getField(f.service,"api");JSONArray qualities=renditions();String path="/api/v1/items/"+FIRST+"/content";
        AdaptivePlayback adaptive=new AdaptivePlayback(f.service,api,FIRST,hls?"base":null,hls?null:path,100,qualities,EVENTS);
        adaptive.player.seekTo(42000);
        ReflectionHelpers.setField(f.service,"adaptive",adaptive);ReflectionHelpers.setField(f.service,"item",item);ReflectionHelpers.setField(f.service,"request",request);
        ReflectionHelpers.setField(f.service,"hlsGeneration",hls?"base":null);ReflectionHelpers.setField(f.service,"quality",hls?"auto":"legacy");ReflectionHelpers.setField(f.service,"qualities",qualities);
        ReflectionHelpers.setField(f.service,"contentPath",hls?null:path);ReflectionHelpers.setField(f.service,"contentSize",100L);ReflectionHelpers.setField(f.service,"prepared",true);ReflectionHelpers.setField(f.service,"desiredPlaying",playing);
        return adaptive;
    }
    private static void assertReopened(PlaybackContinuationTest.Fixture f,String quality,boolean playing)throws Exception {
        assertNull("Changing source kind must replace the progressive/HLS decoder",ReflectionHelpers.getField(f.service,"adaptive"));
        JSONObject next=ReflectionHelpers.getField(f.service,"request");assertEquals(quality,next.getString("quality"));assertEquals(playing,next.getBoolean("autoplay"));
        assertEquals(42000,f.service.position());assertEquals(playing,(Boolean)ReflectionHelpers.getField(f.service,"desiredPlaying"));assertEquals(1,f.preparation.tasks.size());
    }
    @Test public void progressiveToHlsAndBackReopenAtCurrentPositionWithPauseIntent()throws Exception {
        for(boolean playing:new boolean[]{false,true})for(boolean hls:new boolean[]{false,true})try(PlaybackContinuationTest.Fixture f=new PlaybackContinuationTest.Fixture()){
            stream(f,hls,playing);String next=hls?"legacy":"480p";f.service.quality(next);assertReopened(f,next,playing);
        }
    }
    @Test public void hlsRenditionChangeKeepsDecoderPositionAndPauseIntent()throws Exception {
        for(boolean playing:new boolean[]{false,true})try(PlaybackContinuationTest.Fixture f=new PlaybackContinuationTest.Fixture()){
            AdaptivePlayback original=stream(f,true,playing);f.service.quality("480p");assertSame(original,ReflectionHelpers.getField(f.service,"adaptive"));assertEquals(42000,f.service.position());
            assertEquals(playing,(Boolean)ReflectionHelpers.getField(f.service,"desiredPlaying"));assertEquals("480p",f.service.status().getString("quality"));assertTrue(f.preparation.tasks.isEmpty());
        }
    }
    @Test public void networkPreferenceSwitchesProgressiveSourceButDoesNotReloadExistingHls()throws Exception {
        for(boolean hls:new boolean[]{false,true})try(PlaybackContinuationTest.Fixture f=new PlaybackContinuationTest.Fixture()){
            AdaptivePlayback original=stream(f,hls,false);String network=ReflectionHelpers.callInstanceMethod(f.service,"networkKey");f.service.networkPreference(network,"data");
            if(hls){assertSame(original,ReflectionHelpers.getField(f.service,"adaptive"));assertEquals("data",f.service.status().getString("quality"));assertTrue(f.preparation.tasks.isEmpty());}
            else assertReopened(f,"data",false);
        }
    }
    @Test public void offlineNextClearsPreviousCoverIncludingSessionMetadataWithoutNetworkFetch()throws Exception {
        try(PlaybackContinuationTest.Fixture f=new PlaybackContinuationTest.Fixture()){
            f.service.artwork=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);ReflectionHelpers.setField(f.service,"artworkId",FIRST);
            ReflectionHelpers.callInstanceMethod(f.service,"updateSession");MediaSession session=ReflectionHelpers.getField(f.service,"session");MetadataSession metadata=Shadow.extract(session);assertSame(f.service.artwork,metadata.metadata.getBitmap(MediaMetadata.METADATA_KEY_ART));
            JSONObject next=PlaybackContinuationTest.request(PlaybackContinuationTest.asset(NEXT,"audio")).put("restart",true);
            f.adopt(next,-1,PlaybackContinuationTest.warm(next));assertNull(f.service.artwork);assertEquals("",ReflectionHelpers.getField(f.service,"artworkId"));
            assertNotNull(metadata.metadata);assertNull(metadata.metadata.getBitmap(MediaMetadata.METADATA_KEY_ART));assertNull(metadata.metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART));assertNull(metadata.metadata.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON));
            assertTrue("Offline handoff must not fetch the missing thumbnail",f.metadata.tasks.isEmpty());
        }
    }
    @Test public void sameAssetReopenKeepsCoverAndWarmNextUsesItsOwnEmbeddedCover()throws Exception {
        for(boolean same:new boolean[]{false,true})try(PlaybackContinuationTest.Fixture f=new PlaybackContinuationTest.Fixture()){
            Bitmap previous=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);previous.eraseColor(android.graphics.Color.BLUE);f.service.artwork=previous;ReflectionHelpers.setField(f.service,"artworkId",FIRST);
            String target=same?FIRST:NEXT;JSONObject next=PlaybackContinuationTest.request(PlaybackContinuationTest.asset(target,"audio")).put("restart",true);
            if(!same){Bitmap image=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);image.eraseColor(android.graphics.Color.RED);java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();image.compress(Bitmap.CompressFormat.PNG,100,bytes);next.put("artwork",java.util.Base64.getEncoder().encodeToString(bytes.toByteArray()));}
            f.adopt(next,-1,PlaybackContinuationTest.warm(next));assertNotNull(f.service.artwork);assertEquals(target,ReflectionHelpers.getField(f.service,"artworkId"));
            if(same)assertSame(previous,f.service.artwork);else assertEquals(android.graphics.Color.RED,f.service.artwork.getPixel(0,0));
        }
    }
}
