package com.suiren.mirea.transfer;
import android.content.*;
import android.os.SystemClock;
import android.security.keystore.*;
import com.suiren.mirea.playback.PlaybackApi;
import java.security.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** Device/account-bound grants; large image-book manifests fit too. */
public final class TransferLease {
    interface KeyAccess{SecretKey get()throws Exception;}
    private final KeyAccess keys;
    private final SharedPreferences prefs;private static final long WINDOW=7L*86400000;
    public TransferLease(Context c){this(c,TransferLease::key);}
    TransferLease(Context c,KeyAccess keys){this.keys=keys;prefs=c.getSharedPreferences("mirea-transfer-leases-v1",Context.MODE_PRIVATE);}
    private static synchronized SecretKey key()throws Exception{
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);String alias="mirea.transfers.offline.v1";
        if(ks.containsAlias(alias))return ((KeyStore.SecretKeyEntry)ks.getEntry(alias,null)).getSecretKey();
        KeyGenerator g=KeyGenerator.getInstance("AES","AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());return g.generateKey();
    }
    public synchronized void revoke(String partition,String id){if(!partition.matches("[0-9a-f]{64}")||!PlaybackApi.uuid(id))throw new IllegalArgumentException();prefs.edit().remove(partition+"|"+id).commit();}
    private static String slot(PlaybackApi api,String id){if(!PlaybackApi.uuid(id))throw new IllegalArgumentException();return api.partition+"|"+id;}
    private void write(String slot,JSONObject record)throws Exception{
        byte[] plain=record.toString().getBytes(StandardCharsets.UTF_8);if(plain.length>524288)throw new IllegalArgumentException();
        try{Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,keys.get());c.updateAAD(slot.getBytes(StandardCharsets.UTF_8));byte[] encrypted=c.doFinal(plain),combined=new byte[12+encrypted.length];System.arraycopy(c.getIV(),0,combined,0,12);System.arraycopy(encrypted,0,combined,12,encrypted.length);if(!prefs.edit().putString(slot,Base64.getEncoder().encodeToString(combined)).commit())throw new IllegalStateException();}finally{Arrays.fill(plain,(byte)0);}
    }
    public synchronized void save(PlaybackApi api,JSONObject grant)throws Exception{
        JSONObject m=DownloadManifest.validate(grant.getJSONObject("manifest"));long issued=grant.getLong("serverTime"),expires=grant.getLong("expiresAt");
        if(!api.userId.equals(grant.getString("userId"))||expires<=issued||expires-issued>WINDOW||Base64.getDecoder().decode(grant.getString("key")).length!=32)throw new IllegalArgumentException();
        long wall=System.currentTimeMillis(),elapsed=SystemClock.elapsedRealtime();
        write(slot(api,m.getString("id")),new JSONObject().put("grant",grant).put("wall",wall).put("lastWall",wall).put("elapsed",elapsed).put("lastElapsed",elapsed));
    }
    static long remaining(JSONObject r,long wall,long elapsed)throws Exception{
        if(wall<r.getLong("lastWall")-1000||wall<r.getLong("wall")-1000)throw new IllegalStateException("Clock rollback");
        long age=Math.max(0,wall-r.getLong("wall"));if(elapsed>=r.getLong("lastElapsed"))age=Math.max(age,elapsed-r.getLong("elapsed"));
        JSONObject g=r.getJSONObject("grant");return g.getLong("expiresAt")-g.getLong("serverTime")-age;
    }
    public synchronized JSONObject load(PlaybackApi api,String id)throws Exception{
        String slot=slot(api,id),encoded=prefs.getString(slot,null);if(encoded==null||encoded.length()>710000)throw new IllegalStateException("Online authorization required");byte[] plain=null;
        try{
            byte[] encrypted=Base64.getDecoder().decode(encoded);if(encrypted.length<28)throw new IllegalArgumentException();
            Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,keys.get(),new GCMParameterSpec(128,Arrays.copyOfRange(encrypted,0,12)));c.updateAAD(slot.getBytes(StandardCharsets.UTF_8));plain=c.doFinal(encrypted,12,encrypted.length-12);
            JSONObject r=new JSONObject(new String(plain,StandardCharsets.UTF_8));long wall=System.currentTimeMillis(),elapsed=SystemClock.elapsedRealtime(),left=remaining(r,wall,elapsed);if(left<=0)throw new IllegalStateException("Offline lease expired");
            r.put("lastWall",wall).put("lastElapsed",elapsed);write(slot,r);
            return new JSONObject(r.getJSONObject("grant").toString()).put("serverTime",wall).put("expiresAt",wall+left);
        }catch(Exception error){prefs.edit().remove(slot).commit();throw error;}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
    }
    public synchronized void clear(String partition){if(!partition.matches("[0-9a-f]{64}"))throw new IllegalArgumentException();SharedPreferences.Editor e=prefs.edit();for(String name:prefs.getAll().keySet())if(name.startsWith(partition+"|"))e.remove(name);e.commit();}
}
