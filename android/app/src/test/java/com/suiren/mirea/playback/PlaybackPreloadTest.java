package com.suiren.mirea.playback;

import android.media.MediaPlayer;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowMediaPlayer;
import org.robolectric.shadows.util.DataSource;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class PlaybackPreloadTest {
    private static final String ASSET="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",USER="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    private PlaybackApi context(String token)throws Exception{return new PlaybackApi("https://mirea.test",token.repeat(43),USER);}
    private PlaybackPreload fixture(PlaybackApi api)throws Exception{
        JSONObject item=new JSONObject().put("id",ASSET).put("kind","audio");
        return ReflectionHelpers.callConstructor(PlaybackPreload.class,
            ReflectionHelpers.ClassParameter.from(PlaybackApi.class,api),ReflectionHelpers.ClassParameter.from(JSONObject.class,item),ReflectionHelpers.ClassParameter.from(JSONObject.class,new JSONObject().put("item",item)),
            ReflectionHelpers.ClassParameter.from(String.class,null),ReflectionHelpers.ClassParameter.from(String.class,"/api/v1/items/"+ASSET+"/content"),ReflectionHelpers.ClassParameter.from(long.class,100L),ReflectionHelpers.ClassParameter.from(String.class,"legacy"),ReflectionHelpers.ClassParameter.from(JSONArray.class,new JSONArray()),ReflectionHelpers.ClassParameter.from(PlaybackSource.class,null));
    }
    @Test public void aPreparedDecoderIsPausedAndCannotCrossLoginIdentityOrExpiry()throws Exception{
        try(PlaybackApi api=context("a");PlaybackApi same=context("a");PlaybackApi rotated=context("c");PlaybackApi other=new PlaybackApi("https://other.test","a".repeat(43),USER)){
            PlaybackPreload warm=fixture(api);assertFalse(warm.matches(same,ASSET));ReflectionHelpers.setField(warm,"ready",true);assertTrue(warm.matches(same,ASSET));assertFalse(warm.matches(rotated,ASSET));assertFalse(warm.matches(other,ASSET));assertFalse(warm.matches(same,USER));ReflectionHelpers.setField(warm,"created",android.os.SystemClock.elapsedRealtime()-300001);assertFalse(warm.matches(same,ASSET));warm.close();assertFalse(warm.isReady());
        }
    }
    @Test public void cancellationClosesTransportBeforeDecoderAndTransferDoesNotCloseTheAdoptedPlayer()throws Exception{
        PlaybackApi api=context("a");PlaybackPreload warm=fixture(api);
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource("next-only.m4a"),new ShadowMediaPlayer.MediaInfo(120000,0));
        final boolean[] closedBeforeRelease={false};MediaPlayer player=new MediaPlayer(){@Override public void release(){closedBeforeRelease[0]=api.closed;super.release();}};player.setDataSource("next-only.m4a");player.prepare();ReflectionHelpers.setField(warm,"player",player);ReflectionHelpers.setField(warm,"ready",true);assertFalse(player.isPlaying());warm.close();assertTrue(closedBeforeRelease[0]);assertTrue(api.closed);
        PlaybackApi owned=context("a");PlaybackPreload adopted=fixture(owned);MediaPlayer next=new MediaPlayer();next.setDataSource("next-only.m4a");next.prepare();ReflectionHelpers.setField(adopted,"player",next);adopted.transfer();assertSame(next,adopted.takePlayer());adopted.close();assertFalse(owned.closed);assertFalse(next.isPlaying());owned.close();next.release();
    }
}
