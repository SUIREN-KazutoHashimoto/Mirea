package com.suiren.mirea.playback;
import org.junit.*;
import static org.junit.Assert.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.shadows.ShadowSystemClock;
import org.json.*;
import android.content.*;
import javax.crypto.spec.SecretKeySpec;
import java.time.Duration;
@RunWith(RobolectricTestRunner.class)
public class AnalysisNavigationTest {
 private JSONObject pack(String user,String asset)throws Exception{
  long now=System.currentTimeMillis();
  JSONObject section=new JSONObject().put("id","synthetic").put("startMs",1000).put("endMs",4000).put("label","SYNTHETIC PRIVATE SECTION");
  return new JSONObject().put("version",1).put("userId",user).put("assetId",asset).put("serverTime",now).put("expiresAt",now+10000).put("features",new JSONObject().put("structure",new JSONObject().put("result",new JSONObject().put("segments",new JSONArray().put(section)))));
 }
 @Test public void sectionsHaveBoundedIdentityIntegersAndSevenDayLease()throws Exception{
  String user="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",asset="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";JSONObject value=pack(user,asset);
  assertEquals(1,AnalysisNavigation.segments(AnalysisNavigation.validate(value,user,asset)).length());
  try{AnalysisNavigation.validate(value,"other",asset);fail();}catch(IllegalArgumentException expected){}
  JSONObject bad=new JSONObject(value.toString()).put("expiresAt",value.getLong("serverTime")+OfflineLease.WINDOW+1);
  try{AnalysisNavigation.validate(bad,user,asset);fail();}catch(IllegalArgumentException expected){}
  value.getJSONObject("features").getJSONObject("structure").getJSONObject("result").getJSONArray("segments").getJSONObject(0).put("startMs",1000.5);
  try{AnalysisNavigation.validate(value,user,asset);fail();}catch(IllegalArgumentException expected){}
 }
 @Test public void nextChorusFindsTheClosestUpcomingSectionAndWrapsEvenAfterManualReordering()throws Exception{
  JSONObject value=pack("user","asset");JSONArray rows=value.getJSONObject("features").getJSONObject("structure").getJSONObject("result").getJSONArray("segments");
  rows.put(new JSONObject().put("startMs",9000).put("kind","chorus")).put(new JSONObject().put("startMs",5000).put("label","サビ"));
  assertEquals(2,AnalysisNavigation.nextChorus(value,2000));assertEquals(1,AnalysisNavigation.nextChorus(value,5000));assertEquals(2,AnalysisNavigation.nextChorus(value,10000));assertEquals(-1,AnalysisNavigation.nextChorus(null,0));
 }
 @Test public void analysisIsEncryptedIsolatedRevocableAndExpiresWithoutMediaKeys()throws Exception{
  Context context=RuntimeEnvironment.getApplication();byte[] key=new byte[32];java.util.Arrays.fill(key,(byte)9);
  OfflineLease vault=new OfflineLease(context,create->new SecretKeySpec(key,"AES"));
  try(PlaybackApi api=new PlaybackApi("https://example.test","a".repeat(43),"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");PlaybackApi other=new PlaybackApi("https://other.test","a".repeat(43),api.userId)){
   String asset="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";JSONObject value=pack(api.userId,asset);vault.saveAnalysis(api,value,vault.analysisAuthorization(api,asset));
   assertEquals(1,AnalysisNavigation.segments(vault.analysis(api,asset)).length());assertNull(vault.analysis(other,asset));
   assertFalse(context.getSharedPreferences("mirea-offline-v1",Context.MODE_PRIVATE).getAll().toString().contains("SYNTHETIC PRIVATE SECTION"));
   String before=vault.analysisAuthorization(api,asset);vault.revokeAnalysis(api,asset);assertNull(vault.analysis(api,asset));try{vault.saveAnalysis(api,value,before);fail();}catch(IllegalStateException expected){}vault.saveAnalysis(api,value,vault.analysisAuthorization(api,asset));
   ShadowSystemClock.advanceBy(Duration.ofSeconds(11));assertNull(vault.analysis(api,asset));
   vault.saveAnalysis(api,pack(api.userId,asset),vault.analysisAuthorization(api,asset));String prior=vault.analysisAuthorization(api,asset);vault.clear(api.partition);assertNull(vault.analysis(api,asset));try{vault.saveAnalysis(api,value,prior);fail();}catch(IllegalStateException expected){}
  }
 }
}
