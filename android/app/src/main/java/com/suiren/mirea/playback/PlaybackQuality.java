package com.suiren.mirea.playback;

import org.json.*;
import java.util.*;

/** Resolve explicit levels without silently turning a missing fixed level into ABR. */
public final class PlaybackQuality {
    public static String resolve(JSONArray qualities,String requested){
        if(Arrays.asList("auto","higher","data").contains(requested))return qualities.length()>0?requested:"legacy";
        if(requested==null||!requested.matches("[0-9]{2,4}p"))return "legacy";
        ArrayList<String> names=new ArrayList<>();
        for(int i=0;i<qualities.length();i++){JSONObject r=qualities.optJSONObject(i);String name=r==null?"":r.optString("quality");if(name.matches("[0-9]{2,4}p"))names.add(name);}
        names.sort((a,b)->Integer.compare(height(b),height(a)));
        for(String name:names)if(height(name)<=height(requested))return name;
        return names.isEmpty()?"legacy":names.get(names.size()-1);
    }
    private static int height(String value){return Integer.parseInt(value.substring(0,value.length()-1));}
}
