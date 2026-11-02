package com.suiren.mirea.playback;

import android.content.Context;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class PlaybackApiTest {
    @Test public void playlistPlaybackAllowsOnlyAnExactAssetQuery(){
        String route="/api/v1/playlists/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/playback?assetId=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        assertTrue(PlaybackApi.safePath(route));for(String suffix:new String[]{"&token=secret","#fragment","/other","%2f"})assertFalse(PlaybackApi.safePath(route+suffix));assertFalse(PlaybackApi.safePath(route.replace("assetId=","redirect=")));assertFalse(PlaybackApi.safePath(route.replace("/playlists/","/../playlists/")));
    }
    @Test public void aReachableLockedPrivateShelfIsNeverTreatedAsAnOfflineConnectionFailure(){assertTrue(new PlaybackApi.Failure(423).denied());assertFalse(new PlaybackApi.Failure(503).denied());}
    /** Only the test transport is HTTP/loopback. Production context still requires HTTPS. */
    private static final class Endpoint implements AutoCloseable {
        final ServerSocket server;final Thread worker;final JSONObject reply;volatile String method,type,length;volatile byte[] body;
        Endpoint(JSONObject reply)throws Exception{
            this.reply=reply;server=new ServerSocket(0,4,InetAddress.getByName("127.0.0.1"));
            worker=new Thread(()->{while(!server.isClosed())try(Socket socket=server.accept()){
                socket.setSoTimeout(3000);InputStream input=socket.getInputStream();String[] request=line(input).split(" ");method=request[0];type=null;length=null;
                for(int n=0;n<100;n++){String header=line(input);if(header.isEmpty())break;int colon=header.indexOf(':');if(colon<0)throw new IOException("Bad test header");String name=header.substring(0,colon),value=header.substring(colon+1).trim();if(name.equalsIgnoreCase("Content-Type"))type=value;if(name.equalsIgnoreCase("Content-Length"))length=value;}
                int count=length==null?0:Integer.parseInt(length);if(count<0||count>1000000)throw new IOException("Oversized test body");body=new byte[count];for(int n=0;n<count;){int read=input.read(body,n,count-n);if(read<0)throw new EOFException();n+=read;}
                int status=request[1].equals("/denied")?401:"POST".equals(method)&&(!"application/json".equals(type)||body.length==0)?415:200;
                byte[] response=(status==200?reply.toString():new JSONObject().put("error","test rejection").toString()).getBytes(StandardCharsets.UTF_8);
                OutputStream out=socket.getOutputStream();out.write(("HTTP/1.1 "+status+" Test\r\nContent-Type: application/json\r\nContent-Length: "+response.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(response);out.flush();
            }catch(Exception failure){if(!server.isClosed())throw new RuntimeException(failure);}},"lease-test-endpoint");worker.setDaemon(true);worker.start();
        }
        private static String line(InputStream input)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();for(int n=0;n<8192;n++){int b=input.read();if(b<0)throw new EOFException();if(b==10)return out.toString("US-ASCII").replace("\r","");out.write(b);}throw new IOException("Oversized test header");}
        HttpURLConnection connection(String path,String method)throws Exception{
            HttpURLConnection connection=(HttpURLConnection)new URL("http://127.0.0.1:"+server.getLocalPort()+path).openConnection();
            connection.setRequestMethod(method);connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(3000);connection.setReadTimeout(3000);
            // Match Android's default POST header, not desktop Java's implementation.
            if(method.equals("POST"))connection.setRequestProperty("Content-Type","application/x-www-form-urlencoded");
            return connection;
        }
        public void close()throws Exception{server.close();worker.join(3000);}
    }
    @Test public void emptyPostIsExplicitJsonAndRenewedLeaseReopensExistingCiphertextWithoutRedownload()throws Exception{
        Context context=RuntimeEnvironment.getApplication();PlaybackApi api=new PlaybackApi("https://mirea.test","a".repeat(43),"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        String id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";byte[] plain=new byte[100],key=new byte[32];Arrays.fill(plain,(byte)31);Arrays.fill(key,(byte)7);
        JSONObject manifest=new JSONObject().put("id",id).put("assetId","cccccccc-cccc-cccc-cccc-cccccccccccc").put("version",1).put("algorithm","AES-256-GCM").put("chunkSize",1048576).put("kind","video").put("pageCount",JSONObject.NULL).put("title","Saved fixture").put("files",new JSONArray().put(new JSONObject().put("index",0).put("number",1).put("size",plain.length).put("chunks",1).put("mime","video/mp4").put("quality","1080p")));
        byte[] iv=new byte[12];Cipher encoder=Cipher.getInstance("AES/GCM/NoPadding");encoder.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));encoder.updateAAD(("mirea-download-v1|"+id+"|0|0|"+plain.length).getBytes(StandardCharsets.UTF_8));byte[] encrypted=encoder.doFinal(plain),chunk=new byte[12+encrypted.length];System.arraycopy(encrypted,0,chunk,12,encrypted.length);
        StringBuilder hash=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(chunk))hash.append(String.format("%02x",b));
        PlaybackCache cache=new PlaybackCache(context);cache.begin(api.partition,manifest);cache.put(api.partition,id,0,chunk,hash.toString());cache.complete(api.partition,id);
        long now=System.currentTimeMillis();String contentKey=Base64.getEncoder().encodeToString(key);JSONObject grant=new JSONObject().put("manifest",manifest).put("userId",api.userId).put("key",contentKey).put("serverTime",now).put("expiresAt",now+OfflineLease.WINDOW);
        try(Endpoint endpoint=new Endpoint(grant)){
            JSONObject response=PlaybackApi.requestJson(endpoint.connection("/open","POST"),null);
            assertEquals("POST",endpoint.method);assertEquals("application/json",endpoint.type);assertArrayEquals("{}".getBytes(StandardCharsets.UTF_8),endpoint.body);assertEquals("2",endpoint.length);
            OfflineLease vault=new OfflineLease(context,create->new SecretKeySpec(key,"AES"));vault.save(api,response);
            String saved=context.getSharedPreferences("mirea-offline-v1",Context.MODE_PRIVATE).getString(api.partition+"|"+id,"");assertFalse(saved.contains(contentKey));assertFalse(saved.contains("manifest"));
            OfflineLease restarted=new OfflineLease(context,create->new SecretKeySpec(key,"AES"));JSONObject restored=restarted.load(api,id);assertEquals(id,restored.getJSONObject("manifest").getString("id"));assertTrue(restored.getLong("expiresAt")<=System.currentTimeMillis()+OfflineLease.WINDOW);
            try(PlaybackSource source=new PlaybackSource(api,restored,cache.folder(api.partition,id))){byte[] actual=new byte[100];assertEquals(100,source.readAt(0,actual,0,100));assertArrayEquals(plain,actual);}
            assertArrayEquals(chunk,Files.readAllBytes(new File(cache.folder(api.partition,id),"0.chunk").toPath()));assertTrue(cache.begin(api.partition,manifest));
            restarted.revoke(api.partition,id);assertThrows(IllegalStateException.class,()->restarted.load(api,id));assertTrue(new File(cache.folder(api.partition,id),"complete").isFile());
        }finally{api.close();}
    }
    @Test public void getDoesNotAcquireBodyAndExplicitJsonPostPreservesUtf8Bytes()throws Exception{
        try(Endpoint endpoint=new Endpoint(new JSONObject().put("ok",true))){
            assertTrue(PlaybackApi.requestJson(endpoint.connection("/read","GET"),null).getBoolean("ok"));assertEquals("GET",endpoint.method);assertEquals(0,endpoint.body.length);assertNull(endpoint.type);
            JSONObject body=new JSONObject().put("title","日本語の進行度").put("positionMs",1234);assertTrue(PlaybackApi.requestJson(endpoint.connection("/write","POST"),body).getBoolean("ok"));assertArrayEquals(body.toString().getBytes(StandardCharsets.UTF_8),endpoint.body);assertEquals(Integer.toString(endpoint.body.length),endpoint.length);
        }
    }
    @Test public void rejectedLeaseKeepsHttpStatusAndNeverReturnsServerErrorBodyAsGrant()throws Exception{
        try(Endpoint endpoint=new Endpoint(new JSONObject())){
            PlaybackApi.Failure failure=assertThrows(PlaybackApi.Failure.class,()->PlaybackApi.requestJson(endpoint.connection("/denied","POST"),null));assertEquals(401,failure.status);assertTrue(failure.denied());assertFalse(failure.getMessage().contains("test rejection"));
        }
    }
}
