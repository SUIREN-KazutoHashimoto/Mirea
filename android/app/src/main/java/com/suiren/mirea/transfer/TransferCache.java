package com.suiren.mirea.transfer;
import android.content.Context;
import com.suiren.mirea.playback.PlaybackApi;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Only authenticated AES-GCM ciphertext on disk. Never plaintext media. */
public final class TransferCache {
    private final File root;private final Context context;
    public TransferCache(Context c){context=c;root=new File(c.getFilesDir(),"transfer-ciphertext");}
    File folder(String partition,String id)throws Exception{
        if(!partition.matches("[0-9a-f]{64}")||!PlaybackApi.uuid(id))throw new IllegalArgumentException();
        File f=new File(new File(root,partition),id);if(!f.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator))throw new IllegalArgumentException();return f;
    }
    public static String hash(byte[] bytes)throws Exception{StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))s.append(String.format("%02x",b));return s.toString();}
    public JSONObject manifest(String p,String id)throws Exception{return DownloadManifest.validate(new JSONObject(new String(Files.readAllBytes(new File(folder(p,id),"manifest.json").toPath()),StandardCharsets.UTF_8)));}
    public void begin(String partition,JSONObject m)throws Exception{
        DownloadManifest.validate(m);File f=folder(partition,m.getString("id"));if(!f.isDirectory()&&!f.mkdirs())throw new IOException("Storage unavailable");
        File metadata=new File(f,"manifest.json");if(metadata.exists()&&!manifest(partition,m.getString("id")).toString().equals(m.toString()))throw new IOException("Manifest changed");
        Files.write(metadata.toPath(),m.toString().getBytes(StandardCharsets.UTF_8));
    }
    private int length(JSONObject m,int file,int part)throws Exception{
        if(file<0||file>=m.getJSONArray("files").length()||part<0)throw new IllegalArgumentException();JSONObject f=m.getJSONArray("files").getJSONObject(file);
        if(part>=f.getInt("chunks"))throw new IllegalArgumentException();return (int)Math.min(DownloadManifest.CHUNK,f.getLong("size")-(long)part*DownloadManifest.CHUNK)+28;
    }
    public byte[] get(String partition,String id,int file,int part)throws Exception{
        JSONObject m=manifest(partition,id);int length=length(m,file,part);File folder=folder(partition,id),chunk=new File(folder,file+"-"+part+".chunk"),hashFile=new File(folder,file+"-"+part+".sha256");
        if(chunk.length()!=length||!hashFile.isFile())return null;byte[] bytes=Files.readAllBytes(chunk.toPath());return hash(bytes).equals(new String(Files.readAllBytes(hashFile.toPath()),StandardCharsets.US_ASCII))?bytes:null;
    }
    public void put(String partition,String id,int file,int part,byte[] bytes,String sha)throws Exception{
        if(bytes.length!=length(manifest(partition,id),file,part)||!sha.matches("[0-9a-f]{64}")||!hash(bytes).equals(sha))throw new IOException("Encrypted chunk verification failed");
        File f=folder(partition,id),temp=new File(f,"transfer.part");
        synchronized(this){try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}Files.move(temp.toPath(),new File(f,file+"-"+part+".chunk").toPath(),StandardCopyOption.REPLACE_EXISTING);Files.write(new File(f,file+"-"+part+".sha256").toPath(),sha.getBytes(StandardCharsets.US_ASCII));}
    }
    public void complete(String p,String id)throws Exception{JSONObject m=manifest(p,id);for(int f=0;f<m.getJSONArray("files").length();f++)for(int n=0;n<m.getJSONArray("files").getJSONObject(f).getInt("chunks");n++)if(get(p,id,f,n)==null)throw new IOException("Incomplete download");new File(folder(p,id),"complete").createNewFile();}
    public JSONArray completed(String p)throws Exception{
        if(!p.matches("[0-9a-f]{64}"))throw new IllegalArgumentException();JSONArray rows=new JSONArray();File parent=new File(root,p);File[] files=parent.listFiles();if(files==null)return rows;
        for(File f:files)if(PlaybackApi.uuid(f.getName())&&new File(f,"complete").isFile())rows.put(manifest(p,f.getName()));return rows;
    }
    public void removeAsset(String p,String asset)throws Exception{
        if(!p.matches("[0-9a-f]{64}")||!PlaybackApi.uuid(asset))throw new IllegalArgumentException();
        File[] rows=new File(root,p).listFiles();if(rows==null)return;
        for(File f:rows)if(PlaybackApi.uuid(f.getName())&&asset.equals(manifest(p,f.getName()).getString("assetId"))){new TransferLease(context).revoke(p,f.getName());new com.suiren.mirea.playback.OfflineLease(context).revoke(p,f.getName());new com.suiren.mirea.playback.PlaybackCache(context).remove(p,f.getName());remove(p,f.getName());}
    }
    public void remove(String p,String id)throws Exception{
        File f=folder(p,id);if(!f.isDirectory())return;
        for(File child:Objects.requireNonNull(f.listFiles()))if(child.isFile()&&child.getName().matches("[0-9]+-[0-9]+\\.(chunk|sha256)|manifest\\.json|complete|transfer\\.part"))Files.deleteIfExists(child.toPath());
        Files.deleteIfExists(f.toPath());
    }
}
