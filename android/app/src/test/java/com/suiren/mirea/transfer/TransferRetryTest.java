package com.suiren.mirea.transfer;

import org.junit.Test;
import static org.junit.Assert.*;

public class TransferRetryTest {
    @Test public void rateLimitsRespectSecondsAndHttpDatesWithAFiniteBound(){
        long now=java.time.Instant.parse("2026-11-02T00:00:00Z").toEpochMilli();
        assertEquals(60000,TransferEngine.retryDelay(new TransferEngine.HttpFailure(429,"60"),0,now));
        assertEquals(120000,TransferEngine.retryAfter("Mon, 2 Nov 2026 00:02:00 GMT",now,1000));
        assertEquals(300000,TransferEngine.retryAfter("99999999999",now,1000));assertEquals(1000,TransferEngine.retryAfter("invalid",now,1000));
    }
    @Test public void weakLteHasMoreThanAMinuteToRecoverWhilePermissionsIntegrityAndTlsStopImmediately(){
        long total=0;for(int n=0;n<8;n++){long delay=TransferEngine.retryDelay(new java.net.SocketTimeoutException(),n,0);assertTrue(delay>0&&delay<=30000);total+=delay;}assertTrue(total>60000);assertEquals(-1,TransferEngine.retryDelay(new java.net.SocketTimeoutException(),8,0));
        for(int status:new int[]{400,401,403,404,409,410,422})assertEquals(-1,TransferEngine.retryDelay(new TransferEngine.HttpFailure(status,"60"),0,0));
        assertEquals(-1,TransferEngine.retryDelay(new java.io.IOException("Chunk hash mismatch"),0,0));assertEquals(-1,TransferEngine.retryDelay(new javax.net.ssl.SSLException("bad certificate"),0,0));assertEquals(-1,TransferEngine.retryDelay(new org.json.JSONException("manifest"),0,0));
    }
}
