package com.suiren.mirea.playback;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.audiofx.Equalizer;
import org.json.*;

/** An effect belongs only to this service's non-zero audio session, never the global mix. */
final class PlaybackEqualizer {
    static final int[] FREQUENCIES={60,230,910,3600,14000};
    interface Effect {int count();int frequency(int band);int min();int max();void band(int band,int level);void enabled(boolean enabled);void release();}
    interface Factory {Effect create(int session);}
    private final SharedPreferences preferences;private final Factory factory;private Effect effect;private int session;
    private boolean enabled;private double[] gains=new double[5];private String notice="";
    PlaybackEqualizer(Context context){this(context,id->{Equalizer eq=new Equalizer(0,id);return new Effect(){public int count(){return eq.getNumberOfBands();}public int frequency(int b){return eq.getCenterFreq((short)b)/1000;}public int min(){return eq.getBandLevelRange()[0];}public int max(){return eq.getBandLevelRange()[1];}public void band(int b,int v){eq.setBandLevel((short)b,(short)v);}public void enabled(boolean v){if(eq.setEnabled(v)!=android.media.audiofx.AudioEffect.SUCCESS)throw new IllegalStateException();}public void release(){eq.release();}};});}
    PlaybackEqualizer(Context context,Factory factory){this.factory=factory;preferences=context.getSharedPreferences("mirea-equalizer-v1",Context.MODE_PRIVATE);enabled=preferences.getBoolean("enabled",false);try{JSONArray a=new JSONArray(preferences.getString("gains","[]"));for(int i=0;i<5;i++)gains[i]=clamp(a.optDouble(i,0));}catch(JSONException ignored){}}
    static double clamp(double value){return Double.isFinite(value)?Math.rint(Math.max(-12,Math.min(12,value))*2)/2:0;}
    static double gainAt(int frequency,double[] values){if(frequency<=FREQUENCIES[0])return values[0];for(int i=1;i<5;i++)if(frequency<=FREQUENCIES[i]){double ratio=Math.log((double)frequency/FREQUENCIES[i-1])/Math.log((double)FREQUENCIES[i]/FREQUENCIES[i-1]);return values[i-1]+ratio*(values[i]-values[i-1]);}return values[4];}
    void attach(int id){if(id<=0){detach();return;}if(id==session&&effect!=null)return;detach();session=id;if(!enabled)return;try{effect=factory.create(id);if(effect.count()<1||effect.count()>32)throw new IllegalStateException();apply();notice="";}catch(RuntimeException error){detach();session=id;notice="この端末ではイコライザーを利用できません。";}}
    void set(boolean value,double[] levels){enabled=value;for(int i=0;i<5;i++)gains[i]=clamp(levels!=null&&i<levels.length?levels[i]:0);JSONArray a=new JSONArray();for(double gain:gains)a.put((Object)gain);preferences.edit().putBoolean("enabled",enabled).putString("gains",a.toString()).apply();try{if(enabled&&effect==null&&session>0)attach(session);else apply();}catch(RuntimeException error){int id=session;detach();session=id;notice="イコライザーを適用できません。";}}
    private void apply(){if(effect==null)return;for(int i=0;i<effect.count();i++)effect.band(i,Math.max(effect.min(),Math.min(effect.max(),(int)Math.round(gainAt(effect.frequency(i),gains)*100))));effect.enabled(enabled);}
    float volume(){double positive=0;for(double gain:gains)positive+=Math.max(0,gain);return enabled&&effect!=null?(float)Math.pow(10,-positive/20):1;}
    JSONObject status(){JSONObject value=new JSONObject();try{JSONArray a=new JSONArray();for(double gain:gains)a.put(gain);value.put("enabled",enabled).put("gains",a).put("available",effect!=null).put("notice",notice);}catch(JSONException ignored){}return value;}
    void detach(){if(effect!=null)try{effect.release();}catch(RuntimeException ignored){}effect=null;session=0;}
}
