package com.suiren.mirea.playback;
import android.net.Uri;
import androidx.media3.common.TrackSelectionParameters;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class VideoNavigationTest {
    final String id="12345678-1234-1234-1234-123456789abc",generation="23456789-1234-1234-1234-123456789abc";
    PlaybackApi api()throws Exception{return new PlaybackApi("https://mirea.example.test:3443","a".repeat(43),id);}
    @Test public void hlsAndRenditionQueriesAreStrictlyBoundToOriginAssetAndGeneration()throws Exception{
        PlaybackApi api=api();String path="/api/v1/items/"+id+"/hls/720p-00001.m4s?generation="+generation;
        assertTrue(PlaybackApi.safePath(path));assertEquals(path,AdaptivePlayback.authorizedPath(api,id,generation,Uri.parse(api.origin+path)));
        for(String url:new String[]{"https://elsewhere.test"+path,api.origin+path.replace(id,generation),api.origin+path+"&ticket=secret",api.origin+path.replace(generation,"base"),api.origin+path.replace("720p-00001.m4s","../../content"),"file:///tmp/a"})try{AdaptivePlayback.authorizedPath(api,id,generation,Uri.parse(url));fail(url);}catch(java.io.IOException expected){}
        assertTrue(PlaybackApi.safePath("/api/v1/items/"+id+"/renditions/720p/content?generation=base"));for(String suffix:new String[]{"&token=secret","#secret","%0a","/../other","&generation=base"})assertFalse(PlaybackApi.safePath(path+suffix));
    }
    @Test public void captionsUseOnlyTheChosenTrackAndExactTimeWindow()throws Exception{
        JSONObject nav=new JSONObject("{chapters:[{startMs:0,title:'Intro'},{startMs:5000,title:'Second'}],captions:[{id:'jp',language:'ja',cues:[{startMs:1000,endMs:2000,text:'字幕'},{startMs:2000,endMs:3000,text:'次'}]},{id:'en',language:'en',cues:[{startMs:0,endMs:4000,text:'English'}]}]}");
        assertEquals("",VideoNavigation.caption(nav,"off",1500));assertEquals("字幕",VideoNavigation.caption(nav,"ja",1500));assertEquals("次",VideoNavigation.caption(nav,"jp",2000));assertEquals("",VideoNavigation.caption(nav,"jp",3000));assertEquals("Second",VideoNavigation.chapter(nav,5000));assertEquals(5000,VideoNavigation.chapterPosition(nav,1000,1));assertEquals(0,VideoNavigation.chapterPosition(nav,5000,-1));
    }
    @Test public void adaptiveQualitySwitchKeepsOnePlayerAndPinsBothDimensions()throws Exception{
        JSONArray levels=new JSONArray("[{quality:'1080p',width:1920,height:1080},{quality:'720p',width:1280,height:720},{quality:'360p',width:640,height:360}]");
        AdaptivePlayback p=new AdaptivePlayback(RuntimeEnvironment.getApplication(),api(),id,"base",null,0,levels,new AdaptivePlayback.Events(){public void ready(){}public void buffering(boolean v){}public void ended(){}public void failed(){}public void changed(){}public void seeked(){}});
        try{p.quality("720p");TrackSelectionParameters fixed=p.player.getTrackSelectionParameters();assertEquals(1280,fixed.minVideoWidth);assertEquals(720,fixed.maxVideoHeight);p.quality("data");assertEquals(360,p.player.getTrackSelectionParameters().maxVideoHeight);p.quality("auto");assertEquals(0,p.player.getTrackSelectionParameters().minVideoHeight);assertEquals(Integer.MAX_VALUE,p.player.getTrackSelectionParameters().maxVideoHeight);p.quality("higher");assertTrue(p.player.getTrackSelectionParameters().forceHighestSupportedBitrate);}finally{p.player.release();}
    }
}
