package com.suiren.mirea.playback;
import android.graphics.Bitmap;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class PlaybackArtworkTest {
    @Test public void offlineCoverLargerThanOldBridgeLimitIsAcceptedWithinTwoMiB(){
        Bitmap image=Bitmap.createBitmap(512,512,Bitmap.Config.ARGB_8888);java.util.Random rng=new java.util.Random(1);int[] pixels=new int[512*512];for(int i=0;i<pixels.length;i++)pixels[i]=0xff000000|rng.nextInt(0xffffff);image.setPixels(pixels,0,512,0,0,512,512);java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();image.compress(Bitmap.CompressFormat.PNG,100,bytes);String encoded=java.util.Base64.getEncoder().encodeToString(bytes.toByteArray());assertTrue(encoded.length()>350000);assertNotNull(PlaybackArtwork.embedded(encoded));assertNull(PlaybackArtwork.embedded("a".repeat(2800000)));assertNull(PlaybackArtwork.embedded("not_base64"));image.recycle();
    }
    @Test public void savedCoverMustBelongToRequestedAccountDownloadAndAsset()throws Exception {
        String asset="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",user="cccccccc-cccc-cccc-cccc-cccccccccccc";
        PlaybackApi api=new PlaybackApi("https://mirea.test","a".repeat(43),user);
        Bitmap image=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);image.eraseColor(android.graphics.Color.GREEN);java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();image.compress(Bitmap.CompressFormat.PNG,100,bytes);
        org.json.JSONObject manifest=new org.json.JSONObject().put("id",id).put("assetId",asset),request=new org.json.JSONObject().put("item",new org.json.JSONObject().put("id",asset)).put("download",manifest);
        org.json.JSONObject grant=new org.json.JSONObject().put("userId",user).put("manifest",manifest).put("cover",new org.json.JSONObject().put("bytes",java.util.Base64.getEncoder().encodeToString(bytes.toByteArray())));
        assertEquals(android.graphics.Color.GREEN,PlaybackArtwork.forRequest(api,request,(context,download)->grant).getPixel(0,0));
        assertNull(PlaybackArtwork.forRequest(api,request,(context,download)->{throw new IllegalStateException("Expired lease");}));
        for(String mismatch:new String[]{"userId","id","assetId"}){
            org.json.JSONObject wrong=new org.json.JSONObject(grant.toString());if(mismatch.equals("userId"))wrong.put(mismatch,id);else wrong.getJSONObject("manifest").put(mismatch,user);
            assertNull(PlaybackArtwork.forRequest(api,request,(context,download)->wrong));
        }
        api.close();image.recycle();
    }
}
