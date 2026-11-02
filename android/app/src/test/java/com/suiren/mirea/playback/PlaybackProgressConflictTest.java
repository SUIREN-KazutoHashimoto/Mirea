package com.suiren.mirea.playback;

import org.json.JSONObject;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class PlaybackProgressConflictTest {
    private static class Saved implements PlaybackProgress.Store {
        JSONObject value;public JSONObject load(){return value;}public void save(JSONObject row)throws Exception{value=new JSONObject(row.toString());}
    }
    private JSONObject position(long at,long revision)throws Exception{return new JSONObject().put("positionMs",at).put("durationMs",100000).put("revision",revision);}
    @Test public void savedPlaybackStartsWithoutNetworkAndConflictSurvivesRestartUntilExplicitLocalChoice()throws Exception{
        Saved store=new Saved();List<JSONObject> sent=new ArrayList<>();final int[] calls={0};
        PlaybackProgress.Transport transport=(method,body)->{calls[0]++;if(method.equals("GET"))return new JSONObject().put("revision",8).put("progress",position(70000,8));sent.add(new JSONObject(body.toString()));return new JSONObject().put("progress",position(body.getLong("positionMs"),9));};
        PlaybackProgress p=new PlaybackProgress(transport,store,true);p.seed(position(10000,7));assertEquals(0,calls[0]);p.update(12000,100000);p.refreshInitialFromRemote();assertTrue(p.conflicted);assertEquals(12000,p.initial().getLong("positionMs"));p.update(15000,100000);p.flush();assertTrue(sent.isEmpty());
        PlaybackProgress reopened=new PlaybackProgress(transport,store,true);assertTrue(reopened.conflicted);assertEquals(15000,reopened.initial().getLong("positionMs"));reopened.resolve(true);assertFalse(reopened.conflicted);assertEquals(1,sent.size());assertEquals(8,sent.get(0).getLong("revision"));assertEquals(15000,sent.get(0).getLong("positionMs"));assertFalse(store.value.has("pending")&&!store.value.isNull("pending"));
    }
    @Test public void remoteChoiceDoesNotSubmitOrSilentlyUseTheLocalPosition()throws Exception{
        Saved store=new Saved();final int[] puts={0};PlaybackProgress p=new PlaybackProgress((method,body)->{if(method.equals("PUT"))puts[0]++;return new JSONObject().put("revision",9).put("progress",position(80000,9));},store,true);
        p.seed(position(10000,7));p.update(20000,100000);p.refreshInitialFromRemote();JSONObject selected=p.resolve(false);assertEquals(80000,selected.getLong("positionMs"));assertEquals(0,puts[0]);assertFalse(p.conflicted);assertEquals(80000,p.initial().getLong("positionMs"));
    }
    @Test public void sameRemoteBaselineRebasesCurrentListeningWithoutFalseConflictAndFailedReadCanRetry()throws Exception{
        Saved store=new Saved();final boolean[] fail={true};final int[] calls={0};final JSONObject[] put={null};
        PlaybackProgress p=new PlaybackProgress((method,body)->{calls[0]++;if(fail[0])throw new java.net.SocketTimeoutException();if(method.equals("GET"))return new JSONObject().put("revision",8).put("progress",position(10000,8));put[0]=body;return new JSONObject().put("progress",position(body.getLong("positionMs"),9));},store,true);
        p.seed(position(10000,7));p.update(12000,100000);try{p.refreshInitialFromRemote();fail();}catch(java.net.SocketTimeoutException expected){}assertFalse(p.conflicted);fail[0]=false;p.refreshInitialFromRemote();assertFalse(p.conflicted);assertEquals(12000,p.initial().getLong("positionMs"));p.refreshInitialFromRemote();assertEquals(2,calls[0]);p.flush();assertEquals(8,put[0].getLong("revision"));assertEquals(12000,put[0].getLong("positionMs"));
    }
}
