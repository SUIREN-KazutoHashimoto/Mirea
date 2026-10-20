package com.suiren.mirea.playback;

import org.junit.Test;
import static org.junit.Assert.*;
import org.json.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
import javax.crypto.*;
import javax.crypto.spec.*;

public class PlaybackTest {
    @Test public void contextsRequireHttpsAndNeverPutCredentialsInPaths()throws Exception{
        PlaybackApi api=new PlaybackApi("https://mirea.example:3443/","a".repeat(43),"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");assertEquals(64,api.partition.length());assertEquals("https://mirea.example:3443",api.origin);
        for(String origin:new String[]{"http://mirea.example","https://user:password@mirea.example","https://mirea.example/path","https://mirea.example/?token=abc"}){try{new PlaybackApi(origin,"a".repeat(43),api.userId);fail(origin);}catch(IllegalArgumentException expected){}}
        try{api.connection("https://evil.test/","GET");fail();}catch(Exception expected){}api.close();try{api.connection("/api/v1/items/test/content","GET");fail();}catch(Exception expected){}
    }
    @Test public void ciphertextUsesExactServerAadAndDetectsTamperingSwapsAndWrongKey()throws Exception{
        byte[] key=new byte[32],iv=new byte[12],plain="Mirea encrypted playback".getBytes(StandardCharsets.UTF_8);new Random(1).nextBytes(key);String id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        Cipher encrypt=Cipher.getInstance("AES/GCM/NoPadding");encrypt.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));encrypt.updateAAD(("mirea-download-v1|"+id+"|0|0|"+plain.length).getBytes(StandardCharsets.UTF_8));byte[] payload=encrypt.doFinal(plain),bytes=new byte[iv.length+payload.length];System.arraycopy(iv,0,bytes,0,12);System.arraycopy(payload,0,bytes,12,payload.length);
        assertArrayEquals(plain,PlaybackSource.decrypt(key,id,0,plain.length,bytes));try{PlaybackSource.decrypt(key,id,1,plain.length,bytes);fail();}catch(Exception expected){}
        bytes[15]^=1;try{PlaybackSource.decrypt(key,id,0,plain.length,bytes);fail();}catch(Exception expected){}
    }
    @Test public void nativeRecorderSeparatesBackgroundPipAndSeeksWithoutInventingSuspendedTime()throws Exception{
        List<JSONObject> events=new ArrayList<>();PlaybackRecorder r=new PlaybackRecorder("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","test",0,(v,e)->events.add(e));
        JSONObject state=new JSONObject().put("visible",false).put("focused",false).put("idle",false).put("backgroundPlayback",true).put("pictureInPicture",false).put("playing",true).put("seeking",false).put("buffering",false).put("rate",1).put("toMs",0).put("durationMs",100000);
        r.sample(0,state,null);state.put("toMs",1000);r.sample(1000,state,null);JSONObject e=events.stream().filter(x->"interval".equals(x.optString("type"))).findFirst().get();assertEquals(1000,e.getLong("watchMs"));assertEquals(1000,e.getLong("backgroundMs"));assertEquals(0,e.getLong("activeMs"));
        state.put("visible",true).put("backgroundPlayback",false).put("pictureInPicture",true);r.sample(1000,state,"viewport");state.put("toMs",2000);r.sample(2000,state,null);assertEquals(1000,events.get(events.size()-1).getLong("pipMs"));
        state.put("toMs",62000);r.sample(62000,state,null);assertEquals(0,events.get(events.size()-1).getLong("watchMs"));assertEquals(58000,events.get(events.size()-1).getLong("gapMs"));
        state.put("pictureInPicture",false).put("focused",true).put("idle",true).put("playing",false);r.sample(62000,state,"pause");r.sample(63000,state,null);assertEquals(1000,events.get(events.size()-1).getLong("visibleMs"));assertEquals(0,events.get(events.size()-1).getLong("activeMs"));assertEquals(0,events.get(events.size()-1).getLong("watchMs"));r.close(63000,state);
    }
    @Test public void progressRetainsExactRetryIdsAndStopsOnAnotherDeviceConflict()throws Exception{
        final JSONObject[] record={null};List<JSONObject> sent=new ArrayList<>();final boolean[] failOnce={true};final int[] revision={0};
        PlaybackProgress.Store store=new PlaybackProgress.Store(){public JSONObject load(){return record[0];}public void save(JSONObject value){record[0]=value;}};
        PlaybackProgress p=new PlaybackProgress((method,body)->{if(method.equals("GET"))return new JSONObject().put("revision",revision[0]);sent.add(new JSONObject(body.toString()));if(failOnce[0]){failOnce[0]=false;throw new java.io.IOException("Lost response");}return new JSONObject().put("progress",new JSONObject().put("revision",++revision[0]));},store);
        p.update(1000,10000);try{p.flush();fail();}catch(java.io.IOException expected){}assertNotNull(record[0]);p.update(3000,10000);p.flush();assertEquals(sent.get(0).toString(),sent.get(1).toString());assertEquals(1,sent.get(2).getLong("revision"));assertEquals(3000,sent.get(2).getLong("positionMs"));
        PlaybackProgress conflict=new PlaybackProgress((method,body)->{if(method.equals("GET"))return new JSONObject().put("revision",2);throw new PlaybackApi.Failure(409);},new PlaybackProgress.Store(){public JSONObject load(){return null;}public void save(JSONObject value){}});
        conflict.update(1,100);try{conflict.flush();fail();}catch(PlaybackApi.Failure expected){}assertTrue(conflict.conflicted);
    }
}
