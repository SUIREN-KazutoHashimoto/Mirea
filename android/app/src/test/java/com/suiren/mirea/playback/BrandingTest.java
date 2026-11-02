package com.suiren.mirea.playback;

import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.*;
import com.suiren.mirea.R;
import org.junit.*;
import static org.junit.Assert.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class BrandingTest {
    @Test public void adaptiveLauncherHasOpaqueVioletBackgroundAndSafeInsetOrbitForeground(){
        Context c=RuntimeEnvironment.getApplication();Drawable icon=c.getDrawable(R.drawable.mirea_launcher);assertTrue(icon instanceof AdaptiveIconDrawable);
        Drawable foreground=((AdaptiveIconDrawable)icon).getForeground();Bitmap image=Bitmap.createBitmap(108,108,Bitmap.Config.ARGB_8888);foreground.setBounds(0,0,108,108);foreground.draw(new Canvas(image));
        int opaque=0;int minX=108,maxX=0,minY=108,maxY=0;
        for(int y=0;y<108;y++)for(int x=0;x<108;x++)if(Color.alpha(image.getPixel(x,y))>200){opaque++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
        assertTrue(opaque>600);assertTrue(minX>=20);assertTrue(maxX<=87);assertTrue(minY>=34);assertTrue(maxY<=74);
        assertEquals(0,Color.alpha(image.getPixel(0,0)));assertEquals(0,Color.alpha(image.getPixel(54,15)));
    }
    @Test public void notificationEmblemHasNoOpaqueSquareAndCanBeTintedByAndroid(){
        Context c=RuntimeEnvironment.getApplication();Drawable mark=c.getDrawable(R.drawable.mirea_icon);Bitmap image=Bitmap.createBitmap(48,48,Bitmap.Config.ARGB_8888);mark.setBounds(0,0,48,48);mark.draw(new Canvas(image));
        assertEquals(0,Color.alpha(image.getPixel(0,0)));assertEquals(0,Color.alpha(image.getPixel(24,0)));
        int solid=0;for(int y=0;y<48;y++)for(int x=0;x<48;x++){int pixel=image.getPixel(x,y);if(Color.alpha(pixel)>200){solid++;assertEquals(255,Color.red(pixel));assertEquals(255,Color.green(pixel));assertEquals(255,Color.blue(pixel));}}
        assertTrue(solid>200);assertTrue(solid<48*48*.7);
    }
}
