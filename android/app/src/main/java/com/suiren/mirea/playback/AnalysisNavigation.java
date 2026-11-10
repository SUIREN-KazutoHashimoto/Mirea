package com.suiren.mirea.playback;
import org.json.*;
import java.util.*;
/** Saved, bounded AI sections; these descriptors never authorize media access. */
public final class AnalysisNavigation {
    public static JSONObject validate(JSONObject pack,String user,String asset)throws Exception{
        if(pack==null||pack.toString().length()>4*1024*1024||pack.optInt("version")!=1||!user.equals(pack.optString("userId"))||!asset.equals(pack.optString("assetId")))throw new IllegalArgumentException("Analysis identity mismatch");
        long issued=integer(pack,"serverTime"),expires=integer(pack,"expiresAt");
        if(issued<=0||expires<=issued||expires-issued>OfflineLease.WINDOW)throw new IllegalArgumentException("Analysis expired");
        JSONArray rows=segments(pack);if(rows.length()>5000)throw new IllegalArgumentException("Analysis limit");
        for(int n=0;n<rows.length();n++){JSONObject row=rows.getJSONObject(n);if(integer(row,"startMs")<0||integer(row,"endMs")<=integer(row,"startMs")||row.optString("label").length()>160)throw new IllegalArgumentException("Analysis interval");}
        return new JSONObject(pack.toString());
    }
    public static int nextChorus(JSONObject pack,long position){JSONArray rows=segments(pack);int first=-1,next=-1;long earliest=Long.MAX_VALUE,upcoming=Long.MAX_VALUE;for(int n=0;n<rows.length();n++){JSONObject row=rows.optJSONObject(n);if(row==null||!("chorus".equals(row.optString("kind"))||"サビ".equals(row.optString("label"))))continue;long start=row.optLong("startMs");if(start<earliest){first=n;earliest=start;}if(start>position+250&&start<upcoming){next=n;upcoming=start;}}return next>=0?next:first;}
    private static long integer(JSONObject object,String key)throws Exception{Object value=object.get(key);if(!(value instanceof Number))throw new IllegalArgumentException("Analysis number");double number=((Number)value).doubleValue();if(!Double.isFinite(number)||number!=Math.rint(number)||Math.abs(number)>9007199254740991d)throw new IllegalArgumentException("Analysis number");return ((Number)value).longValue();}
    public static JSONArray segments(JSONObject pack){
        JSONArray result=new JSONArray();if(pack==null)return result;JSONObject features=pack.optJSONObject("features");if(features==null)return result;
        for(String name:Arrays.asList("structure","chapters")){JSONObject feature=features.optJSONObject(name),value=feature==null?null:feature.optJSONObject("result");JSONArray rows=value==null?null:value.optJSONArray("segments");if(rows!=null)for(int n=0;n<rows.length();n++)if(rows.optJSONObject(n)!=null)result.put(rows.optJSONObject(n));}
        return result;
    }
}
