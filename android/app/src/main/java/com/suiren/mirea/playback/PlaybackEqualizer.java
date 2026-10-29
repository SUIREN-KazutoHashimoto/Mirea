package com.suiren.mirea.playback;
import android.content.*;
import android.media.audiofx.*;
import org.json.*;

/** Per-player processing only; ordinary edits never rebuild the decoder. */
final class PlaybackEqualizer {
    static final int[] FREQUENCIES={25,40,63,100,160,250,400,630,1000,1600,2500,4000,6300,10000,16000},OLD={60,230,910,3600,14000};
    static final double[][] PRESETS={new double[15],{5,5,5,4,3,2,1,0,0,0,0,0,0,0,0},{-3,-3,-2,-2,-1,0,1,2,3,3,2,1,0,0,0},{0,0,0,0,0,0,0,0,0,1,2,3,4,4,3}};
    interface Effect {int count();int frequency(int band);int min();int max();void band(int band,int level);void enabled(boolean enabled);void release();default boolean peakProtection(){return false;}}
    interface Factory {Effect create(int session);}
    static final class DynamicsEffect implements Effect {
        final DynamicsProcessing effect;final DynamicsProcessing.Eq eq=new DynamicsProcessing.Eq(true,true,FREQUENCIES.length);
        DynamicsEffect(int session){DynamicsProcessing made=null;try{made=new DynamicsProcessing(0,session,new DynamicsProcessing.Config.Builder(DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,2,true,FREQUENCIES.length,false,0,false,0,true).build());made.setInputGainAllChannelsTo(0);made.setLimiterAllChannelsTo(new DynamicsProcessing.Limiter(true,true,0,1,80,100,-.5f,0));effect=made;}catch(RuntimeException error){if(made!=null)made.release();throw error;}}
        public int count(){return FREQUENCIES.length;}public int frequency(int band){return FREQUENCIES[band];}public int min(){return -1200;}public int max(){return 1200;}
        public void band(int index,int level){float cutoff=index+1<FREQUENCIES.length?(float)Math.sqrt((double)FREQUENCIES[index]*FREQUENCIES[index+1]):22000;eq.setBand(index,new DynamicsProcessing.EqBand(true,cutoff,level/100f));}
        public void enabled(boolean value){effect.setPreEqAllChannelsTo(eq);if(effect.setEnabled(value)!=AudioEffect.SUCCESS)throw new IllegalStateException();}public void release(){effect.release();}public boolean peakProtection(){return true;}
    }
    static Effect createEffect(int id){try{return new DynamicsEffect(id);}catch(RuntimeException unavailable){Equalizer eq=new Equalizer(0,id);return new Effect(){public int count(){return eq.getNumberOfBands();}public int frequency(int b){return eq.getCenterFreq((short)b)/1000;}public int min(){return eq.getBandLevelRange()[0];}public int max(){return eq.getBandLevelRange()[1];}public void band(int b,int v){eq.setBandLevel((short)b,(short)v);}public void enabled(boolean v){if(eq.setEnabled(v)!=AudioEffect.SUCCESS)throw new IllegalStateException();}public void release(){eq.release();}};}}
    private final SharedPreferences preferences;private final Factory factory;private Effect effect;private int session;private boolean enabled;private double[] gains=new double[FREQUENCIES.length];private String notice="";
    PlaybackEqualizer(Context context){this(context,PlaybackEqualizer::createEffect);}
    PlaybackEqualizer(Context context,Factory factory){this.factory=factory;preferences=context.getSharedPreferences("mirea-equalizer-v2",Context.MODE_PRIVATE);SharedPreferences saved=preferences.contains("gains")?preferences:context.getSharedPreferences("mirea-equalizer-v1",Context.MODE_PRIVATE);enabled=saved.getBoolean("enabled",false);try{JSONArray a=new JSONArray(saved.getString("gains","[]"));double[] levels=new double[a.length()];for(int i=0;i<levels.length;i++)levels[i]=a.optDouble(i,0);gains=normalized(levels);}catch(JSONException ignored){}}
    static double clamp(double value){return Double.isFinite(value)?Math.rint(Math.max(-12,Math.min(12,value))*2)/2:0;}
    static double gainAt(int frequency,double[] values){int[] axis=values.length==5?OLD:FREQUENCIES;if(frequency<=axis[0])return values.length>0?clamp(values[0]):0;for(int i=1;i<axis.length;i++)if(frequency<=axis[i]){double ratio=Math.log((double)frequency/axis[i-1])/Math.log((double)axis[i]/axis[i-1]);return clamp(values[i-1])+ratio*(clamp(values[i])-clamp(values[i-1]));}return values.length>=axis.length?clamp(values[axis.length-1]):0;}
    static double[] normalized(double[] levels){double[] values=new double[FREQUENCIES.length];if(levels==null)return values;for(int i=0;i<values.length;i++)values[i]=clamp(levels.length==5?gainAt(FREQUENCIES[i],levels):i<levels.length?levels[i]:0);return values;}
    void attach(int id){if(id<=0){detach();return;}if(id==session&&effect!=null)return;detach();session=id;if(!enabled)return;try{effect=factory.create(id);if(effect.count()<1||effect.count()>32)throw new IllegalStateException();apply();notice=effect.peakProtection()?"":"この端末の対応帯域に合わせて調整しています。";}catch(RuntimeException error){detach();session=id;notice="この端末ではイコライザーを利用できません。";}}
    void set(boolean value,double[] levels){enabled=value;gains=normalized(levels);JSONArray a=new JSONArray();for(double gain:gains)a.put((Object)gain);preferences.edit().putBoolean("enabled",enabled).putString("gains",a.toString()).apply();try{if(enabled&&effect==null&&session>0)attach(session);else apply();}catch(RuntimeException error){int id=session;detach();session=id;notice="イコライザーを適用できません。";}}
    private void apply(){if(effect==null)return;for(int i=0;i<effect.count();i++)effect.band(i,Math.max(effect.min(),Math.min(effect.max(),(int)Math.round(gainAt(effect.frequency(i),gains)*100))));effect.enabled(enabled);}
    float volume(){if(!enabled||effect==null||effect.peakProtection())return 1;double peak=0;for(double gain:gains)peak=Math.max(peak,gain);return (float)Math.pow(10,-peak/20);}
    JSONObject status(){JSONObject value=new JSONObject();try{JSONArray a=new JSONArray();for(double gain:gains)a.put(gain);value.put("enabled",enabled).put("gains",a).put("available",effect!=null).put("peakProtection",effect!=null&&effect.peakProtection()).put("notice",notice);}catch(JSONException ignored){}return value;}
    void detach(){if(effect!=null)try{effect.release();}catch(RuntimeException ignored){}effect=null;session=0;}
}
