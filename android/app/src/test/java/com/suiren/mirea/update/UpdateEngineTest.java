package com.suiren.mirea.update;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import java.io.File;
import java.io.InterruptedIOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class UpdateEngineTest {
    private Context context;
    private SharedPreferences prefs;
    private UpdateEngine job,foreground;

    @Before public void setup() throws Exception {
        context=RuntimeEnvironment.getApplication();
        prefs=context.getSharedPreferences("mirea-updates-v1",Context.MODE_PRIVATE);
        prefs.edit().clear().commit();
        job=new UpdateEngine(context);foreground=new UpdateEngine(context);
        foreground.configure("https://first.example",false,true);
    }
    private static Object invoke(UpdateEngine engine,String name,Class<?>[] types,Object...args)throws Exception{
        Method method=UpdateEngine.class.getDeclaredMethod(name,types);method.setAccessible(true);
        try{return method.invoke(engine,args);}catch(InvocationTargetException error){throw (Exception)error.getCause();}
    }
    private static void invoke(UpdateEngine engine,String name)throws Exception{invoke(engine,name,new Class<?>[0]);}

    @Test public void switchingServerInvalidatesPendingUpdateButPreservesAntiRollbackAndPartialFile() throws Exception {
        File folder=new File(context.getNoBackupFilesDir(),"app-updates");assertTrue(folder.isDirectory()||folder.mkdirs());
        File partial=new File(folder,"update.apk.part");Files.write(partial.toPath(),new byte[]{1,2,3});
        prefs.edit().putString("manifest","old signed response").putString("manifestSource","https://first.example")
          .putString("downloadHash","old hash").putLong("lastCheckedAt",1234).putLong("highestVersion",52).putString("highestHash","trusted hash")
          .putInt("sessionId",120).putString("nonce","old-nonce").putString("confirmation","old installer confirmation")
          .putString("state","confirmation_required").commit();
        foreground.configure("https://second.example",null,null);
        assertEquals("https://second.example",job.source());assertNull(job.cached());
        assertEquals("idle",job.status().getString("state"));assertFalse(prefs.contains("confirmation"));assertFalse(prefs.contains("sessionId"));
        assertFalse(prefs.contains("downloadHash"));assertEquals(0,prefs.getLong("lastCheckedAt",-1));
        assertEquals(52,prefs.getLong("highestVersion",0));assertEquals("trusted hash",prefs.getString("highestHash",""));
        assertArrayEquals(new byte[]{1,2,3},Files.readAllBytes(partial.toPath()));
    }
    @Test public void inFlightWorkerCannotPublishAfterServerChangesEvenIfUserChangesBack() throws Exception {
        invoke(job,"beginOperation");
        foreground.configure("https://second.example",null,null);
        foreground.configure("https://first.example",null,null);
        assertThrows(InterruptedIOException.class,()->invoke(job,"checkInterrupted"));
        invoke(job,"state",new Class<?>[]{String.class,String.class},"error","old server failure");
        assertEquals("idle",foreground.status().getString("state"));assertEquals("",foreground.status().getString("message"));
    }
    @Test public void unchangedOriginOrPreferenceChangesDoNotCancelWorker() throws Exception {
        invoke(job,"beginOperation");
        foreground.configure("https://first.example/",null,false);
        invoke(job,"checkInterrupted");assertFalse(job.unmetered());
        invoke(job,"state",new Class<?>[]{String.class,String.class},"checking","checking fixture");
        assertEquals("checking",foreground.status().getString("state"));
    }
    @Test public void callbackFromOldServerCannotRestoreInstallerConfirmation() throws Exception {
        prefs.edit().putInt("sessionId",120).putString("nonce","old-nonce").commit();
        foreground.configure("https://second.example",null,null);
        Intent callback=new Intent().setData(Uri.parse("mirea-update://old-nonce"))
          .putExtra(PackageInstaller.EXTRA_SESSION_ID,120).putExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_PENDING_USER_ACTION)
          .putExtra(Intent.EXTRA_INTENT,new Intent("android.content.pm.action.CONFIRM_INSTALL"));
        job.installResult(callback);
        assertFalse(prefs.contains("confirmation"));assertEquals("idle",foreground.status().getString("state"));
    }
    @Test public void unboundLegacyCacheMustBeCheckedAtTheSelectedServerAgain() throws Exception {
        prefs.edit().putString("manifest","legacy cached response").remove("manifestSource").commit();
        assertNull(job.cached());
    }
    @Test public void installerFailureDistinguishesBlockedFromStorageWithoutExposingRawOsDetails() throws Exception {
        prefs.edit().putInt("sessionId",120).putString("nonce","nonce").commit();
        Intent callback=new Intent().setData(Uri.parse("mirea-update://nonce"))
          .putExtra(PackageInstaller.EXTRA_SESSION_ID,120).putExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE_BLOCKED)
          .putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE,"private /data/path secret-package https://private.example/?token=secret");
        job.installResult(callback);
        String message=foreground.status().getString("message");
        assertTrue(message.contains("拒否"));assertTrue(message.contains("Androidコード: "+PackageInstaller.STATUS_FAILURE_BLOCKED));
        assertFalse(message.contains("secret"));assertFalse(message.contains("/data"));assertFalse(message.contains("https://"));
        assertTrue(UpdateEngine.installFailureMessage(PackageInstaller.STATUS_FAILURE_STORAGE).contains("空き容量"));
        assertFalse(prefs.contains("sessionId"));assertFalse(prefs.contains("nonce"));
    }
}
