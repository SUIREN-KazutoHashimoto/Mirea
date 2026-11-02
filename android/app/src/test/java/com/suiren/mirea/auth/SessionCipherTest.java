package com.suiren.mirea.auth;
import static org.junit.Assert.*;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
public class SessionCipherTest {
    @Test public void authenticatedCiphertextIsRandomAndBoundToServer()throws Exception{
        KeyGenerator generator=KeyGenerator.getInstance("AES");generator.init(256);SecretKey key=generator.generateKey();byte[] raw="sample-session-token".getBytes(StandardCharsets.UTF_8);
        byte[] a=SessionCipher.encrypt(key,"https://server-a.test",raw),b=SessionCipher.encrypt(key,"https://server-a.test",raw);assertFalse(java.util.Arrays.equals(a,b));assertArrayEquals(raw,SessionCipher.decrypt(key,"https://server-a.test",a));assertFalse(new String(a,StandardCharsets.UTF_8).contains("sample-session-token"));
        assertThrows(Exception.class,()->SessionCipher.decrypt(key,"https://server-b.test",a));a[a.length-1]^=1;assertThrows(Exception.class,()->SessionCipher.decrypt(key,"https://server-a.test",a));assertThrows(Exception.class,()->SessionCipher.decrypt(key,"https://server-a.test",new byte[4]));
    }
}
