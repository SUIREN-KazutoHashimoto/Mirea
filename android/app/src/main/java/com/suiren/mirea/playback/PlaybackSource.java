package com.suiren.mirea.playback;

import android.media.MediaDataSource;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Bounded Range reads; ciphertext at rest; ephemeral keys only in the live service. */
public final class PlaybackSource extends MediaDataSource {
    private final PlaybackApi api;
    private final String path;
    private final long size;
    private long expiresAt;
    private long deadline=Long.MAX_VALUE,lastWall=System.currentTimeMillis();
    private final JSONObject manifest;
    private final File folder;
    private byte[] key;
    private boolean closed;
    private final int blockSize;
    private final LinkedHashMap<Long,byte[]> blocks=new LinkedHashMap<>(4,.75f,true);
    public PlaybackSource(PlaybackApi api,String path,long size){this.api=api;this.path=path;this.size=size;this.expiresAt=Long.MAX_VALUE;manifest=null;folder=null;blockSize=262144;}
    public PlaybackSource(PlaybackApi api,JSONObject grant,File folder)throws Exception{
        this.api=api;this.path=null;this.folder=folder;manifest=grant.getJSONObject("manifest");validateManifest(manifest);
        size=manifest.getJSONArray("files").getJSONObject(0).getLong("size");blockSize=1048576;expiresAt=grant.getLong("expiresAt");key=Base64.getDecoder().decode(grant.getString("key"));
        if(key.length!=32||expiresAt<=System.currentTimeMillis())throw new IOException("Invalid playback grant");
        deadline=android.os.SystemClock.elapsedRealtime()+expiresAt-System.currentTimeMillis();
    }
    public synchronized void renew(long expires){if(manifest!=null&&expires>System.currentTimeMillis()){expiresAt=expires;deadline=android.os.SystemClock.elapsedRealtime()+expires-System.currentTimeMillis();}}
    public static void validateManifest(JSONObject m)throws Exception{
        if(m.getInt("version")!=1||!"AES-256-GCM".equals(m.getString("algorithm"))||m.getInt("chunkSize")!=1048576||!PlaybackApi.uuid(m.getString("id"))||!PlaybackApi.uuid(m.getString("assetId"))||!Arrays.asList("video","audio").contains(m.getString("kind"))||m.getJSONArray("files").length()!=1)throw new IOException("Invalid encrypted media manifest");
        JSONObject f=m.getJSONArray("files").getJSONObject(0);long size=f.getLong("size");
        if(f.getInt("index")!=0||size<1||size>8589934592L||f.getInt("chunks")!=(size+1048575)/1048576||!(m.getString("kind").equals("audio")?"audio/mp4".equals(f.getString("mime")):Arrays.asList("video/mp4","video/webm").contains(f.getString("mime"))))throw new IOException("Invalid encrypted media file");
    }
    public static byte[] decrypt(byte[] key,String id,int part,int length,byte[] bytes)throws Exception{
        if(key.length!=32||bytes.length!=length+28)throw new IOException("Invalid encrypted chunk");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,bytes,0,12));
        cipher.updateAAD(("mirea-download-v1|"+id+"|0|"+part+"|"+length).getBytes(StandardCharsets.UTF_8));return cipher.doFinal(bytes,12,bytes.length-12);
    }
    private byte[] block(long number)throws IOException{
        byte[] cached=blocks.get(number);if(cached!=null)return cached;
        long start=number*blockSize;int length=(int)Math.min(blockSize,size-start);byte[] bytes;
        try{
            if(manifest!=null){
                File chunk=new File(folder,number+".chunk");if(chunk.length()!=length+28)throw new IOException("Saved chunk missing");
                byte[] encrypted=Files.readAllBytes(chunk.toPath());try{bytes=decrypt(key,manifest.getString("id"),(int)number,length,encrypted);}finally{Arrays.fill(encrypted,(byte)0);}
            }else{
                HttpURLConnection c=api.connection(path,"GET");c.setRequestProperty("Range","bytes="+start+"-"+(start+length-1));
                try{int status=c.getResponseCode();if(status!=206)throw new PlaybackApi.Failure(status);
                    if(!("bytes "+start+"-"+(start+length-1)+"/"+size).equals(c.getHeaderField("Content-Range")))throw new IOException("Invalid Range response");
                    bytes=PlaybackApi.read(c.getInputStream(),length);if(bytes.length!=length)throw new IOException("Truncated media response");
                }finally{c.disconnect();}
            }
        }catch(IOException e){throw e;}catch(Exception e){throw new IOException("Encrypted media verification failed",e);}
        blocks.put(number,bytes);if(blocks.size()>2){Long first=blocks.keySet().iterator().next();Arrays.fill(blocks.remove(first),(byte)0);}return bytes;
    }
    @Override public synchronized int readAt(long position,byte[] buffer,int offset,int count)throws IOException{
        long wall=System.currentTimeMillis();
        if(closed||api.closed||wall<lastWall-1000||wall>=expiresAt||android.os.SystemClock.elapsedRealtime()>=deadline)throw new IOException("Playback grant expired");
        lastWall=Math.max(lastWall,wall);
        if(position<0||offset<0||count<0||offset>buffer.length-count)throw new IOException("Invalid media read");
        if(count==0)return 0;if(position>=size)return -1;
        byte[] bytes=block(position/blockSize);int from=(int)(position%blockSize),n=(int)Math.min(Math.min(count,bytes.length-from),size-position);System.arraycopy(bytes,from,buffer,offset,n);return n;
    }
    @Override public long getSize(){return size;}
    @Override public synchronized void close(){closed=true;if(key!=null){Arrays.fill(key,(byte)0);key=null;}for(byte[] bytes:blocks.values())Arrays.fill(bytes,(byte)0);blocks.clear();}
}
