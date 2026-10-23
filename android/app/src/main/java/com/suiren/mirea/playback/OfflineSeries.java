package com.suiren.mirea.playback;

import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;

// Metadata only, supplied by the account-partitioned web vault. A descriptor
// never grants access: open() still verifies OfflineLease and complete cache.
final class OfflineSeries {
    static JSONObject context(JSONObject request,String id)throws Exception{
        JSONObject value=request.optJSONObject("offlineSeries");if(value==null)return new JSONObject().put("series",JSONObject.NULL).put("items",new JSONArray()).put("currentIndex",-1);
        JSONObject series=value.getJSONObject("series");JSONArray items=value.getJSONArray("items");
        if(!PlaybackApi.uuid(series.getString("id"))||items.length()>1000)throw new IOException("Invalid offline series");
        JSONArray safe=new JSONArray();int current=-1;java.util.HashSet<String> seen=new java.util.HashSet<>();
        for(int n=0;n<items.length();n++){
            JSONObject item=items.getJSONObject(n),membership=item.optJSONObject("series");String asset=item.getString("id");
            if(!PlaybackApi.uuid(asset)||!seen.add(asset)||membership==null||!series.getString("id").equals(membership.optString("id")))throw new IOException("Invalid offline membership");
            safe.put(new JSONObject(item.toString()));if(asset.equals(id))current=n;
        }
        if(current<0)throw new IOException("Offline series changed");
        return new JSONObject().put("series",series).put("items",safe).put("currentIndex",current);
    }
    static JSONObject nextRequest(JSONObject request,JSONObject item,boolean restart,boolean autoplay)throws Exception{
        JSONObject manifest=item.optJSONObject("offlineDownload");
        if(manifest==null||!PlaybackApi.uuid(manifest.optString("id"))||!item.getString("id").equals(manifest.optString("assetId")))throw new IOException("次の作品は未保存・期限切れのため、オフラインでは開けません。");
        JSONObject asset=new JSONObject(item.toString());asset.remove("offlineDownload");asset.remove("offlineUnavailable");asset.remove("offlineStatus");
        JSONObject result=new JSONObject(request.toString()).put("item",asset).put("download",manifest).put("offline",true).put("restart",restart).put("autoplay",autoplay).put("orderContinuation",true);
        result.remove("quality");result.remove("artwork");return result;
    }
}
