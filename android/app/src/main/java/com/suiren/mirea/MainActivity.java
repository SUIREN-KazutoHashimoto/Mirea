package com.suiren.mirea;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import com.suiren.mirea.update.MireaUpdaterPlugin;
import com.suiren.mirea.update.UpdateEngine;
import com.suiren.mirea.playback.MireaPlaybackPlugin;
import com.suiren.mirea.export.MireaFileExportPlugin;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state){UpdateEngine.setBusy(true);registerPlugin(MireaUpdaterPlugin.class);registerPlugin(MireaPlaybackPlugin.class);registerPlugin(MireaFileExportPlugin.class);super.onCreate(state);}
    @Override public void onResume(){super.onResume();UpdateEngine.setForeground(true);}
    @Override public void onPause(){UpdateEngine.setForeground(false);super.onPause();}
    @Override public void onDestroy(){super.onDestroy();UpdateEngine.setBusy(false);}
}
