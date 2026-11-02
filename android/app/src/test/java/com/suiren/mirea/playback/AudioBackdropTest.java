package com.suiren.mirea.playback;
import android.graphics.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.*;
import org.robolectric.util.ReflectionHelpers;
import java.io.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class AudioBackdropTest {
    @Test public void cachedLightFieldsProduceVisibleMotionAcrossTheBackground()throws Exception{
        AudioBackdrop flow=new AudioBackdrop(null,"fixture");flow.setBounds(0,0,360,800);Bitmap first=Bitmap.createBitmap(360,800,Bitmap.Config.ARGB_8888),next=Bitmap.createBitmap(360,800,Bitmap.Config.ARGB_8888);flow.draw(new Canvas(first));ReflectionHelpers.setField(flow,"elapsed",2000L);flow.draw(new Canvas(next));int moving=0,samples=0;
        for(int y=10;y<800;y+=12)for(int x=10;x<360;x+=12){int a=first.getPixel(x,y),b=next.getPixel(x,y);if(Math.abs(Color.red(a)-Color.red(b))+Math.abs(Color.green(a)-Color.green(b))+Math.abs(Color.blue(a)-Color.blue(b))>18)moving++;samples++;}assertTrue("motion must affect a substantial visible area",moving>samples/3);
        File dir=new File("build/reports/player-ui");assertTrue(dir.isDirectory()||dir.mkdirs());try(FileOutputStream out=new FileOutputStream(new File(dir,"audio-flow-before.png"))){first.compress(Bitmap.CompressFormat.PNG,100,out);}try(FileOutputStream out=new FileOutputStream(new File(dir,"audio-flow-after.png"))){next.compress(Bitmap.CompressFormat.PNG,100,out);}first.recycle();next.recycle();assertFalse(flow.isRunning());
    }
}
