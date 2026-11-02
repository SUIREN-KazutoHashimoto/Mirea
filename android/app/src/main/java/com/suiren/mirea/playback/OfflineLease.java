package com.suiren.mirea.playback;

import android.content.*;
import android.os.SystemClock;
import android.security.keystore.*;
import com.suiren.mirea.auth.SessionCipher;
import java.security.KeyStore;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.crypto.*;
import org.json.*;

/** Device/account-bound encrypted content grants. No plaintext keys on disk. */
public final class OfflineLease {
    public static final long WINDOW=7L*86400000;
    private static final String ALIAS="mirea.offline-downloads.v1";
    interface KeyAccess{SecretKey get(boolean create)throws Exception;}
    private final SharedPreferences prefs;private final KeyAccess keys;
    public OfflineLease(Context context){this(context,OfflineLease::key);}
    OfflineLease(Context context,KeyAccess keys){prefs=context.getSharedPreferences("mirea-offline-v1",Context.MODE_PRIVATE);this.keys=keys;}
    private static synchronized SecretKey key(boolean create)throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(store.containsAlias(ALIAS))return ((KeyStore.SecretKeyEntry)store.getEntry(ALIAS,null)).getSecretKey();
        if(!create)throw new IllegalStateException("Offline key missing");
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());return generator.generateKey();
    }
    private static String slot(String partition,String id)throws Exception{
        if(!partition.matches("[0-9a-f]{64}")||!PlaybackApi.uuid(id))throw new IllegalArgumentException();return partition+"|"+id;
    }
    private void write(String name,JSONObject data)throws Exception{
        byte[] plain=data.toString().getBytes(StandardCharsets.UTF_8);
        try{String sealed=Base64.getEncoder().encodeToString(SessionCipher.encrypt(keys.get(true),name,plain));if(!prefs.edit().putString(name,sealed).commit())throw new IllegalStateException("Cannot save offline lease");}finally{Arrays.fill(plain,(byte)0);}
    }
    public synchronized void save(PlaybackApi api,JSONObject grant)throws Exception{
        JSONObject manifest=grant.getJSONObject("manifest");PlaybackSource.validateManifest(manifest);
        long issued=grant.getLong("serverTime"),expires=grant.getLong("expiresAt");
        if(!api.userId.equals(grant.getString("userId"))||expires<=issued||expires-issued>WINDOW||Base64.getDecoder().decode(grant.getString("key")).length!=32)throw new IllegalArgumentException("Invalid lease");
        long wall=System.currentTimeMillis();
        write(slot(api.partition,manifest.getString("id")),new JSONObject().put("grant",grant).put("wall",wall).put("lastWall",wall).put("elapsed",SystemClock.elapsedRealtime()).put("lastElapsed",SystemClock.elapsedRealtime()));
    }
    // Wall clock rollback fails closed across restarts/reboots. elapsedRealtime
    // bounds the lease during one boot, even if the wall clock is held back.
    static long remaining(JSONObject record,long wall,long elapsed)throws Exception{
        if(wall<record.getLong("lastWall")-1000||wall<record.getLong("wall")-1000)throw new IllegalStateException("Clock moved backwards");
        long age=Math.max(0,wall-record.getLong("wall"));
        if(elapsed>=record.getLong("lastElapsed"))age=Math.max(age,elapsed-record.getLong("elapsed"));
        JSONObject grant=record.getJSONObject("grant");return grant.getLong("expiresAt")-grant.getLong("serverTime")-age;
    }
    public synchronized JSONObject load(PlaybackApi api,String id)throws Exception{
        String name=slot(api.partition,id),encoded=prefs.getString(name,null);if(encoded==null)throw new IllegalStateException("Online authorization required");
        byte[] plain=null;
        try{
            plain=SessionCipher.decrypt(keys.get(false),name,Base64.getDecoder().decode(encoded));JSONObject record=new JSONObject(new String(plain,StandardCharsets.UTF_8));
            long wall=System.currentTimeMillis(),elapsed=SystemClock.elapsedRealtime(),remaining=remaining(record,wall,elapsed);if(remaining<=0)throw new IllegalStateException("Offline authorization expired");
            record.put("lastWall",Math.max(wall,record.getLong("lastWall"))).put("lastElapsed",elapsed);write(name,record);
            return new JSONObject(record.getJSONObject("grant").toString()).put("expiresAt",wall+remaining);
        }catch(Exception invalid){revoke(api.partition,id);throw invalid;}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
    }
    public JSONObject authorize(PlaybackApi api,String id)throws Exception{
        try{JSONObject grant=api.json("/downloads/"+id+"/open","POST",null);save(api,grant);return load(api,id);}
        catch(PlaybackApi.Failure denied){if(denied.status<500&&denied.status!=429){revoke(api.partition,id);throw denied;}return load(api,id);}
        catch(java.io.IOException unavailable){return load(api,id);}
    }
    public synchronized void revoke(String partition,String id)throws Exception{if(!prefs.edit().remove(slot(partition,id)).commit())throw new IllegalStateException();}
    public synchronized void clear(String partition)throws Exception{
        if(!partition.matches("[0-9a-f]{64}"))throw new IllegalArgumentException();SharedPreferences.Editor edit=prefs.edit();
        for(String name:prefs.getAll().keySet())if(name.startsWith(partition+"|"))edit.remove(name);if(!edit.commit())throw new IllegalStateException();
    }
}
