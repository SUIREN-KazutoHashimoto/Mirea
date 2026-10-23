package com.suiren.mirea.update;

import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.*;
import android.content.pm.*;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;
import android.provider.Settings;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

public final class UpdateEngine {
    public static final String EVENT="com.suiren.mirea.UPDATE_STATE";
    private static final int JOB_ID=1296650837;
    private static final AtomicBoolean RUNNING=new AtomicBoolean(false);
    private static volatile boolean busy=false,foreground=false,playbackBusy=false,transferBusy=false;
    private final Context ctx;
    private final SharedPreferences prefs;
    private final File folder;
    private static final class Pause extends Exception {Pause(String message){super(message);}}
    public UpdateEngine(Context context){ctx=context.getApplicationContext();prefs=ctx.getSharedPreferences("mirea-updates-v1",Context.MODE_PRIVATE);folder=new File(ctx.getNoBackupFilesDir(),"app-updates");}
    public static void setForeground(boolean value){foreground=value;}
    public static void setBusy(boolean value){busy=value;}
    public static void setPlaybackBusy(boolean value){playbackBusy=value;}
    public static void setTransferBusy(boolean value){transferBusy=value;}
    public static boolean isBusy(){return busy||playbackBusy||transferBusy;}
    public void installNow() throws Exception {
        if(!RUNNING.compareAndSet(false,true))throw new Exception("更新の処理中です。");
        try{maybeInstall(true);}catch(Exception error){state("error",safeMessage(error));throw error;}finally{RUNNING.set(false);changed();}
    }
    private File part(){return new File(folder,"update.apk.part");}
    private File apk(){return new File(folder,"update.apk");}
    private void state(String value,String message){prefs.edit().putString("state",value).putString("message",message).apply();changed();}
    public void changed(){ctx.sendBroadcast(new Intent(EVENT).setPackage(ctx.getPackageName()));}
    public String publicKey() throws Exception {
        try(InputStream in=ctx.getAssets().open("update-signing-public.pem");ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] bytes=new byte[1024];int n;while((n=in.read(bytes))!=-1){if(out.size()+n>8192)throw new IOException("Trust key limit");out.write(bytes,0,n);}return new String(out.toByteArray(),StandardCharsets.UTF_8);
        }
    }
    public boolean canInstall(){return ctx.getPackageManager().canRequestPackageInstalls();}
    public boolean automatic(){return prefs.getBoolean("automatic",true);}
    public boolean unmetered(){return prefs.getBoolean("unmetered",true);}
    public boolean networkAllowed(){ConnectivityManager cm=(ConnectivityManager)ctx.getSystemService(Context.CONNECTIVITY_SERVICE);return cm.getActiveNetwork()!=null&&(!unmetered()||!cm.isActiveNetworkMetered());}
    public String source(){return prefs.getString("source","");}
    public synchronized void configure(String source,Boolean automatic,Boolean unmetered) throws Exception {
        SharedPreferences.Editor edit=prefs.edit();
        if(source!=null){URI uri=UpdateManifest.https(source);if(uri.getRawQuery()!=null||!(uri.getRawPath()==null||uri.getRawPath().isEmpty()||uri.getRawPath().equals("/")))throw new Exception("Server origin required");String value=source.replaceAll("/+$","");if(!value.equals(source()))edit.putString("source",value).putLong("lastCheckedAt",0);}
        if(automatic!=null)edit.putBoolean("automatic",automatic);if(unmetered!=null)edit.putBoolean("unmetered",unmetered);edit.commit();schedule();changed();
    }
    public void schedule(){
        JobScheduler scheduler=(JobScheduler)ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if(source().isEmpty()||!automatic()){scheduler.cancel(JOB_ID);return;}
        JobInfo existing=scheduler.getPendingJob(JOB_ID);
        if(existing!=null&&existing.getIntervalMillis()==12L*60*60*1000&&existing.getNetworkType()==(unmetered()?JobInfo.NETWORK_TYPE_UNMETERED:JobInfo.NETWORK_TYPE_ANY))return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID,new ComponentName(ctx,UpdateJobService.class)).setPeriodic(12L*60*60*1000).setPersisted(true)
            .setRequiredNetworkType(unmetered()?JobInfo.NETWORK_TYPE_UNMETERED:JobInfo.NETWORK_TYPE_ANY).setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build());
    }
    private PackageInfo installed() throws Exception{return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES);}
    private void abandonPendingSession(){
        int id=prefs.getInt("sessionId",-1);
        if(id>=0){
            PackageInstaller installer=ctx.getPackageManager().getPackageInstaller();PackageInstaller.SessionInfo info=installer.getSessionInfo(id);
            // Abandon only our own pending self-update, never another package or an installed app.
            if(info!=null&&ctx.getPackageName().equals(info.getInstallerPackageName())&&ctx.getPackageName().equals(info.getAppPackageName()))installer.abandonSession(id);
        }
        prefs.edit().remove("sessionId").remove("nonce").remove("confirmation").commit();
    }
    private void reconcileSession(){
        int id=prefs.getInt("sessionId",-1);
        if(id>=0&&ctx.getPackageManager().getPackageInstaller().getSessionInfo(id)==null){
            prefs.edit().remove("sessionId").remove("nonce").remove("confirmation").putString("state",apk().isFile()?"ready":"idle").putString("message","更新状態を確認し直してください。").commit();
        }
    }
    public JSONObject status() throws Exception {
        reconcileSession();
        PackageInfo installed=installed();
        JSONObject s=new JSONObject().put("supported",true).put("currentVersion",installed.versionName).put("currentCode",installed.getLongVersionCode())
          .put("automatic",automatic()).put("unmeteredOnly",unmetered()).put("canInstall",canInstall()).put("busy",isBusy()).put("working",RUNNING.get())
          .put("state",prefs.getString("state","idle")).put("message",prefs.getString("message","")).put("lastCheckedAt",prefs.getLong("lastCheckedAt",0))
          .put("received",part().isFile()?part().length():apk().isFile()?apk().length():0).put("sourceConfigured",!source().isEmpty());
        try{UpdateManifest m=cached();if(m!=null&&m.versionCode>installed.getLongVersionCode())s.put("nextVersion",m.versionName).put("nextCode",m.versionCode).put("total",m.size);}catch(Exception ignored){}
        return s;
    }
    public UpdateManifest cached() throws Exception {String value=prefs.getString("manifest","");return value.isEmpty()?null:UpdateManifest.verify(value,publicKey(),ctx.getPackageName(),System.currentTimeMillis());}
    public void run(boolean userInitiated,boolean download) throws Exception {
        if(!RUNNING.compareAndSet(false,true))return;
        try{
            if(source().isEmpty()||!userInitiated&&!automatic())return;
            if(!userInitiated&&isBusy())throw new Pause("閲覧・転送中のため更新を保留しています。");
            UpdateManifest old=null;try{old=cached();}catch(Exception ignored){}
            if(!userInitiated&&System.currentTimeMillis()-prefs.getLong("lastCheckedAt",0)<60*60*1000L){if(download&&old!=null&&old.versionCode>installed().getLongVersionCode())download(old,false);return;}
            checkInterrupted();state("checking","更新を確認しています…");
            String raw=readManifest(source()+"/api/v1/app-updates/android/manifest");
            UpdateManifest m=UpdateManifest.verify(raw,publicKey(),ctx.getPackageName(),System.currentTimeMillis());
            long highest=prefs.getLong("highestVersion",0);
            if(m.versionCode<highest)throw new Exception("以前に確認した版より古い更新情報です。");
            if(m.versionCode==highest&&!prefs.getString("highestHash",m.sha256).equals(m.sha256))throw new Exception("同じ版番号のAPKが変更されています。");
            if(old!=null&&old.versionCode==m.versionCode&&!old.sha256.equals(m.sha256))throw new Exception("同じ版番号のAPKが変更されています。");
            PackageInfo installed=installed();
            if(m.versionCode>installed.getLongVersionCode()&&m.minSdk>Build.VERSION.SDK_INT)throw new Exception("この更新は新しいAndroidを必要とします。");
            if(m.versionCode>installed.getLongVersionCode()&&!signer(installed).equals(m.signerSha256))throw new Exception("APKの署名が現在のアプリと異なります。自動更新・アンインストールは行いません。");
            prefs.edit().putLong("lastCheckedAt",System.currentTimeMillis()).putLong("highestVersion",m.versionCode).putString("highestHash",m.sha256).commit();
            if(m.versionCode<=installed.getLongVersionCode()){abandonPendingSession();delete(part());delete(apk());prefs.edit().remove("manifest").remove("downloadHash").commit();state("current","最新版を利用しています。");return;}
            if(!prefs.getString("downloadHash","").equals(m.sha256)){abandonPendingSession();delete(part());delete(apk());}
            prefs.edit().putString("manifest",raw).putString("downloadHash",m.sha256).commit();state("available",m.versionName+" を利用できます。");if(download)download(m,userInitiated);
        }catch(Pause paused){state("deferred",paused.getMessage());}
        catch(Exception error){state("error",safeMessage(error));throw error;}
        finally{RUNNING.set(false);changed();}
    }
    private static String safeMessage(Exception error){String message=error.getMessage();if(message!=null&&message.matches("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}].*")&&!message.contains("http"))return message;return "更新を検証・取得できません。接続先、端末の日時、空き容量、更新の署名と有効期限を確認してください。";}
    private void checkInterrupted() throws Exception {if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Update interrupted");}
    private HttpsURLConnection connect(String address,long offset) throws Exception {
        for(int redirects=0;redirects<4;redirects++){
            URI uri=UpdateManifest.https(address);HttpsURLConnection c=(HttpsURLConnection)uri.toURL().openConnection();
            c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(15000);c.setRequestProperty("Accept-Encoding","identity");c.setRequestProperty("Cache-Control","no-cache");if(offset>0)c.setRequestProperty("Range","bytes="+offset+"-");
            int code;try{code=c.getResponseCode();}catch(Exception error){c.disconnect();throw error;}
            if(code==301||code==302||code==303||code==307||code==308){String next=c.getHeaderField("Location");c.disconnect();if(next==null)throw new IOException("Missing redirect");address=uri.resolve(next).toString();continue;}return c;
        }throw new IOException("Too many update redirects");
    }
    private String readManifest(String address) throws Exception {
        HttpsURLConnection c=connect(address,0);long deadline=System.currentTimeMillis()+30000;
        try{
            if(c.getResponseCode()==404)throw new Exception("このサーバーにはアプリの更新情報がまだ公開されていません。");
            if(c.getResponseCode()!=200||c.getContentLengthLong()>65536)throw new IOException("Manifest unavailable");
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] bytes=new byte[4096];int n;while((n=in.read(bytes))!=-1){checkInterrupted();if(out.size()+n>65536||System.currentTimeMillis()>deadline)throw new IOException("Manifest limit");out.write(bytes,0,n);}return new String(out.toByteArray(),StandardCharsets.UTF_8);
            }
        }finally{c.disconnect();}
    }
    private void download(UpdateManifest m,boolean userInitiated) throws Exception {
        if(isBusy())throw new Pause("閲覧・転送が終わってから更新できます。");if(!networkAllowed())throw new Pause("Wi-Fi等の非従量制回線を待っています。");
        if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("Update folder unavailable");
        if(apk().isFile()){verifyApk(apk(),m);state("ready","更新を適用できます。");maybeInstall(false);return;}
        long offset=part().length();if(offset>m.size){delete(part());offset=0;}
        if(new StatFs(folder.getAbsolutePath()).getAvailableBytes()<m.size-offset+32L*1024*1024)throw new Exception("更新用の空き容量が不足しています。");
        if(offset<m.size){
            HttpsURLConnection c=connect(m.apkUrl,offset);long deadline=System.currentTimeMillis()+8*60*1000L;
            try{
                int code=c.getResponseCode();if(code==200)offset=0;else if(code!=206||c.getHeaderField("Content-Range")==null||!c.getHeaderField("Content-Range").matches("bytes "+offset+"-[0-9]+/"+m.size))throw new IOException("Invalid APK range response");
                state("downloading","更新をダウンロードしています…");
                try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(part(),offset>0)){
                    byte[] bytes=new byte[65536];int n;long total=offset;
                    while((n=in.read(bytes))!=-1){checkInterrupted();if(isBusy()||!networkAllowed()||!userInitiated&&!automatic())throw new Pause("閲覧・転送または回線の状態により取得を一時停止しました。");if(System.currentTimeMillis()>deadline||total+n>m.size)throw new IOException("APK transfer limit");out.write(bytes,0,n);total+=n;}
                    out.getFD().sync();if(total!=m.size)throw new IOException("Incomplete APK");
                }
            }finally{c.disconnect();}
        }
        verifyApk(part(),m);if(!part().renameTo(apk()))throw new IOException("APK publication failed");state("ready","更新を適用できます。");maybeInstall(false);
    }
    public static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return out.toString();}
    private static String signer(PackageInfo info) throws Exception {if(info.signingInfo==null||info.signingInfo.getApkContentsSigners().length!=1)throw new Exception("Single APK signer required");return hex(MessageDigest.getInstance("SHA-256").digest(info.signingInfo.getApkContentsSigners()[0].toByteArray()));}
    private void verifyApk(File file,UpdateManifest m) throws Exception {
        if(file.length()!=m.size)throw new IOException("APK size mismatch");MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new FileInputStream(file)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1){checkInterrupted();digest.update(bytes,0,n);}}
        if(!hex(digest.digest()).equals(m.sha256)){delete(file);throw new Exception("APK hash mismatch");}
        PackageInfo incoming=ctx.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),PackageManager.GET_SIGNING_CERTIFICATES),installed=installed();
        if(incoming==null||!ctx.getPackageName().equals(incoming.packageName)||incoming.getLongVersionCode()!=m.versionCode||incoming.getLongVersionCode()<=installed.getLongVersionCode()||!m.versionName.equals(incoming.versionName)||incoming.applicationInfo==null||incoming.applicationInfo.minSdkVersion!=m.minSdk||incoming.applicationInfo.minSdkVersion>Build.VERSION.SDK_INT||!signer(incoming).equals(m.signerSha256)||!signer(incoming).equals(signer(installed))){delete(file);throw new Exception("APK identity mismatch");}
    }
    public synchronized void maybeInstall(boolean userInitiated) throws Exception {
        reconcileSession();
        if(isBusy()){state("deferred","閲覧・転送が終わってから更新できます。");return;}
        // Foreground users are never surprised by a process-replacing install.
        if(!userInitiated&&(!automatic()||foreground||Build.VERSION.SDK_INT<31))return;
        if(!canInstall()){state("permission_required","Mireaからのアプリのインストールを許可してください。");return;}
        if(prefs.getInt("sessionId",-1)>=0){state("confirmation_required","Androidの更新確認を完了してください。");return;}
        UpdateManifest m=cached();if(m==null||!apk().isFile())throw new Exception("No verified update");verifyApk(apk(),m);
        PackageInstaller installer=ctx.getPackageManager().getPackageInstaller();PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);params.setAppPackageName(ctx.getPackageName());params.setSize(m.size);
        if(Build.VERSION.SDK_INT>=31)params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id=installer.createSession(params);String nonce=UUID.randomUUID().toString();
        try(PackageInstaller.Session session=installer.openSession(id)){
            try(InputStream in=new FileInputStream(apk());OutputStream out=session.openWrite("base.apk",0,m.size)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1){checkInterrupted();out.write(bytes,0,n);}session.fsync(out);}
            if(isBusy()||!userInitiated&&(!automatic()||foreground))throw new Pause("閲覧・転送やアプリ操作が終わってから更新できます。");
            prefs.edit().putInt("sessionId",id).putString("nonce",nonce).remove("confirmation").commit();
            Intent callback=new Intent(ctx,UpdateInstallReceiver.class).setAction("com.suiren.mirea.UPDATE_INSTALL").setData(Uri.parse("mirea-update://"+nonce));
            int flags=PendingIntent.FLAG_UPDATE_CURRENT|(Build.VERSION.SDK_INT>=31?PendingIntent.FLAG_MUTABLE:0);state("installing","更新を適用しています…");session.commit(PendingIntent.getBroadcast(ctx,id,callback,flags).getIntentSender());
        }catch(Exception error){try{installer.abandonSession(id);}catch(Exception ignored){}prefs.edit().remove("sessionId").remove("nonce").commit();throw error;}
    }
    public Intent permissionIntent(){return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+ctx.getPackageName()));}
    public Intent confirmation() throws Exception {
        reconcileSession();
        if(isBusy()||RUNNING.get())throw new Exception("閲覧・転送または更新の処理中です。");
        String value=prefs.getString("confirmation","");if(value.isEmpty())return null;
        UpdateManifest m=cached();if(m==null)throw new Exception("No verified update");
        Intent intent=Intent.parseUri(value,0);ResolveInfo resolved=ctx.getPackageManager().resolveActivity(intent,0);
        if(resolved==null||(resolved.activityInfo.applicationInfo.flags&(ApplicationInfo.FLAG_SYSTEM|ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))==0)throw new Exception("Invalid Android installer");return intent;
    }
    public void installResult(Intent intent){
        String nonce=prefs.getString("nonce","");int id=prefs.getInt("sessionId",-1);
        if(id<0||intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-2)!=id||intent.getData()==null||!nonce.equals(intent.getData().getHost()))return;
        int result=intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
        if(result==PackageInstaller.STATUS_PENDING_USER_ACTION){Intent confirm=Build.VERSION.SDK_INT>=33?intent.getParcelableExtra(Intent.EXTRA_INTENT,Intent.class):intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if(confirm!=null){prefs.edit().putString("confirmation",confirm.toUri(0)).commit();state("confirmation_required","Androidの確認ボタンから更新を完了してください。");}
        }else{
            prefs.edit().remove("sessionId").remove("nonce").remove("confirmation").commit();
            if(result==PackageInstaller.STATUS_SUCCESS){delete(apk());delete(part());state("current","更新が完了しました。");}else state("error","Androidが更新を完了できませんでした。元のアプリは削除していません。再試行できます。");
        }
    }
    private static void delete(File file){if(file.exists()&&!file.delete())throw new IllegalStateException("Cannot remove private update file");}
}
