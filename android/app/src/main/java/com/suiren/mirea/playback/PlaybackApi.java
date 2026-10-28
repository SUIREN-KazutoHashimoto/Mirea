package com.suiren.mirea.playback;

import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** No persistent credentials, redirect following, permissive trust manager or arbitrary URLs. */
public final class PlaybackApi {
    public final String origin, userId, partition;
    private String token,shelfUnlock;
    public volatile boolean closed;
    public static final class Failure extends IOException {
        public final int status;
        Failure(int status){super("Playback API failed ("+status+")");this.status=status;}
        public boolean denied(){return status==401||status==403||status==404||status==410;}
    }
    public PlaybackApi(String origin,String token,String userId)throws Exception{
        this(origin,token,userId,"");
    }
    public PlaybackApi(String origin,String token,String userId,String shelfUnlock)throws Exception{
        URI uri=new URI(origin);
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!(uri.getRawPath().isEmpty()||"/".equals(uri.getRawPath()))||!token.matches("[A-Za-z0-9_-]{43}")||!uuid(userId))throw new IllegalArgumentException("Invalid playback context");
        this.origin=origin.replaceAll("/+$","");this.token=token;this.userId=userId;
        if(shelfUnlock==null||!shelfUnlock.isEmpty()&&!shelfUnlock.matches("[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43}){0,19}"))throw new IllegalArgumentException("Invalid shelf context");this.shelfUnlock=shelfUnlock;
        byte[] digest=MessageDigest.getInstance("SHA-256").digest((this.origin+"|"+userId).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format("%02x",b));partition=hex.toString();
    }
    public PlaybackApi fork()throws Exception{if(closed)throw new IOException("Closed context");return new PlaybackApi(origin,token,userId,shelfUnlock);}
    public static boolean uuid(String value){return value!=null&&value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");}
    public HttpURLConnection connection(String path,String method)throws IOException{
        if(closed||!safePath(path))throw new IOException("Playback context closed or invalid path");
        HttpURLConnection c=(HttpURLConnection)new URL(origin+path).openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(10000);c.setReadTimeout(15000);c.setRequestMethod(method);c.setRequestProperty("Authorization","Bearer "+token);if(!shelfUnlock.isEmpty())c.setRequestProperty("X-Mirea-Shelf-Unlock",shelfUnlock);c.setRequestProperty("Cache-Control","no-store");c.setRequestProperty("Accept-Encoding","identity");return c;
    }
    static boolean safePath(String path){
        if(path==null||!path.startsWith("/api/v1/")||path.contains("..")||path.contains("#")||path.contains("%")||path.contains("\\")||path.contains("\r")||path.contains("\n"))return false;
        if(!path.contains("?"))return path.matches("/api/v1/[A-Za-z0-9_/-]+");
        if(path.matches("/api/v1/items/[0-9a-f-]{36}/content\\?ticket=[A-Za-z0-9_-]{43}"))return true;
        return path.matches("/api/v1/items/[0-9a-f-]{36}/(?:renditions/[0-9]{2,4}p/content|hls/(?:master\\.m3u8|[0-9]{2,4}p(?:\\.m3u8|-init\\.mp4|-[0-9]{5}\\.m4s)))\\?generation=(?:base|[0-9a-f-]{36})")||path.matches("/api/v1/items/[0-9a-f-]{36}/navigation/storyboard\\?revision=[0-9]{1,10}");
    }
    public JSONObject json(String path,String method,JSONObject body)throws Exception{
        return requestJson(connection("/api/v1"+path,method),body);
    }
    static JSONObject requestJson(HttpURLConnection c,JSONObject body)throws Exception{
        try{
            // Android adds a form Content-Type even to an otherwise empty POST.
            // Send a real JSON object so Fastify does not reject lease renewal
            // with 415 (or reject an empty application/json body with 400).
            if(body==null&&"POST".equals(c.getRequestMethod()))body=new JSONObject();
            if(body!=null){byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=c.getOutputStream()){out.write(bytes);}}
            int status=c.getResponseCode();if(status<200||status>=300)throw new Failure(status);
            if(status==204)return new JSONObject();return new JSONObject(new String(read(c.getInputStream(),4*1024*1024),StandardCharsets.UTF_8));
        }finally{c.disconnect();}
    }
    public static byte[] read(InputStream input,int maximum)throws IOException{
        try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[16384];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>maximum)throw new IOException("Response too large");out.write(buffer,0,n);}return out.toByteArray();}
    }
    public void close(){closed=true;token="";shelfUnlock="";}
}
