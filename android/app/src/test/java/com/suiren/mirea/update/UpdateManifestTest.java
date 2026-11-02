package com.suiren.mirea.update;

import static org.junit.Assert.*;
import org.junit.Before;
import org.junit.Test;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

public class UpdateManifestTest {
    private static final long NOW=1792454400000L;
    private KeyPair key;
    private String publicPem;
    private JSONObject payload;
    @Before public void setup() throws Exception {
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));key=generator.generateKeyPair();
        publicPem="-----BEGIN PUBLIC KEY-----\n"+Base64.getEncoder().encodeToString(key.getPublic().getEncoded())+"\n-----END PUBLIC KEY-----";
        payload=new JSONObject().put("schemaVersion",1).put("packageName","com.suiren.mirea").put("versionCode",4).put("versionName","0.2.4beta")
            .put("apkUrl","https://mirea.example/app.apk").put("sha256",repeat("a",64)).put("signerSha256",repeat("b",64)).put("size",1024).put("minSdk",29).put("issuedAt",NOW).put("expiresAt",NOW+86400000);
    }
    private static String repeat(String s,int n){StringBuilder b=new StringBuilder();while(n-->0)b.append(s);return b.toString();}
    private String signed(JSONObject p) throws Exception {
        byte[] bytes=p.toString().getBytes(StandardCharsets.UTF_8);Signature signature=Signature.getInstance("SHA256withECDSA");signature.initSign(key.getPrivate());signature.update(bytes);
        return new JSONObject().put("payload",Base64.getEncoder().encodeToString(bytes)).put("signature",Base64.getEncoder().encodeToString(signature.sign())).toString();
    }
    private UpdateManifest verify(String raw) throws Exception {return UpdateManifest.verify(raw,publicPem,"com.suiren.mirea",NOW);}
    private void rejected(JSONObject p) throws Exception {try{verify(signed(p));fail("Unsafe metadata accepted");}catch(AssertionError error){throw error;}catch(Exception expected){}}
    @Test public void acceptsSignedUpdate() throws Exception {UpdateManifest m=verify(signed(payload));assertEquals(4,m.versionCode);assertEquals(29,m.minSdk);assertEquals(1024,m.size);}
    @Test public void rejectsTamperedPayload() throws Exception {
        JSONObject wrapper=new JSONObject(signed(payload));wrapper.put("payload",Base64.getEncoder().encodeToString(payload.put("size",10).toString().getBytes(StandardCharsets.UTF_8)));
        try{verify(wrapper.toString());fail();}catch(java.security.SignatureException expected){}catch(Exception expected){}
    }
    @Test public void rejectsWrongPublisherKey() throws Exception {
        String raw=signed(payload);setup();try{verify(raw);fail();}catch(java.security.SignatureException expected){}catch(Exception expected){}
    }
    @Test public void rejectsExpiredFutureAndLongLivedMetadata() throws Exception {
        rejected(new JSONObject(payload.toString()).put("expiresAt",NOW));rejected(new JSONObject(payload.toString()).put("issuedAt",NOW+300001));rejected(new JSONObject(payload.toString()).put("expiresAt",NOW+8L*86400000));
    }
    @Test public void rejectsPackageVersionAndHashAbuse() throws Exception {
        rejected(new JSONObject(payload.toString()).put("packageName","other.app"));
        rejected(new JSONObject(payload.toString()).put("versionCode",0));rejected(new JSONObject(payload.toString()).put("versionCode",2147483648L));
        rejected(new JSONObject(payload.toString()).put("versionCode","4"));rejected(new JSONObject(payload.toString()).put("versionCode",4.5));
        rejected(new JSONObject(payload.toString()).put("versionName","<script>"));rejected(new JSONObject(payload.toString()).put("sha256",repeat("B",64)));
        rejected(new JSONObject(payload.toString()).put("signerSha256","a"));
    }
    @Test public void rejectsOversizeOverflowUnknownFieldsAndSchema() throws Exception {
        rejected(new JSONObject(payload.toString()).put("size",0));rejected(new JSONObject(payload.toString()).put("size",512L*1024*1024+1));
        rejected(new JSONObject(payload.toString()).put("minSdk",4294967325L));rejected(new JSONObject(payload.toString()).put("schemaVersion",2));rejected(new JSONObject(payload.toString()).put("unexpected",true));
    }
    @Test public void rejectsUnsafeUrls() throws Exception {
        for(String url:new String[]{"http://mirea.example/app.apk","https://user:pass@mirea.example/app.apk","https://mirea.example/app.apk#x","https://mirea.example:0/app.apk","file:///app.apk"})rejected(new JSONObject(payload.toString()).put("apkUrl",url));
    }
    @Test public void rejectsOversizeAndMalformedEnvelopes() throws Exception {
        try{verify(repeat(" ",65537));fail();}catch(Exception expected){}
        JSONObject raw=new JSONObject(signed(payload));raw.put("signature","A===");try{verify(raw.toString());fail();}catch(Exception expected){}
    }
    @Test public void acceptsNodePublisherDerSignature() throws Exception {
        String nodePublic="-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBw9BkizwRLKnbG/vCugMuW0ch0b6\nUJscUczLkc/9IjLQOxiHFUnIS2ojZvnrbdBLp10DXmYxSTjzSj6nwAogbA==\n-----END PUBLIC KEY-----\n";
        String nodeEnvelope="{\"payload\":\"eyJzY2hlbWFWZXJzaW9uIjoxLCJwYWNrYWdlTmFtZSI6ImNvbS5zdWlyZW4ubWlyZWEiLCJ2ZXJzaW9uQ29kZSI6NCwidmVyc2lvbk5hbWUiOiIwLjIuNGJldGEiLCJhcGtVcmwiOiJodHRwczovL21pcmVhLmV4YW1wbGUvYXBwLmFwayIsInNoYTI1NiI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJzaWduZXJTaGEyNTYiOiJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwic2l6ZSI6MTAyNCwibWluU2RrIjoyOSwiaXNzdWVkQXQiOjE3OTI0NTQ0MDAwMDAsImV4cGlyZXNBdCI6MTc5MjU0MDgwMDAwMH0=\",\"signature\":\"MEUCIQCf672HYZcKsRSvKCMDSqXBqiYOTN3XaWBlwRSYMcty5wIgSdAwBfKlVEWwK/NAwzZchkqu5YdYB/RPUAPeiwSXkIU=\"}";
        assertEquals(4,UpdateManifest.verify(nodeEnvelope,nodePublic,"com.suiren.mirea",NOW).versionCode);
    }
}
