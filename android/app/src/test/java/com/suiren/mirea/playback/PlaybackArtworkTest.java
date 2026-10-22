package com.suiren.mirea.playback;

import android.app.*;
import android.graphics.*;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.*;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35,shadows=PlaybackArtworkTest.MetadataSession.class) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class PlaybackArtworkTest {
    // Robolectric's MediaSession has no system binder/controller metadata store.
    // Capture only that OS boundary; exercise the real service, builder and bitmap.
    @Implements(MediaSession.class) public static class MetadataSession extends org.robolectric.shadows.ShadowMediaSession {
        MediaMetadata metadata;
        @Implementation protected void setMetadata(MediaMetadata value){metadata=value;}
    }
    private static MediaMetadata metadata(MediaSession session){return ((MetadataSession)org.robolectric.shadow.api.Shadow.extract(session)).metadata;}
    @Test public void artworkIsPublishedToNotificationAndSystemMediaMetadataAndClearedForNextAsset()throws Exception{
        ServiceController<PlaybackService> controller=Robolectric.buildService(PlaybackService.class).create();PlaybackService service=controller.get();
        try{
            Bitmap cover=Bitmap.createBitmap(300,200,Bitmap.Config.ARGB_8888);cover.eraseColor(Color.BLUE);service.artwork=cover;ReflectionHelpers.setField(service,"item",new JSONObject().put("title","Artwork fixture").put("kind","audio"));
            ReflectionHelpers.callInstanceMethod(service,"updateSession");MediaSession session=ReflectionHelpers.getField(service,"session");MediaMetadata metadata=metadata(session);assertNotNull(metadata.getBitmap(MediaMetadata.METADATA_KEY_ART));assertNotNull(metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART));assertNotNull(metadata.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON));
            Notification notification=ReflectionHelpers.callInstanceMethod(service,"notification");assertNotNull(notification.getLargeIcon());assertEquals(Notification.VISIBILITY_PRIVATE,notification.visibility);assertNotNull(notification.extras.getParcelable(Notification.EXTRA_MEDIA_SESSION));
            service.artwork=null;ReflectionHelpers.callInstanceMethod(service,"updateSession");assertNull(metadata(session).getBitmap(MediaMetadata.METADATA_KEY_ART));assertNull(((Notification)ReflectionHelpers.callInstanceMethod(service,"notification")).getLargeIcon());
        }finally{controller.destroy();service.stopped.get(5,TimeUnit.SECONDS);}
    }
    @Test public void bitmapDecodeIsBoundedAndRejectsInvalidOrOversizedInput(){
        assertNull(PlaybackArtwork.decode(new byte[]{1,2,3}));assertNull(PlaybackArtwork.decode(new byte[3*1024*1024+1]));Bitmap original=Bitmap.createBitmap(1800,1000,Bitmap.Config.ARGB_8888);ByteArrayOutputStream out=new ByteArrayOutputStream();original.compress(Bitmap.CompressFormat.PNG,100,out);Bitmap decoded=PlaybackArtwork.decode(out.toByteArray());assertNotNull(decoded);assertTrue(decoded.getWidth()<=512);assertTrue(decoded.getHeight()<=512);
    }
}
