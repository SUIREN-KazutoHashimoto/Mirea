package com.suiren.mirea.playback;
import org.junit.*;
import static org.junit.Assert.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.json.*;
import android.content.*;
import javax.crypto.spec.SecretKeySpec;

@RunWith(RobolectricTestRunner.class)
public class OfflineLeaseTest {
    @Test public void grantIsSealedBoundToAccountAndCanReopenWithoutServerButRevocationFailsClosed()throws Exception{
        Context context=RuntimeEnvironment.getApplication();byte[] key=new byte[32];java.util.Arrays.fill(key,(byte)7);
        OfflineLease vault=new OfflineLease(context,create->new SecretKeySpec(key,"AES"));
        PlaybackApi api=new PlaybackApi("https://mirea.test","a".repeat(43),"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        String id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        JSONObject manifest=new JSONObject().put("id",id).put("assetId","cccccccc-cccc-cccc-cccc-cccccccccccc").put("version",1).put("algorithm","AES-256-GCM").put("chunkSize",1048576).put("kind","audio").put("pageCount",1).put("files",new JSONArray().put(new JSONObject().put("index",0).put("size",100).put("chunks",1).put("mime","audio/mp4")));
        long now=System.currentTimeMillis();String contentKey=java.util.Base64.getEncoder().encodeToString(new byte[32]);
        JSONObject grant=new JSONObject().put("manifest",manifest).put("userId",api.userId).put("key",contentKey).put("serverTime",now).put("expiresAt",now+OfflineLease.WINDOW);
        vault.save(api,grant);String atRest=context.getSharedPreferences("mirea-offline-v1",Context.MODE_PRIVATE).getString(api.partition+"|"+id,"");assertFalse(atRest.contains(contentKey));assertFalse(atRest.contains("manifest"));assertEquals(contentKey,vault.load(api,id).getString("key"));
        OfflineLease reopened=new OfflineLease(context,create->new SecretKeySpec(key,"AES"));assertEquals(id,reopened.load(api,id).getJSONObject("manifest").getString("id"));
        PlaybackApi other=new PlaybackApi("https://other.test","a".repeat(43),api.userId);try{reopened.load(other,id);fail();}catch(IllegalStateException expected){}
        reopened.revoke(api.partition,id);try{reopened.load(api,id);fail();}catch(IllegalStateException expected){}
        try{reopened.save(api,new JSONObject(grant.toString()).put("expiresAt",now+OfflineLease.WINDOW+1));fail();}catch(IllegalArgumentException expected){}
        reopened.save(api,grant);reopened.clear(api.partition);try{reopened.load(api,id);fail();}catch(IllegalStateException expected){}
    }
}
