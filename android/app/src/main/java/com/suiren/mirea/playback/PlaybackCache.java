package com.suiren.mirea.playback;

import android.content.Context;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Contains only the same authenticated ciphertext as the browser cache. */
public final class PlaybackCache {
    private final File root;
    public PlaybackCache(Context c){root=new File(c.getFilesDir(),"playback-ciphertext");}
    public File folder(String partition,String id)throws IOException{
        if(!partition.matches("[0-9a-f]{64}")||!PlaybackApi.uuid(id))throw new IOException("Invalid cache identity");
        File result=new File(new File(root,partition),id);if(!result.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator))throw new IOException("Invalid cache path");return result;
    }
    public boolean begin(String partition,JSONObject manifest)throws Exception{
        PlaybackSource.validateManifest(manifest);File folder=folder(partition,manifest.getString("id"));
        File metadata=new File(folder,"manifest.json");
        if(metadata.isFile()){
            JSONObject old=new JSONObject(new String(Files.readAllBytes(metadata.toPath()),StandardCharsets.UTF_8));if(!old.toString().equals(manifest.toString()))throw new IOException("Cache manifest changed");
            if(new File(folder,"complete").isFile())return true;
        }
        if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("Cache directory unavailable");
        if(folder.getUsableSpace()<manifest.getJSONArray("files").getJSONObject(0).getLong("size")+10485760L)throw new IOException("Insufficient device storage");
        Files.write(metadata.toPath(),manifest.toString().getBytes(StandardCharsets.UTF_8));return false;
    }
    public void put(String partition,String id,int part,byte[] bytes,String sha)throws Exception{
        File folder=folder(partition,id);JSONObject m=new JSONObject(new String(Files.readAllBytes(new File(folder,"manifest.json").toPath()),StandardCharsets.UTF_8));JSONObject f=m.getJSONArray("files").getJSONObject(0);
        int length=(int)Math.min(1048576,f.getLong("size")-(long)part*1048576);
        if(part<0||part>=f.getInt("chunks")||bytes.length!=length+28||!sha.matches("[0-9a-f]{64}"))throw new IOException("Invalid imported chunk");
        StringBuilder actual=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))actual.append(String.format("%02x",b));if(!sha.contentEquals(actual))throw new IOException("Chunk hash mismatch");
        File temp=new File(folder,UUID.randomUUID()+".part");try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}
        Files.move(temp.toPath(),new File(folder,part+".chunk").toPath(),StandardCopyOption.REPLACE_EXISTING);
    }
    public void complete(String partition,String id)throws Exception{
        File folder=folder(partition,id);JSONObject f=new JSONObject(new String(Files.readAllBytes(new File(folder,"manifest.json").toPath()),StandardCharsets.UTF_8)).getJSONArray("files").getJSONObject(0);
        for(int p=0;p<f.getInt("chunks");p++)if(new File(folder,p+".chunk").length()!=Math.min(1048576,f.getLong("size")-(long)p*1048576)+28)throw new IOException("Incomplete encrypted cache");
        new File(folder,"complete").createNewFile();
    }
    public void remove(String partition,String id)throws Exception{
        File folder=folder(partition,id);if(!folder.isDirectory())return;
        // Delete only known direct children of a verified UUID package folder.
        for(File f:Objects.requireNonNull(folder.listFiles())){if(f.isFile()&&(f.getName().matches("[0-9]+\\.chunk|[0-9a-f-]{36}\\.part|manifest\\.json|complete")))Files.deleteIfExists(f.toPath());}
        Files.deleteIfExists(folder.toPath());
    }
    public void clear(String partition)throws Exception{
        if(!partition.matches("[0-9a-f]{64}"))throw new IOException("Invalid cache partition");
        File parent=new File(root,partition);if(!parent.isDirectory())return;
        for(File folder:Objects.requireNonNull(parent.listFiles()))if(PlaybackApi.uuid(folder.getName())&&folder.isDirectory())remove(partition,folder.getName());
        Files.deleteIfExists(parent.toPath());
    }
}
