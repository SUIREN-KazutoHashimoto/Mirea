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
    private final File root;private final Context context;
    private static final Map<String,Integer> readers=new HashMap<>();
    private static final Map<String,PlaybackCache> retired=new HashMap<>();
    public PlaybackCache(Context c){context=c.getApplicationContext();root=new File(c.getFilesDir(),"playback-ciphertext");}
    static void retain(File folder)throws IOException{synchronized(readers){if(!folder.isDirectory())throw new IOException("Saved media missing");String path=folder.getCanonicalPath();readers.put(path,readers.getOrDefault(path,0)+1);}}
    static void release(File folder){synchronized(readers){try{String path=folder.getCanonicalPath();int count=readers.getOrDefault(path,0);if(count>1){readers.put(path,count-1);return;}readers.remove(path);PlaybackCache owner=retired.get(path);if(owner!=null)owner.finishRetirement(folder);}catch(Exception ignored){/* The durable marker is retried on the next startup. */}}}
    private void finishRetirement(File folder)throws Exception{String partition=folder.getParentFile().getName(),id=folder.getName();remove(partition,id);new OfflineLease(context).revoke(partition,id);retired.remove(folder.getCanonicalPath());}
    public void retire(String partition,String id)throws Exception{synchronized(readers){File folder=folder(partition,id);if(!folder.isDirectory()){new OfflineLease(context).revoke(partition,id);return;}new File(folder,"retired").createNewFile();String path=folder.getCanonicalPath();retired.put(path,this);if(readers.getOrDefault(path,0)==0)finishRetirement(folder);}}
    public void collectRetired()throws Exception{File[] partitions=root.listFiles();if(partitions==null)return;for(File partition:partitions)if(partition.getName().matches("[0-9a-f]{64}")&&!Files.isSymbolicLink(partition.toPath())){File[] folders=partition.listFiles();if(folders==null)continue;for(File folder:folders)if(PlaybackApi.uuid(folder.getName())&&!Files.isSymbolicLink(folder.toPath())&&new File(folder,"retired").isFile())retire(partition.getName(),folder.getName());}}
    public File folder(String partition,String id)throws IOException{
        if(!partition.matches("[0-9a-f]{64}")||!PlaybackApi.uuid(id))throw new IOException("Invalid cache identity");
        File result=new File(new File(root,partition),id);if(!result.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator))throw new IOException("Invalid cache path");return result;
    }
    public boolean begin(String partition,JSONObject manifest)throws Exception{
        return begin(partition,manifest,true);
    }
    private boolean begin(String partition,JSONObject manifest,boolean reserveCopy)throws Exception{
        PlaybackSource.validateManifest(manifest);File folder=folder(partition,manifest.getString("id"));
        synchronized(readers){Files.deleteIfExists(new File(folder,"retired").toPath());retired.remove(folder.getCanonicalPath());}
        File metadata=new File(folder,"manifest.json");
        if(metadata.isFile()){
            JSONObject old=new JSONObject(new String(Files.readAllBytes(metadata.toPath()),StandardCharsets.UTF_8));if(!old.toString().equals(manifest.toString()))throw new IOException("Cache manifest changed");
            if(new File(folder,"complete").isFile()){if(ready(partition,manifest))return true;Files.deleteIfExists(new File(folder,"complete").toPath());}
        }
        if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("Cache directory unavailable");
        if(folder.getUsableSpace()<(reserveCopy?manifest.getJSONArray("files").getJSONObject(0).getLong("size"):0)+10485760L)throw new IOException("Insufficient device storage");
        Files.write(metadata.toPath(),manifest.toString().getBytes(StandardCharsets.UTF_8));return false;
    }
    public boolean ready(String partition,JSONObject manifest)throws Exception{
        PlaybackSource.validateManifest(manifest);File directory=folder(partition,manifest.getString("id")),metadata=new File(directory,"manifest.json");
        if(!new File(directory,"complete").isFile()||!metadata.isFile()||!new JSONObject(new String(Files.readAllBytes(metadata.toPath()),StandardCharsets.UTF_8)).toString().equals(manifest.toString()))return false;
        JSONObject file=manifest.getJSONArray("files").getJSONObject(0);for(int part=0;part<file.getInt("chunks");part++){File chunk=new File(directory,part+".chunk");if(!chunk.isFile()||Files.isSymbolicLink(chunk.toPath())||chunk.length()!=Math.min(1048576,file.getLong("size")-(long)part*1048576)+28)return false;}return true;
    }
    /** Keep the transfer names until WebView acknowledges the manifest. Hard links
     * share only authenticated ciphertext, never keys or decrypted media. */
    public void promote(String partition,JSONObject manifest,File encryptedSource)throws Exception{
        promote(partition,manifest,encryptedSource,()->{});
    }
    public interface Check {void run()throws Exception;}
    public void promote(String partition,JSONObject manifest,File encryptedSource,Check check)throws Exception{
        String id=manifest.getString("id");File expected=new File(new File(new File(root.getParentFile(),"transfer-ciphertext"),partition),id);
        if(!expected.getCanonicalFile().equals(encryptedSource.getCanonicalFile())||Files.isSymbolicLink(encryptedSource.toPath()))throw new IOException("Invalid promotion source");
        if(begin(partition,manifest,false))return;File target=folder(partition,id);JSONObject file=manifest.getJSONArray("files").getJSONObject(0);
        for(int part=0;part<file.getInt("chunks");part++){
            check.run();
            File source=new File(encryptedSource,"0-"+part+".chunk"),digest=new File(encryptedSource,"0-"+part+".sha256");long length=Math.min(1048576,file.getLong("size")-(long)part*1048576)+28;
            if(!source.isFile()||Files.isSymbolicLink(source.toPath())||source.length()!=length||!digest.isFile()||Files.isSymbolicLink(digest.toPath()))throw new IOException("Incomplete promotion source");
            byte[] bytes=Files.readAllBytes(source.toPath());String sha=new String(Files.readAllBytes(digest.toPath()),StandardCharsets.US_ASCII);StringBuilder actual=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))actual.append(String.format("%02x",b));
            if(!sha.matches("[0-9a-f]{64}")||!sha.contentEquals(actual))throw new IOException("Promotion integrity failed");
            File temp=new File(target,UUID.randomUUID()+".part");try{
                try{Files.createLink(temp.toPath(),source.toPath());}catch(UnsupportedOperationException|IOException unsupported){if(target.getUsableSpace()<length+10485760L)throw new IOException("Insufficient device storage",unsupported);Files.copy(source.toPath(),temp.toPath());}
                Files.move(temp.toPath(),new File(target,part+".chunk").toPath(),StandardCopyOption.REPLACE_EXISTING);
            }finally{Files.deleteIfExists(temp.toPath());}
        }
        check.run();complete(partition,id);
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
        for(File f:Objects.requireNonNull(folder.listFiles())){if(f.isFile()&&(f.getName().matches("[0-9]+\\.chunk|[0-9a-f-]{36}\\.part|manifest\\.json|complete|retired")))Files.deleteIfExists(f.toPath());}
        Files.deleteIfExists(folder.toPath());
    }
    public void clear(String partition)throws Exception{
        if(!partition.matches("[0-9a-f]{64}"))throw new IOException("Invalid cache partition");
        File parent=new File(root,partition);if(!parent.isDirectory())return;
        for(File folder:Objects.requireNonNull(parent.listFiles()))if(PlaybackApi.uuid(folder.getName())&&folder.isDirectory())remove(partition,folder.getName());
        Files.deleteIfExists(parent.toPath());
    }
}
