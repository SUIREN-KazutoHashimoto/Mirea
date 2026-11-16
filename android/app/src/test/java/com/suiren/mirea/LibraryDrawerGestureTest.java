package com.suiren.mirea;
import android.graphics.Rect;
import android.view.View;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class LibraryDrawerGestureTest {
 @Test public void areaIsBoundedAndKeepsTheRightAndRemainingLeftEdgeAvailable(){
  Rect area=LibraryDrawerGesture.area(800,1200,2).get(0);
  assertEquals(new Rect(0,400,48,800),area);
  assertEquals(new Rect(0,0,10,20),LibraryDrawerGesture.area(10,20,3).get(0));
  assertTrue(LibraryDrawerGesture.area(0,20,1).isEmpty());assertTrue(LibraryDrawerGesture.area(800,1200,Float.NaN).isEmpty());
 }
 @Test public void onlyAnEnabledForegroundLibraryReservesTheAreaAndKeyboardAndDisposalReleaseIt(){
  View view=new View(RuntimeEnvironment.getApplication());view.layout(0,0,800,1200);LibraryDrawerGesture gestures=new LibraryDrawerGesture(view);
  gestures.setEnabled(true);assertTrue(view.getSystemGestureExclusionRects().isEmpty());gestures.setForeground(true);assertEquals(1,view.getSystemGestureExclusionRects().size());
  gestures.setKeyboardVisible(true);assertTrue(view.getSystemGestureExclusionRects().isEmpty());gestures.setKeyboardVisible(false);assertEquals(1,view.getSystemGestureExclusionRects().size());
  gestures.setForeground(false);assertTrue(view.getSystemGestureExclusionRects().isEmpty());gestures.setForeground(true);assertEquals(1,view.getSystemGestureExclusionRects().size());
  gestures.setEnabled(false);assertTrue(view.getSystemGestureExclusionRects().isEmpty());gestures.setEnabled(true);view.layout(0,0,1000,600);assertEquals(LibraryDrawerGesture.area(1000,600,view.getResources().getDisplayMetrics().density),view.getSystemGestureExclusionRects());
  gestures.close();assertTrue(view.getSystemGestureExclusionRects().isEmpty());gestures.setEnabled(true);view.layout(0,0,800,1200);assertTrue(view.getSystemGestureExclusionRects().isEmpty());
 }
 @Test @Config(sdk=29) public void oldestSupportedAndroidReservesAndReleasesOnlyTheLibraryArea(){
  View view=new View(RuntimeEnvironment.getApplication());view.layout(0,0,500,900);try(LibraryDrawerGesture gestures=new LibraryDrawerGesture(view)){gestures.setForeground(true);gestures.setEnabled(true);assertEquals(1,view.getSystemGestureExclusionRects().size());gestures.setKeyboardVisible(true);assertTrue(view.getSystemGestureExclusionRects().isEmpty());}
  assertTrue(view.getSystemGestureExclusionRects().isEmpty());
 }
}
