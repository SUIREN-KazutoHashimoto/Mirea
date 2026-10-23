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
}
