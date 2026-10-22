package com.suiren.mirea.transfer;
import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import androidx.core.app.*;
import com.suiren.mirea.MainActivity;
import com.suiren.mirea.R;
import com.suiren.mirea.update.UpdateEngine;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

/** User-initiated dataSync only; no boot/background auto-start or privileged work. */
public final class TransferService extends Service {
    public static final String EVENT="com.suiren.mirea.TRANSFER_CHANGED";private static final String CHANNEL="mirea-transfers-v1";private static final int NOTICE=120;
    private static final Map<String,TransferEngine.Job> jobs=new LinkedHashMap<>();public static volatile TransferService current;
    private final ExecutorService workers=Executors.newFixedThreadPool(3);private final Handler main=new Handler(Looper.getMainLooper());private PowerManager.WakeLock wake;private long lastNotice,reservedUntil;private boolean destroying;
    public static synchronized String offer(TransferEngine.Job job){if(jobs.values().stream().filter(TransferEngine.Job::active).count()>=1000)throw new IllegalStateException("Queue full");jobs.entrySet().removeIf(e->!e.getValue().active()&&jobs.size()>1200);jobs.put(job.id,job);return job.id;}
    public static synchronized void discard(String id){TransferEngine.Job j=jobs.remove(id);if(j!=null)j.cancel();}
    public static synchronized JSONArray status(String partition)throws Exception{JSONArray result=new JSONArray();for(TransferEngine.Job j:jobs.values())if(j.api.partition.equals(partition))result.put(j.snapshot());return result;}
    public static synchronized void cancel(String id,String partition){for(TransferEngine.Job j:jobs.values())if(j.api.partition.equals(partition)&&(id==null||j.id.equals(id)))j.cancel();if(current!=null)current.changed();}
    public static synchronized void cancelAsset(String partition,String asset){for(TransferEngine.Job j:jobs.values())if(j.direction.equals("download")&&j.api.partition.equals(partition)&&asset.equals(j.data.optString("assetId")))j.cancel();if(current!=null)current.changed();}
    private static synchronized List<TransferEngine.Job> snapshot(){return new ArrayList<>(jobs.values());}
    @Override public void onCreate(){super.onCreate();current=this;getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL,"アップロード・ダウンロード",NotificationManager.IMPORTANCE_LOW));}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent==null){stopSelf();return START_NOT_STICKY;}
        if("cancel".equals(intent.getAction())){reservedUntil=0;for(TransferEngine.Job j:snapshot())j.cancel();changed();return START_NOT_STICKY;}
        if("reserve".equals(intent.getAction())){reservedUntil=SystemClock.elapsedRealtime()+60000;UpdateEngine.setTransferBusy(true);startForegroundNow();main.postDelayed(this::changed,60000);return START_NOT_STICKY;}
        reservedUntil=0;UpdateEngine.setTransferBusy(true);startForegroundNow();String id=intent.getStringExtra("id");TransferEngine.Job job;
        synchronized(TransferService.class){job=jobs.get(id);}
        if(job!=null&&job.state.equals("queued")){job.state="running";workers.submit(()->new TransferEngine(this,this::changed).run(job));}
        changed();return START_NOT_STICKY;
    }
    private void startForegroundNow(){
        ServiceCompat.startForeground(this,NOTICE,notice(),android.os.Build.VERSION.SDK_INT>=29?ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC:0);
        if(wake==null){wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Mirea:transfers");wake.acquire(6*60*60*1000L);}
    }
    private Notification notice(){
        List<TransferEngine.Job> all=snapshot();List<TransferEngine.Job> active=new ArrayList<>();long total=0,received=0;int done=0,failed=0;
        for(TransferEngine.Job j:all){if(j.active())active.add(j);if(j.state.equals("complete"))done++;if(j.state.equals("failed"))failed++;if(j.active()){total+=j.total;received+=j.received;}}
        String title=active.isEmpty()&&reservedUntil>SystemClock.elapsedRealtime()?"転送を準備しています":active.isEmpty()?"転送が終了しました":"転送中 "+active.size()+"件";
        String text=active.isEmpty()?"完了 "+done+"件"+(failed>0?"・失敗 "+failed+"件":""):active.get(0).title+(active.get(0).state.equals("processing")?"・サーバー後処理中":"")+"・"+(total>0?received*100/total+"%":"準備中");
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b=new NotificationCompat.Builder(this,CHANNEL).setSmallIcon(R.drawable.mirea_icon).setContentTitle(title).setContentText(text).setContentIntent(open).setOnlyAlertOnce(true).setSilent(true).setOngoing(!active.isEmpty()).setAutoCancel(active.isEmpty()).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setCategory(NotificationCompat.CATEGORY_PROGRESS);
        if(!active.isEmpty()){b.setProgress(100,total>0?(int)Math.min(100,received*100/total):0,total==0);PendingIntent cancel=PendingIntent.getService(this,1,new Intent(this,TransferService.class).setAction("cancel"),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);b.addAction(0,"転送を中止",cancel);}
        return b.build();
    }
    private void changed(){main.post(()->{
        if(destroying)return;sendBroadcast(new Intent(EVENT).setPackage(getPackageName()));long now=SystemClock.elapsedRealtime();boolean active=reservedUntil>now||snapshot().stream().anyMatch(TransferEngine.Job::active);
        if(!active||now-lastNotice>=500){lastNotice=now;try{NotificationManagerCompat.from(this).notify(NOTICE,notice());}catch(SecurityException ignored){}}
        if(!active){UpdateEngine.setTransferBusy(false);stopForeground(STOP_FOREGROUND_DETACH);stopSelf();}
    });}
    @Override public void onTimeout(int startId,int type){for(TransferEngine.Job j:snapshot())j.cancel();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
    @Override public void onDestroy(){destroying=true;for(TransferEngine.Job j:snapshot())if(j.active())j.cancel();workers.shutdownNow();if(wake!=null&&wake.isHeld())wake.release();current=null;UpdateEngine.setTransferBusy(false);super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
