package com.suiren.mirea.playback;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class OfflineSeriesTest {
    private final String series="00000000-0000-4000-8000-000000000001",one="00000000-0000-4000-8000-000000000002",two="00000000-0000-4000-8000-000000000003",download="00000000-0000-4000-8000-000000000004";
    private JSONObject asset(String id)throws Exception{return new JSONObject().put("id",id).put("title","Offline song").put("kind","audio").put("series",new JSONObject().put("id",series));}
    private JSONObject request()throws Exception{return new JSONObject().put("origin","https://mirea.test").put("userId","user").put("offline",true).put("item",asset(one)).put("quality","1080p").put("artwork","old").put("offlineSeries",new JSONObject().put("series",new JSONObject().put("id",series)).put("items",new JSONArray().put(asset(one)).put(asset(two).put("offlineDownload",new JSONObject().put("id",download).put("assetId",two)))));}
    @Test public void preservesSeriesOrderAndRequiresDownloadDescriptor()throws Exception{
        JSONObject req=request(),context=OfflineSeries.context(req,one);assertEquals(0,context.getInt("currentIndex"));assertEquals(two,context.getJSONArray("items").getJSONObject(1).getString("id"));
        JSONObject next=OfflineSeries.nextRequest(req,context.getJSONArray("items").getJSONObject(1),true,true);assertTrue(next.getBoolean("offline"));assertEquals(download,next.getJSONObject("download").getString("id"));assertFalse(next.has("artwork"));assertFalse(next.has("quality"));assertFalse(next.getJSONObject("item").has("offlineDownload"));assertTrue(next.has("offlineSeries"));
        try{OfflineSeries.nextRequest(req,asset(one),true,true);fail();}catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("未保存"));}
    }
    @Test public void rejectsForeignMembershipDuplicatesAndWrongAssetManifest()throws Exception{
        JSONObject req=request();req.getJSONObject("offlineSeries").getJSONArray("items").getJSONObject(1).getJSONObject("series").put("id",two);
        try{OfflineSeries.context(req,one);fail();}catch(java.io.IOException expected){}
        req=request();req.getJSONObject("offlineSeries").getJSONArray("items").put(asset(one));try{OfflineSeries.context(req,one);fail();}catch(java.io.IOException expected){}
        JSONObject wrong=asset(two).put("offlineDownload",new JSONObject().put("id",download).put("assetId",one));try{OfflineSeries.nextRequest(request(),wrong,false,true);fail();}catch(java.io.IOException expected){}
    }
    @Test public void savedNextStaysLocalEvenOnlineAndOfflineOrderSkipsUnavailableMediaAndBooks()throws Exception{
        JSONObject req=request(),saved=req.getJSONObject("offlineSeries").getJSONArray("items").getJSONObject(1);
        JSONObject online=OfflineSeries.nextRequest(req,saved,true,true,false);assertFalse(online.getBoolean("offline"));assertEquals(download,online.getJSONObject("download").getString("id"));
        String missing="00000000-0000-4000-8000-000000000005",book="00000000-0000-4000-8000-000000000006";
        JSONArray rows=new JSONArray().put(asset(one)).put(asset(missing)).put(asset(book).put("kind","book")).put(saved);
        JSONArray usable=OfflineSeries.playable(rows,one,true);assertEquals(2,usable.length());assertEquals(two,usable.getJSONObject(1).getString("id"));
        PlaybackOrder.Plan plan=new PlaybackOrder().plan(usable,one,series,1,false,false);assertEquals(two,plan.target.getString("id"));
        assertEquals(3,OfflineSeries.playable(rows,one,false).length());
        JSONObject streamed=OfflineSeries.nextRequest(online,asset(missing),false,false,false);assertFalse(streamed.has("download"));assertFalse(streamed.getBoolean("autoplay"));
    }
    @Test public void seriesBeyondOneThousandAreValidButPlaylistsKeepTheirBound()throws Exception{
        JSONObject req=request();JSONArray rows=new JSONArray().put(asset(one));for(int i=10;i<1011;i++)rows.put(asset(String.format("00000000-0000-4000-8000-%012d",i)));
        req.getJSONObject("offlineSeries").put("items",rows);assertEquals(1002,OfflineSeries.context(req,one).getJSONArray("items").length());
        req.put("playlistId",series);try{OfflineSeries.context(req,one);fail();}catch(java.io.IOException expected){}
    }
}
