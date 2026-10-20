package com.suiren.mirea.update;
import android.app.job.JobParameters;
import android.app.job.JobService;
import java.io.IOException;
import java.util.concurrent.*;

/** OS-scheduled work; no exact alarms, foreground service or battery bypass. */
public final class UpdateJobService extends JobService {
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private Future<?> work;
    @Override public boolean onStartJob(JobParameters params){
        work=executor.submit(()->{boolean retry=false;try{new UpdateEngine(this).run(false,true);}catch(Exception error){retry=error instanceof IOException;}if(!Thread.currentThread().isInterrupted())jobFinished(params,retry);});return true;
    }
    @Override public boolean onStopJob(JobParameters params){if(work!=null)work.cancel(true);return true;}
    @Override public void onDestroy(){executor.shutdownNow();super.onDestroy();}
}
