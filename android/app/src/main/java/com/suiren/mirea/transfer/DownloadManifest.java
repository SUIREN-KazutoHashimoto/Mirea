package com.suiren.mirea.transfer;
import org.json.*;
import com.suiren.mirea.playback.PlaybackApi;
import java.util.*;

public final class DownloadManifest {
    public static final int CHUNK=1048576;
    public static JSONObject validate(JSONObject m)throws Exception{
        if(m.getInt("version")!=1||!"AES-256-GCM".equals(m.getString("algorithm"))||m.getInt("chunkSize")!=CHUNK||!PlaybackApi.uuid(m.getString("id"))||!PlaybackApi.uuid(m.getString("assetId")))throw new IllegalArgumentException("Invalid encrypted manifest");
        String kind=m.getString("kind");if(!Arrays.asList("audio","video","pdf","epub","image-book").contains(kind))throw new IllegalArgumentException();
        JSONArray files=m.getJSONArray("files");long pages=m.getLong("pageCount"),total=0;
        if(pages<1||pages>1000000||files.length()<1||files.length()>1000||("image-book".equals(kind)?pages!=files.length():files.length()!=1))throw new IllegalArgumentException();
        for(int n=0;n<files.length();n++){
            JSONObject f=files.getJSONObject(n);long size=f.getLong("size");String mime=f.getString("mime");
            if(f.getInt("index")!=n||size<=0||size>8589934592L||f.getInt("chunks")!=(size+CHUNK-1)/CHUNK||!Arrays.asList("audio/mp4","video/mp4","video/webm","application/pdf","image/png","image/jpeg","image/webp","application/vnd.mirea.epub+json").contains(mime))throw new IllegalArgumentException();
            if("audio".equals(kind)!=mime.equals("audio/mp4")||"epub".equals(kind)!=mime.equals("application/vnd.mirea.epub+json")||f.has("quality")&&(!kind.equals("video")||!f.getString("quality").matches("[0-9]{2,4}p")))throw new IllegalArgumentException();
            total+=size;
        }
        if(total>8589934592L)throw new IllegalArgumentException();return m;
    }
    public static long total(JSONObject m)throws Exception{long n=0;JSONArray f=m.getJSONArray("files");for(int i=0;i<f.length();i++)n+=f.getJSONObject(i).getLong("size");return n;}
}
