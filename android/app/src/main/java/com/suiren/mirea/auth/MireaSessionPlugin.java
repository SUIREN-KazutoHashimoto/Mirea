package com.suiren.mirea.auth;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONObject;

@CapacitorPlugin(name="MireaSession")
public final class MireaSessionPlugin extends Plugin {
    private static final String ALIAS="mirea.remembered-session.v1";
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private SharedPreferences preferences(){return getContext().getSharedPreferences("mirea-auth-v1",Context.MODE_PRIVATE);}
    private String origin(PluginCall call)throws Exception{
        String input=call.getString("origin");if(input==null||input.length()>2048)throw new IllegalArgumentException();URI uri=new URI(input);
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!(uri.getRawPath().isEmpty()||"/".equals(uri.getRawPath()))||uri.getPort()==0||uri.getPort()>65535)throw new IllegalArgumentException();
        return new URI("https",null,uri.getHost().toLowerCase(Locale.ROOT),uri.getPort()==443?-1:uri.getPort(),"",null,null).toASCIIString();
    }
    private String slot(String origin)throws Exception{StringBuilder out=new StringBuilder("session_");for(byte b:MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8)))out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    private static synchronized SecretKey key(boolean create)throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(store.containsAlias(ALIAS))return ((KeyStore.SecretKeyEntry)store.getEntry(ALIAS,null)).getSecretKey();
        if(!create)throw new IllegalStateException();
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());return generator.generateKey();
    }
    @PluginMethod public void load(PluginCall call){perform(call,()->{
        String origin=origin(call),slot=slot(origin),encrypted=preferences().getString(slot,null);JSObject result=new JSObject();result.put("session",JSONObject.NULL);
        if(encrypted!=null){byte[] plaintext=null;try{if(encrypted.length()>21888)throw new IllegalArgumentException();plaintext=SessionCipher.decrypt(key(false),origin,Base64.decode(encrypted,Base64.NO_WRAP));result.put("session",new String(plaintext,StandardCharsets.UTF_8));}catch(Exception invalid){if(!preferences().edit().remove(slot).commit())throw new IllegalStateException();result.put("corrupt",true);}finally{if(plaintext!=null)Arrays.fill(plaintext,(byte)0);}}
        call.resolve(result);
    });}
    @PluginMethod public void save(PluginCall call){perform(call,()->{
        String origin=origin(call),value=call.getString("session");if(value==null||value.length()>16384)throw new IllegalArgumentException();byte[] plaintext=value.getBytes(StandardCharsets.UTF_8);
        try{String encrypted=Base64.encodeToString(SessionCipher.encrypt(key(true),origin,plaintext),Base64.NO_WRAP);if(!preferences().edit().putString(slot(origin),encrypted).commit())throw new IllegalStateException();call.resolve();}finally{Arrays.fill(plaintext,(byte)0);}
    });}
    @PluginMethod public void clear(PluginCall call){perform(call,()->{if(!preferences().edit().remove(slot(origin(call))).commit())throw new IllegalStateException();call.resolve();});}
    private interface Work{void run()throws Exception;}
    private void perform(PluginCall call,Work work){try{io.execute(()->{try{work.run();}catch(Exception error){call.reject("ログイン状態を安全に保存・復元できません。もう一度ログインしてください。");}});}catch(RuntimeException error){call.reject("ログイン保存処理は終了しています。");}}
    @Override protected void handleOnDestroy(){io.shutdown();super.handleOnDestroy();}
}
