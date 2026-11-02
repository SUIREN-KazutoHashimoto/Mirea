package com.suiren.mirea;
import android.graphics.*;import android.graphics.drawable.Drawable;import android.app.Activity;import org.junit.Test;import org.junit.runner.RunWith;import org.robolectric.*;import org.robolectric.android.controller.ActivityController;import org.robolectric.annotation.*;import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class MainAppearanceTest {
 public static class AppearanceActivity extends MainActivity {@Override protected void load(){/* No JS bridge/network is needed for the window paint contract. */}}
 @Test public void darkAndLightPaintOutsideWebViewAndPersistAcrossResume(){try(ActivityController<AppearanceActivity> controller=Robolectric.buildActivity(AppearanceActivity.class).setup()){AppearanceActivity activity=controller.get();activity.applyAppearance("dark");Drawable background=activity.getWindow().getDecorView().getBackground();Bitmap b=Bitmap.createBitmap(60,120,Bitmap.Config.ARGB_8888);background.setBounds(0,0,60,120);background.draw(new Canvas(b));assertTrue(Color.red(b.getPixel(30,0))<50);assertTrue(Color.red(b.getPixel(30,119))<50);controller.pause().resume();assertEquals("dark",activity.getPreferences(Activity.MODE_PRIVATE).getString("appearance",""));activity.applyAppearance("light");background=activity.getWindow().getDecorView().getBackground();background.setBounds(0,0,60,120);background.draw(new Canvas(b));assertTrue(Color.red(b.getPixel(30,0))>240);assertTrue(Color.red(b.getPixel(30,119))>240);}}
 @Test public void contentInsetsSurviveScrollAndKeyboard(){
  try(ActivityController<AppearanceActivity> controller=Robolectric.buildActivity(AppearanceActivity.class).setup()){
   android.view.View content=controller.get().findViewById(android.R.id.content);
   androidx.core.view.WindowInsetsCompat insets=new androidx.core.view.WindowInsetsCompat.Builder().setInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars(),androidx.core.graphics.Insets.of(0,32,0,24)).build();
   androidx.core.view.ViewCompat.dispatchApplyWindowInsets(content,insets);assertEquals(32,content.getPaddingTop());assertEquals(24,content.getPaddingBottom());content.scrollTo(0,500);assertEquals(32,content.getPaddingTop());
   insets=new androidx.core.view.WindowInsetsCompat.Builder(insets).setInsets(androidx.core.view.WindowInsetsCompat.Type.ime(),androidx.core.graphics.Insets.of(0,0,0,250)).build();androidx.core.view.ViewCompat.dispatchApplyWindowInsets(content,insets);assertEquals(250,content.getPaddingBottom());
  }
 }
}
