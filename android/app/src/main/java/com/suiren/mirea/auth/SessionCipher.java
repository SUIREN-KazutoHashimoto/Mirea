package com.suiren.mirea.auth;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SessionCipher {
    private SessionCipher() {}
    public static byte[] encrypt(SecretKey key,String origin,byte[] plaintext)throws Exception{
        if(plaintext.length>16384)throw new IllegalArgumentException();
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key);cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
        byte[] iv=cipher.getIV(),encrypted=cipher.doFinal(plaintext);if(iv.length!=12)throw new IllegalStateException();
        byte[] result=new byte[13+encrypted.length];result[0]=1;System.arraycopy(iv,0,result,1,12);System.arraycopy(encrypted,0,result,13,encrypted.length);return result;
    }
    public static byte[] decrypt(SecretKey key,String origin,byte[] encrypted)throws Exception{
        if(encrypted.length<29||encrypted.length>16413||encrypted[0]!=1)throw new IllegalArgumentException();
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Arrays.copyOfRange(encrypted,1,13)));cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));return cipher.doFinal(encrypted,13,encrypted.length-13);
    }
}
