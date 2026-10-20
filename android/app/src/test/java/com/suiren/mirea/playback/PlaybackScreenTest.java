package com.suiren.mirea.playback;

import android.app.Activity;
import android.graphics.*;
import android.view.*;
import android.widget.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.*;
import java.io.*;
import java.util.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PlaybackScreenTest {
    private final ArrayList<String> actions=new ArrayList<>();
    private PlaybackScreen create(Activity activity,boolean video)throws Exception{
        activity.setTheme(com.suiren.mirea.R.style.MireaPlaybackTheme);PlaybackScreen screen=new PlaybackScreen(activity,new PlaybackScreen.Actions(){public void perform(String action){actions.add(action);}public void seek(long ms){actions.add("seek:"+ms);}public void scrub(boolean value){}});
        activity.setContentView(screen);screen.setSafeInsets(16,24,16,24);screen.bind(new JSONObject().put("video",video).put("item",new JSONObject().put("title",video?"A quiet afternoon":"ネイビーブルー / A quiet afternoon")).put("prepared",true).put("playing",true).put("positionMs",65000).put("durationMs",203000).put("rate",1).put("quality","720p"),null);return screen;
    }
    private void layout(PlaybackScreen screen,int width,int height){for(int n=0;n<4;n++){screen.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));screen.layout(0,0,width,height);org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();}assertEquals("actual rendering width",width,screen.getWidth());assertEquals("actual rendering height",height,screen.getHeight());}
    private Rect bounds(View view,View root){Rect r=new Rect(0,0,view.getWidth(),view.getHeight());((ViewGroup)root).offsetDescendantRectToMyCoords(view,r);return r;}
    private void capture(PlaybackScreen screen,String name)throws Exception{Bitmap bitmap=Bitmap.createBitmap(screen.getWidth(),screen.getHeight(),Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(bitmap);canvas.drawColor(Color.rgb(9,15,28));screen.draw(canvas);File folder=new File("build/reports/playback-ui");assertTrue(folder.isDirectory()||folder.mkdirs());try(FileOutputStream out=new FileOutputStream(new File(folder,name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}bitmap.recycle();}
    @Test @Config(qualifiers="w800dp-h360dp-land-mdpi") public void videoHasCompactNonOverlappingOverlayRotateButtonAndPipHidesEveryControl()throws Exception{
        try(ActivityController<Activity> controller=Robolectric.buildActivity(Activity.class).setup()){
            PlaybackScreen screen=create(controller.get(),true);layout(screen,800,360);
            View header=screen.findViewWithTag("player-header"),footer=screen.findViewWithTag("video-footer"),transport=screen.findViewWithTag("video-transport"),rotate=screen.findViewWithTag("player-rotate");
            assertTrue(header.getHeight()<=96);assertTrue(footer.getHeight()<=160);assertTrue(bounds(transport,screen).bottom<=bounds(footer,screen).top);assertTrue(rotate.getWidth()>=48);rotate.performClick();assertEquals("rotate",actions.get(0));
            capture(screen,"video-landscape");screen.setChromeVisible(false);layout(screen,800,360);assertEquals(View.GONE,header.getVisibility());assertEquals(View.GONE,footer.getVisibility());screen.setPip(true);assertEquals(View.GONE,screen.getVisibility());
        }
    }
    @Test public void audioUsesAlbumAndTransportLayoutInPortraitWithoutVideoOptions()throws Exception{
        try(ActivityController<Activity> controller=Robolectric.buildActivity(Activity.class).setup()){
            PlaybackScreen screen=create(controller.get(),false);layout(screen,360,800);View cover=screen.findViewWithTag("audio-artwork"),transport=screen.findViewWithTag("audio-transport"),background=screen.findViewWithTag("audio-background");
            assertEquals(View.GONE,screen.findViewWithTag("player-rotate").getVisibility());assertTrue(cover.getWidth()>=156);assertEquals(cover.getWidth(),cover.getHeight());assertTrue(bounds(cover,screen).bottom<bounds(transport,screen).top);assertTrue(bounds(background,screen).bottom<=screen.getHeight());capture(screen,"audio-portrait");
            background.performClick();assertTrue(actions.contains("background"));screen.findViewWithTag("action-play").performClick();assertTrue(actions.contains("play"));
        }
    }
    @Test @Config(qualifiers="w800dp-h360dp-land-mdpi") public void audioLandscapeSeparatesArtworkAndScrollableControls()throws Exception{
        try(ActivityController<Activity> controller=Robolectric.buildActivity(Activity.class).setup()){
            PlaybackScreen screen=create(controller.get(),false);layout(screen,800,360);View cover=screen.findViewWithTag("audio-artwork"),transport=screen.findViewWithTag("audio-transport");assertTrue(bounds(cover,screen).right<bounds(transport,screen).left);assertTrue(bounds(screen.findViewWithTag("audio-background"),screen).bottom<=screen.getHeight()-24);capture(screen,"audio-landscape");
        }
    }
    @Test @Config(qualifiers="w320dp-h568dp-port-mdpi") public void smallPortraitLargeFontsRemainScrollableAndErrorsRetainReconnect()throws Exception{
        try(ActivityController<Activity> controller=Robolectric.buildActivity(Activity.class).setup()){
            android.content.res.Configuration config=new android.content.res.Configuration(controller.get().getResources().getConfiguration());config.fontScale=1.5f;controller.get().getResources().updateConfiguration(config,controller.get().getResources().getDisplayMetrics());
            PlaybackScreen screen=create(controller.get(),false);layout(screen,320,568);assertTrue(((TextView)screen.findViewWithTag("audio-title")).getTextSize()>25);LinearLayout transports=screen.findViewWithTag("audio-transport");for(int i=0;i<transports.getChildCount();i++)if(transports.getChildAt(i).getVisibility()==View.VISIBLE)assertTrue("minimum touch width",transports.getChildAt(i).getWidth()>=48);capture(screen,"audio-small");ScrollView scroll=screen.findViewWithTag("audio-scroll");scroll.fullScroll(View.FOCUS_DOWN);org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertTrue(bounds(screen.findViewWithTag("audio-background"),screen).bottom<=screen.getHeight()-24);capture(screen,"audio-small-controls");
            screen.bind(new JSONObject().put("video",true).put("error","接続を確認して、もう一度お試しください。"),null);screen.setChromeVisible(true);layout(screen,320,568);assertEquals(View.VISIBLE,screen.findViewWithTag("player-error").getVisibility());capture(screen,"video-error");
        }
    }
}
