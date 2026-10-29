package com.suiren.mirea.playback;
import android.content.Context;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.util.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class PlaybackEqualizerTest {
    static class Driver implements PlaybackEqualizer.Effect {
        final int[] levels=new int[5];boolean enabled,released;
        public int count(){return 5;}public int frequency(int band){return PlaybackEqualizer.FREQUENCIES[band];}public int min(){return -600;}public int max(){return 600;}
        public void band(int band,int level){assertFalse(released);levels[band]=level;}public void enabled(boolean value){assertFalse(released);enabled=value;}public void release(){assertFalse(released);released=true;}
    }
    Context context(){Context c=RuntimeEnvironment.getApplication();c.getSharedPreferences("mirea-equalizer-v1",Context.MODE_PRIVATE).edit().clear().commit();return c;}
    @Test public void settingsAreLazySessionScopedPersistentAndBypassWithoutMuting()throws Exception{
        Context c=context();List<Integer> sessions=new ArrayList<>();List<Driver> effects=new ArrayList<>();PlaybackEqualizer.Factory factory=id->{assertTrue(id>0);sessions.add(id);Driver d=new Driver();effects.add(d);return d;};
        PlaybackEqualizer eq=new PlaybackEqualizer(c,factory);eq.attach(11);assertTrue(effects.isEmpty());eq.set(true,new double[]{12,-12,Double.NaN,2.1,Double.POSITIVE_INFINITY});assertEquals(Arrays.asList(11),sessions);assertArrayEquals(new int[]{600,-600,0,200,0},effects.get(0).levels);assertTrue(eq.volume()>0&&eq.volume()<1);assertTrue(effects.get(0).enabled);
        eq.attach(12);assertTrue(effects.get(0).released);assertEquals(Arrays.asList(11,12),sessions);assertTrue(effects.get(1).enabled);eq.attach(12);assertEquals(2,effects.size());eq.set(false,new double[5]);assertFalse(effects.get(1).enabled);assertEquals(1,eq.volume(),0);eq.attach(0);assertTrue(effects.get(1).released);eq.detach();assertEquals(2,effects.size());
        eq.set(true,new double[]{6,3,0,-1,-2});PlaybackEqualizer restored=new PlaybackEqualizer(c,factory);assertTrue(restored.status().getBoolean("enabled"));assertEquals(6,restored.status().getJSONArray("gains").getDouble(0),0);restored.attach(23);assertEquals(23,(int)sessions.get(2));restored.detach();
    }
    @Test public void missingAudioEffectsFailOpenForPlaybackAndNeverUseGlobalSessionZero()throws Exception{
        int[] calls={0};PlaybackEqualizer eq=new PlaybackEqualizer(context(),id->{calls[0]++;throw new UnsupportedOperationException();});eq.set(true,new double[]{6,0,0,0,0});eq.attach(0);assertEquals(0,calls[0]);eq.attach(7);assertEquals(1,calls[0]);assertFalse(eq.status().getBoolean("available"));assertFalse(eq.status().getString("notice").isEmpty());assertEquals(1,eq.volume(),0);eq.detach();
    }
    @Test public void interpolatesOnLogFrequencyAndClampsInvalidInputs(){
        double[] values={-12,12,0,-4,8};assertEquals(-12,PlaybackEqualizer.gainAt(10,values),0);assertEquals(12,PlaybackEqualizer.gainAt(230,values),0);assertEquals(0,PlaybackEqualizer.gainAt(117,values),.2);assertEquals(8,PlaybackEqualizer.gainAt(22000,values),0);assertEquals(0,PlaybackEqualizer.clamp(Double.NaN),0);assertEquals(12,PlaybackEqualizer.clamp(100),0);
    }
}
