package com.suiren.mirea.update;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/** No URL, version or hash is trusted until the pinned publisher signature passes. */
public final class UpdateManifest {
    public static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    public final String envelope, packageName, versionName, apkUrl, sha256, signerSha256;
    public final long versionCode, size, issuedAt, expiresAt;
    public final int minSdk;
    private UpdateManifest(String raw, JSONObject p) throws Exception {
        envelope=raw;packageName=p.getString("packageName");versionName=p.getString("versionName");apkUrl=p.getString("apkUrl");sha256=p.getString("sha256");signerSha256=p.getString("signerSha256");
        versionCode=integer(p,"versionCode");size=integer(p,"size");issuedAt=integer(p,"issuedAt");expiresAt=integer(p,"expiresAt");
        long sdk=integer(p,"minSdk");if(sdk<29||sdk>100)throw new Exception("Invalid SDK level");minSdk=(int)sdk;
    }
    private static long integer(JSONObject p,String key) throws Exception {
        Object value=p.get(key);if(!(value instanceof Integer)&&!(value instanceof Long))throw new Exception("Invalid integer: "+key);return ((Number)value).longValue();
    }
    public static URI https(String url) throws Exception {
        URI uri=new URI(url);
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawFragment()!=null||uri.getPort()==0||uri.getPort()>65535)throw new Exception("HTTPS URL required");
        return uri;
    }
    public static UpdateManifest verify(String raw,String publicPem,String expectedPackage,long now) throws Exception {
        if(raw.length()>65536)throw new Exception("Update manifest too large");JSONObject wrapper=new JSONObject(raw);
        if(wrapper.length()!=2||!(wrapper.get("payload") instanceof String)||!(wrapper.get("signature") instanceof String))throw new Exception("Invalid signed envelope");
        byte[] payload=Base64.getDecoder().decode(wrapper.getString("payload")),signature=Base64.getDecoder().decode(wrapper.getString("signature"));
        if(payload.length==0||payload.length>32768||signature.length==0||signature.length>80||!Base64.getEncoder().encodeToString(payload).equals(wrapper.getString("payload"))||!Base64.getEncoder().encodeToString(signature).equals(wrapper.getString("signature")))throw new Exception("Update signature limit exceeded");
        String base64=publicPem.replace("-----BEGIN PUBLIC KEY-----","").replace("-----END PUBLIC KEY-----","").replaceAll("\\s","");
        PublicKey key=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(base64)));
        if(!(key instanceof ECPublicKey)||((ECPublicKey)key).getParams().getCurve().getField().getFieldSize()!=256)throw new Exception("Invalid update trust key");
        Signature verifier=Signature.getInstance("SHA256withECDSA");verifier.initVerify(key);verifier.update(payload);
        if(!verifier.verify(signature))throw new Exception("Update signature mismatch");
        JSONObject p=new JSONObject(new String(payload,StandardCharsets.UTF_8));
        Set<String> fields=new HashSet<>(java.util.Arrays.asList("schemaVersion","packageName","versionCode","versionName","apkUrl","sha256","signerSha256","size","minSdk","issuedAt","expiresAt"));
        if(p.length()!=fields.size()||integer(p,"schemaVersion")!=1)throw new Exception("Unsupported update manifest");
        for(String field:fields)if(!p.has(field))throw new Exception("Missing update field");
        for(String name:java.util.Arrays.asList("packageName","versionName","apkUrl","sha256","signerSha256"))if(!(p.get(name) instanceof String))throw new Exception("String required");
        UpdateManifest m=new UpdateManifest(raw,p);
        if(!expectedPackage.equals(m.packageName)||!m.versionName.matches("[A-Za-z0-9._+\\-]{1,64}")||m.versionCode<1||m.versionCode>2147483647L||m.size<1||m.size>MAX_APK_BYTES||!m.sha256.matches("[a-f0-9]{64}")||!m.signerSha256.matches("[a-f0-9]{64}"))throw new Exception("Invalid update metadata");
        if(m.issuedAt<0||m.issuedAt>now+300000||m.expiresAt<=now||m.expiresAt<=m.issuedAt||m.expiresAt-m.issuedAt>7L*86400000)throw new Exception("Update metadata expired or device clock incorrect");
        https(m.apkUrl);return m;
    }
}
