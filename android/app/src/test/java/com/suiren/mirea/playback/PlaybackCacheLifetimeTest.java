package com.suiren.mirea.playback;
import android.content.Context;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class PlaybackCacheLifetimeTest {
 private final Context context=RuntimeEnvironment.getApplication();
 private JSONObject manifest()throws Exception{return new JSONObject().put("version",1).put("algorithm","AES-256-GCM").put("chunkSize",1048576).put("id",UUID.randomUUID().toString()).put("assetId",UUID.randomUUID().toString()).put("kind","audio").put("pageCount",1).put("files",new JSONArray().put(new JSONObject().put("index",0).put("number",1).put("size",20).put("chunks",1).put("mime","audio/mp4")));}
 private File saved(PlaybackCache cache,PlaybackApi api,JSONObject m)throws Exception{
  String id=m.getString("id");cache.begin(api.partition,m);byte[] plain=new byte[20],key=new byte[32],iv=new byte[12];Arrays.fill(plain,(byte)7);
  Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));cipher.updateAAD(("mirea-download-v1|"+id+"|0|0|20").getBytes(StandardCharsets.UTF_8));byte[] sealed=cipher.doFinal(plain),bytes=new byte[48];System.arraycopy(sealed,0,bytes,12,sealed.length);
  File folder=cache.folder(api.partition,id);Files.write(new File(folder,"0.chunk").toPath(),bytes);cache.complete(api.partition,id);return folder;
 }
 private JSONObject grant(JSONObject m)throws Exception{return new JSONObject().put("manifest",m).put("key",Base64.getEncoder().encodeToString(new byte[32])).put("expiresAt",System.currentTimeMillis()+60000);}
 @Test public void retirementKeepsAllReadersAliveThenReclaimsCiphertextAndNativeLease()throws Exception{
  PlaybackCache cache=new PlaybackCache(context);try(PlaybackApi api=new PlaybackApi("https://mirea.test","a".repeat(43),UUID.randomUUID().toString())){
   JSONObject m=manifest();String id=m.getString("id");File folder=saved(cache,api,m);context.getSharedPreferences("mirea-offline-v1",0).edit().putString(api.partition+"|"+id,"wrapped-fixture").commit();
   PlaybackSource first=new PlaybackSource(api,grant(m),folder),second=new PlaybackSource(api,grant(m),folder);
   try{cache.retire(api.partition,id);byte[] bytes=new byte[20];assertEquals(20,second.readAt(0,bytes,0,20));assertEquals(7,bytes[0]);assertTrue(folder.isDirectory());first.close();assertTrue(folder.isDirectory());second.close();assertFalse(folder.exists());assertFalse(context.getSharedPreferences("mirea-offline-v1",0).contains(api.partition+"|"+id));second.close();}
   finally{first.close();second.close();}
  }
 }
 @Test public void restartCollectsAbandonedRetirementsButReselectingTheQualityCancelsRetirement()throws Exception{
  PlaybackCache cache=new PlaybackCache(context);try(PlaybackApi api=new PlaybackApi("https://mirea.test","a".repeat(43),UUID.randomUUID().toString())){
   JSONObject m=manifest(),kept=manifest();File abandoned=saved(cache,api,m),unchanged=saved(cache,api,kept);new File(abandoned,"retired").createNewFile();new PlaybackCache(context).collectRetired();assertFalse(abandoned.exists());assertTrue(unchanged.exists());
   PlaybackSource reader=new PlaybackSource(api,grant(kept),unchanged);cache.retire(api.partition,kept.getString("id"));assertTrue(cache.begin(api.partition,kept));reader.close();assertTrue(cache.ready(api.partition,kept));cache.clear(api.partition);
  }
 }
}
