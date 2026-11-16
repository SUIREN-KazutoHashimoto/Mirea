package com.suiren.mirea;

import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import java.util.Collections;
import java.util.List;

/** A bounded library-only exception; the right edge and remaining left edge
 * continue to belong to Android's Back gesture. No permission is required. */
final class LibraryDrawerGesture implements AutoCloseable {
    private final View view;
    private final View.OnLayoutChangeListener layout;
    private boolean enabled, foreground, keyboardVisible, closed;
    LibraryDrawerGesture(View view) {
        this.view=view;
        layout=(v,l,t,r,b,oldL,oldT,oldR,oldB)->apply();
        view.addOnLayoutChangeListener(layout);
    }
    void setEnabled(boolean value){enabled=value;apply();}
    void setForeground(boolean value){foreground=value;apply();}
    void setKeyboardVisible(boolean value){keyboardVisible=value;apply();}
    static List<Rect> area(int width,int height,float density) {
        if(width<=0||height<=0||!Float.isFinite(density)||density<=0)return Collections.emptyList();
        int edge=Math.min(width,Math.max(1,Math.round(24*density)));
        int extent=Math.min(height,Math.max(1,Math.round(200*density)));
        int top=(height-extent)/2;
        return Collections.singletonList(new Rect(0,top,edge,top+extent));
    }
    private void apply(){
        if(Build.VERSION.SDK_INT<29)return;
        view.setSystemGestureExclusionRects(!closed&&enabled&&foreground&&!keyboardVisible
            ?area(view.getWidth(),view.getHeight(),view.getResources().getDisplayMetrics().density)
            :Collections.emptyList());
    }
    @Override public void close(){closed=true;view.removeOnLayoutChangeListener(layout);apply();}
}
