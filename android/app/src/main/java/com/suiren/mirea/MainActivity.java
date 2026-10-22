package com.suiren.mirea;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.content.res.Configuration;
import androidx.core.view.WindowCompat;
import com.suiren.mirea.update.MireaUpdaterPlugin;
import com.suiren.mirea.update.UpdateEngine;
import com.suiren.mirea.playback.MireaPlaybackPlugin;
import com.suiren.mirea.export.MireaFileExportPlugin;
import com.suiren.mirea.auth.MireaSessionPlugin;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state){UpdateEngine.setBusy(true);registerPlugin(MireaUpdaterPlugin.class);registerPlugin(MireaPlaybackPlugin.class);registerPlugin(MireaFileExportPlugin.class);registerPlugin(MireaSessionPlugin.class);registerPlugin(MireaAppearancePlugin.class);super.onCreate(state);applyAppearance(savedAppearance());}
    private String savedAppearance(){return getPreferences(MODE_PRIVATE).getString("appearance",(getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES?"dark":"light");}
    public void applyAppearance(String theme){boolean dark=theme.equals("dark");int background=dark?0xff0d121d:0xfff7f8fb,surface=dark?0xff151d2b:Color.WHITE;getPreferences(MODE_PRIVATE).edit().putString("appearance",theme).apply();getWindow().setBackgroundDrawable(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{surface,background}));getWindow().getDecorView().setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{surface,background}));getWindow().setStatusBarColor(surface);getWindow().setNavigationBarColor(background);if(android.os.Build.VERSION.SDK_INT>=29)getWindow().setNavigationBarContrastEnforced(false);WindowCompat.getInsetsController(getWindow(),getWindow().getDecorView()).setAppearanceLightStatusBars(!dark);WindowCompat.getInsetsController(getWindow(),getWindow().getDecorView()).setAppearanceLightNavigationBars(!dark);if(getBridge()!=null)getBridge().getWebView().setBackgroundColor(background);}
    @Override public void onResume(){super.onResume();applyAppearance(savedAppearance());UpdateEngine.setForeground(true);}
    @Override public void onConfigurationChanged(Configuration next){super.onConfigurationChanged(next);applyAppearance(savedAppearance());}
    @Override public void onPause(){UpdateEngine.setForeground(false);super.onPause();}
    @Override public void onDestroy(){super.onDestroy();UpdateEngine.setBusy(false);}
}
