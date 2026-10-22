package com.suiren.mirea.playback;
import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackPresentationTest {
    @Test public void fitPreservesAspectInPortraitLandscapeAndPip(){
        assertArrayEquals(new int[]{360,203},PlaybackPresentation.fit(360,800,1920,1080));
        assertArrayEquals(new int[]{640,360},PlaybackPresentation.fit(800,360,1920,1080));
        assertArrayEquals(new int[]{203,360},PlaybackPresentation.fit(800,360,1080,1920));
        assertArrayEquals(new int[]{200,113},PlaybackPresentation.fit(200,150,16,9));
        assertEquals("1:02:03",PlaybackPresentation.time(3723000));assertEquals("0:00",PlaybackPresentation.time(-1));
    }
    @Test public void videoChromeHidesOnlyDuringStablePlaybackAndReturnsForPauseScrubMenusOrAccessibility(){
        PlaybackPresentation.Chrome c=new PlaybackPresentation.Chrome();assertTrue(c.update(0,true,true,false,false,false));assertTrue(c.update(3499,true,true,false,false,false));assertFalse(c.update(3500,true,true,false,false,false));
        c.toggle(4000);assertTrue(c.update(4000,true,true,false,false,false));assertFalse(c.update(7500,true,true,false,false,false));
        assertTrue(c.update(8000,true,false,false,false,false));assertTrue(c.update(12000,true,true,false,false,false));assertTrue(c.update(15000,true,true,true,false,false));assertTrue(c.update(50000,true,true,false,true,false));
        assertFalse(c.update(51000,true,true,false,false,true));assertTrue(c.update(52000,true,true,false,false,false));
        assertTrue(c.update(100000,false,true,false,false,false));
    }
    @Test public void manualOrientationSurvivesReadinessAndSeriesUpdatesAndDoesNotApplyToAudio(){
        PlaybackPresentation.Orientation o=new PlaybackPresentation.Orientation(0);assertEquals(0,o.target(true,false,16,9));assertEquals(2,o.target(true,true,1920,1080));assertEquals(1,o.target(true,true,1080,1920));
        assertEquals(1,o.toggle(true));assertEquals(1,o.target(true,true,1920,1080));assertEquals(1,o.target(true,false,16,9));assertEquals(0,o.target(false,true,1,1));
        assertEquals(2,o.toggle(false));assertEquals(2,new PlaybackPresentation.Orientation(o.manual()).target(true,true,1080,1920));
    }
}
