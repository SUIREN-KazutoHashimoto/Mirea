package com.suiren.mirea.playback;

import org.junit.Test;
import static org.junit.Assert.*;
import org.json.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
import javax.crypto.*;
import javax.crypto.spec.*;

public class PlaybackTest {
    @Test public void offlineLeaseClockUsesRealElapsedTimeAndRejectsRollbackAcrossRestart()throws Exception{
        long wall=1800000000000L;
        JSONObject record=new JSONObject().put("wall",wall).put("lastWall",wall+1000).put("elapsed",10000).put("lastElapsed",11000).put("grant",new JSONObject().put("serverTime",wall).put("expiresAt",wall+OfflineLease.WINDOW));
        assertEquals(OfflineLease.WINDOW-1000,OfflineLease.remaining(record,wall+1000,11000));
        assertEquals(0,OfflineLease.remaining(record,wall+1000,10000+OfflineLease.WINDOW));
        assertEquals(OfflineLease.WINDOW-86400000,OfflineLease.remaining(record,wall+86400000,500));
        try{OfflineLease.remaining(record,wall-2000,12000);fail();}catch(IllegalStateException expected){}
    }
    @Test public void offlineProgressReopensWithoutNetworkAndPreservesPendingIdsForAutomaticReconnect()throws Exception{
        final JSONObject[] saved={new JSONObject().put("revision",3).put("last",new JSONObject().put("positionMs",2000).put("durationMs",10000))};final boolean[] online={false};List<JSONObject> sent=new ArrayList<>();
        PlaybackProgress.Store store=new PlaybackProgress.Store(){public JSONObject load(){return saved[0];}public void save(JSONObject row){saved[0]=row;}};
        PlaybackProgress.Transport transport=(method,body)->{if(!online[0])throw new java.io.IOException("offline");if(method.equals("GET"))return new JSONObject().put("revision",3);sent.add(new JSONObject(body.toString()));return new JSONObject().put("progress",new JSONObject().put("revision",4).put("positionMs",5000).put("durationMs",10000));};
        PlaybackProgress offline=new PlaybackProgress(transport,store);assertEquals(2000,offline.initial().getLong("positionMs"));offline.update(5000,10000);try{offline.flush();fail();}catch(java.io.IOException expected){}
        String pending=saved[0].getJSONObject("pending").getString("updateId");
        PlaybackProgress restarted=new PlaybackProgress(transport,store);assertEquals(5000,restarted.initial().getLong("positionMs"));
        online[0]=true;restarted.flush();assertEquals(pending,sent.get(0).getString("updateId"));assertEquals(3,sent.get(0).getLong("revision"));assertEquals(4,saved[0].getLong("revision"));
    }
    @Test public void fixedQualityPersistsAsACompatibleResolutionWithoutClaimingNativeAbr()throws Exception{
        JSONArray q=new JSONArray().put(new JSONObject().put("quality","360p")).put(new JSONObject().put("quality","720p"));
        assertEquals("720p",PlaybackQuality.resolve(q,"1080p"));assertEquals("360p",PlaybackQuality.resolve(q,"480p"));assertEquals("360p",PlaybackQuality.resolve(q,"144p"));assertEquals("legacy",PlaybackQuality.resolve(q,"legacy"));assertEquals("legacy",PlaybackQuality.resolve(new JSONArray(),"720p"));assertEquals("legacy",PlaybackQuality.resolve(q,"../../original"));
    }
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
