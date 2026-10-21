package com.suiren.mirea.playback;
import android.graphics.*;import org.junit.Test;import org.junit.runner.RunWith;import org.robolectric.*;import org.robolectric.annotation.*;import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class AudioBackdropTest {
 @Test public void staticLightUsesCoverColorsAndStaysDarkBehindWhiteControls(){Bitmap cover=Bitmap.createBitmap(32,32,Bitmap.Config.ARGB_8888);cover.eraseColor(Color.MAGENTA);AudioBackdrop one=new AudioBackdrop(cover,"asset"),two=new AudioBackdrop(cover,"asset");assertArrayEquals(one.colors,two.colors);assertEquals(Color.MAGENTA,one.colors[0]);Bitmap out=Bitmap.createBitmap(100,200,Bitmap.Config.ARGB_8888);one.setBounds(0,0,100,200);one.draw(new Canvas(out));for(int y=0;y<200;y+=20)for(int x=0;x<100;x+=10){int c=out.getPixel(x,y);assertTrue(Color.red(c)<165);assertTrue(Color.green(c)<165);assertTrue(Color.blue(c)<180);}assertEquals(3,AudioBackdrop.palette(null,"asset").length);}
}
