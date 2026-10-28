package com.suiren.mirea.playback;
import android.graphics.*;
import android.view.View;
import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.DataSpec;
import java.io.*;
import java.net.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PlaybackBufferTest {
    final String id="12345678-1234-1234-1234-123456789abc",path="/api/v1/items/"+id+"/content?ticket="+"b".repeat(43);
    @Test public void progressiveReadsUseOneContinuousAuthenticatedResponseAndRejectChangedLengthOrOrigin()throws Exception{
        byte[] media=new byte[2*1024*1024];for(int n=0;n<media.length;n++)media[n]=(byte)(n%251);int[] requests={0};
        PlaybackApi api=new PlaybackApi("https://mirea.example","a".repeat(43),id);
        AdaptivePlayback.ProgressiveSource source=new AdaptivePlayback.ProgressiveSource(api,id,path,media.length,requested->{assertEquals(path,requested);requests[0]++;return new HttpURLConnection(new URL(api.origin+requested)){
            public void disconnect(){}public boolean usingProxy(){return false;}public void connect(){}public int getResponseCode(){return 200;}public long getContentLengthLong(){return media.length;}public InputStream getInputStream(){return new ByteArrayInputStream(media);}
        };});
        try{assertEquals(media.length,source.open(new DataSpec(Uri.parse(api.origin+path))));ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] block=new byte[32768];int n;while((n=source.read(block,0,block.length))!=C.RESULT_END_OF_INPUT)bytes.write(block,0,n);assertArrayEquals(media,bytes.toByteArray());assertEquals(1,requests[0]);}finally{source.close();}
        try{source.open(new DataSpec(Uri.parse("https://other.example"+path)));fail();}catch(IOException expected){}assertEquals(1,requests[0]);
        AdaptivePlayback.ProgressiveSource.validateRange(90,20,100,206,10,"bytes 90-99/100");
        for(String range:new String[]{"bytes 90-99/101","bytes 89-98/100",null})try{AdaptivePlayback.ProgressiveSource.validateRange(90,20,100,206,10,range);fail();}catch(IOException expected){}
        try{AdaptivePlayback.ProgressiveSource.validateRange(0,C.LENGTH_UNSET,100,200,99,null);fail();}catch(IOException expected){}
        api.close();try{source.read(block(),0,1);fail();}catch(IOException expected){}
    }
    private byte[] block(){return new byte[1];}
    @Test public void aheadBufferIsBoundedOnSmallAndLargeHeaps(){for(long heap:new long[]{64L<<20,128L<<20,256L<<20,1024L<<20}){int bytes=AdaptivePlayback.bufferBytes(heap);assertTrue(bytes>=8*1024*1024);assertTrue(bytes<=64*1024*1024);assertTrue(bytes<=heap/8);}}
    @Test @Config(sdk={29,35}) public void videoSeekTrackAndKnobActuallyRenderInPlatformPlayerTheme(){
        android.app.Activity activity=Robolectric.buildActivity(android.app.Activity.class).setup().get();activity.setTheme(com.suiren.mirea.R.style.MireaPlaybackTheme);
        ChapterSeekBar seek=new ChapterSeekBar(activity);seek.setMax(10000);seek.setPadding(7,0,7,0);seek.setProgress(4000);seek.measure(View.MeasureSpec.makeMeasureSpec(300,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(44,View.MeasureSpec.EXACTLY));seek.layout(0,0,300,44);
        for(boolean enabled:new boolean[]{true,false}){seek.setEnabled(enabled);Bitmap image=Bitmap.createBitmap(300,44,Bitmap.Config.ARGB_8888);seek.draw(new Canvas(image));int played=image.getPixel(35,22),future=image.getPixel(265,22);assertTrue("played track visible",Color.alpha(played)>100);assertTrue("remaining track visible",Color.alpha(future)>100);assertNotEquals("progress distinguishable",played,future);assertTrue("thumb has height",seek.getThumb().getBounds().height()>=14);image.recycle();}
        activity.finish();
    }
}
