package com.suiren.mirea.update;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Explicit, non-exported PackageInstaller callback. Never launches UI in background. */
public final class UpdateInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        try{new UpdateEngine(context).installResult(intent);}catch(Exception ignored){/* Private cache cleanup must not crash a successfully updated app. */}
    }
}
