package com.suiren.mirea.playback;
import android.app.Activity;
import android.graphics.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.*;
import java.io.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35,qualifiers="w320dp-h640dp-mdpi") @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class EqualizerPanelTest {
    @Test public void controlsFitSmallScreensApplyToTheExistingSessionAndSurfaceAvailability()throws Exception{
        try(ActivityController<Activity> controller=Robolectric.buildActivity(Activity.class).setup()){
            Activity a=controller.get();a.setTheme(com.suiren.mirea.R.style.MireaPlaybackTheme);JSONObject[] last={null};EqualizerPanel panel=new EqualizerPanel(a,new JSONObject(),(enabled,gains)->{JSONObject state=new JSONObject();try{state.put("enabled",enabled).put("available",true).put("gains",new JSONArray(gains));}catch(JSONException e){throw new AssertionError(e);}last[0]=state;return state;});a.setContentView(panel);
            panel.measure(View.MeasureSpec.makeMeasureSpec(320,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(600,View.MeasureSpec.EXACTLY));panel.layout(0,0,320,600);Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(320,panel.getWidth());for(int i=0;i<15;i++){SeekBar band=panel.findViewWithTag("eq-band-"+i);assertTrue("band width "+i+": "+band.getWidth(),band.getWidth()>=40);assertTrue("band height "+i+": "+band.getHeight(),band.getHeight()>=150);}CheckBox toggle=panel.findViewWithTag("eq-enabled");toggle.performClick();assertTrue(last[0].getBoolean("enabled"));Spinner preset=panel.findViewWithTag("eq-preset");preset.setSelection(2);Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertEquals(5,last[0].getJSONArray("gains").getDouble(0),0);
            VerticalEqSlider first=panel.findViewWithTag("eq-band-0");long now=android.os.SystemClock.uptimeMillis();MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,24,0,0),up=MotionEvent.obtain(now,now+20,MotionEvent.ACTION_UP,24,0,0);first.onTouchEvent(down);first.onTouchEvent(up);down.recycle();up.recycle();assertEquals(48,first.getProgress());assertEquals(12,last[0].getJSONArray("gains").getDouble(0),0);first.onKeyDown(KeyEvent.KEYCODE_DPAD_DOWN,new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_DPAD_DOWN));assertEquals(47,first.getProgress());
            assertTrue(panel.findViewWithTag("eq-bank") instanceof HorizontalScrollView);panel.status(new JSONObject().put("enabled",true).put("notice","利用できない音声効果です"));assertEquals("利用できない音声効果です",((TextView)panel.findViewWithTag("eq-status")).getText());
            Bitmap image=Bitmap.createBitmap(320,600,Bitmap.Config.ARGB_8888);panel.draw(new Canvas(image));File dir=new File("build/reports/player-ui");assertTrue(dir.isDirectory()||dir.mkdirs());try(FileOutputStream out=new FileOutputStream(new File(dir,"equalizer-small.png"))){image.compress(Bitmap.CompressFormat.PNG,100,out);}image.recycle();
        }
    }
}
