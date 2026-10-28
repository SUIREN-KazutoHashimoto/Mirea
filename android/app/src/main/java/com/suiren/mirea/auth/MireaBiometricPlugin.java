package com.suiren.mirea.auth;

import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.net.URI;

@CapacitorPlugin(name="MireaBiometric")
public final class MireaBiometricPlugin extends Plugin {
 private CancellationSignal pending;
 private String alias(PluginCall call)throws Exception{
  URI uri=new URI(call.getString("origin",""));String user=call.getString("userId","");
  if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!uri.getPath().isEmpty()||!user.matches("[0-9a-f-]{36}"))throw new IllegalArgumentException();
  return "mirea-biometric-"+hex(MessageDigest.getInstance("SHA-256").digest((uri+"|"+user).getBytes(StandardCharsets.UTF_8)));
 }
 private static String hex(byte[] bytes){StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format("%02x",b));return s.toString();}
 @PluginMethod public void publicKey(PluginCall call){
  if(Build.VERSION.SDK_INT<28){call.reject("この端末ではパスワードを使用してください。");return;}
  try{
   String name=alias(call);KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
   if(store.containsAlias(name))try{Signature check=Signature.getInstance("SHA256withECDSA");check.initSign((PrivateKey)store.getKey(name,null));}catch(KeyPermanentlyInvalidatedException invalid){store.deleteEntry(name);}
   if(!store.containsAlias(name)){
    KeyPairGenerator generator=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore");KeyGenParameterSpec.Builder spec=new KeyGenParameterSpec.Builder(name,KeyProperties.PURPOSE_SIGN).setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true);
    if(Build.VERSION.SDK_INT>=30)spec.setUserAuthenticationParameters(0,KeyProperties.AUTH_BIOMETRIC_STRONG);else spec.setUserAuthenticationValidityDurationSeconds(-1);
    generator.initialize(spec.build());generator.generateKeyPair();
   }
   byte[] encoded=store.getCertificate(name).getPublicKey().getEncoded();call.resolve(new JSObject().put("publicKey",Base64.encodeToString(encoded,Base64.NO_WRAP)).put("keyId",hex(MessageDigest.getInstance("SHA-256").digest(encoded))));
  }catch(Exception e){call.reject("生体認証を登録できません。端末の指紋・顔認証設定を確認してください。");}
 }
 @PluginMethod public void sign(PluginCall call){
  if(Build.VERSION.SDK_INT<28){call.reject("パスワードを使用してください。");return;}
  try{
   String challenge=call.getString("challenge","");if(!challenge.matches("[A-Za-z0-9_+/=-]{40,64}"))throw new IllegalArgumentException();
   KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);Signature signature=Signature.getInstance("SHA256withECDSA");signature.initSign((PrivateKey)store.getKey(alias(call),null));
   getActivity().runOnUiThread(()->{
    if(pending!=null){call.reject("生体認証を確認中です。");return;}pending=new CancellationSignal();
    new BiometricPrompt.Builder(getActivity()).setTitle("プライベート本棚を開く").setSubtitle("Mireaの本人確認").setNegativeButton("パスワードを使用",getActivity().getMainExecutor(),(d,w)->{pending=null;call.reject("パスワードで開いてください。");}).build().authenticate(new BiometricPrompt.CryptoObject(signature),pending,getActivity().getMainExecutor(),new BiometricPrompt.AuthenticationCallback(){
     @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result){try{Signature proof=result.getCryptoObject().getSignature();proof.update(challenge.getBytes(StandardCharsets.UTF_8));call.resolve(new JSObject().put("signature",Base64.encodeToString(proof.sign(),Base64.NO_WRAP)));}catch(Exception e){call.reject("本人確認に失敗しました。パスワードを使用してください。");}finally{pending=null;}}
     @Override public void onAuthenticationError(int code,CharSequence message){pending=null;call.reject("生体認証を完了できません。パスワードを使用してください。");}
    });
   });
  }catch(Exception e){call.reject("生体認証鍵を使用できません。パスワードで登録し直してください。");}
 }
 @Override protected void handleOnDestroy(){if(pending!=null)pending.cancel();pending=null;super.handleOnDestroy();}
}
