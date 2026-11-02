package com.suiren.mirea;

import android.app.Application;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.res.XmlResourceParser;
import android.os.Environment;
import java.io.File;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.xmlpull.v1.XmlPullParser;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class FileProviderScopeTest {
    private final Application app = RuntimeEnvironment.getApplication();

    @Test public void providerOnlyGrantsExplicitUrisAndIsNotExported() {
        ProviderInfo info = app.getPackageManager().resolveContentProvider(
            app.getPackageName() + ".fileprovider", PackageManager.GET_META_DATA);
        assertNotNull(info);
        assertFalse(info.exported);
        assertTrue(info.grantUriPermissions);
        assertEquals(R.xml.file_paths, info.metaData.getInt("android.support.FILE_PROVIDER_PATHS"));
    }

    @Test public void onlyCameraCaptureDirectoryIsDeclaredInPackagedResource() throws Exception {
        // FileProvider itself uses Android '/' path separators, so inspect its
        // packaged contract here rather than relying on Windows JVM URI paths.
        try (XmlResourceParser xml = app.getResources().getXml(R.xml.file_paths)) {
            int roots = 0;
            while (xml.next() != XmlPullParser.END_DOCUMENT) {
                if (xml.getEventType() != XmlPullParser.START_TAG || "paths".equals(xml.getName())) continue;
                roots++;
                assertEquals("external-files-path", xml.getName());
                assertEquals("camera_images", xml.getAttributeValue(null, "name"));
                assertEquals("Pictures/", xml.getAttributeValue(null, "path"));
                File configured = new File(app.getExternalFilesDir(null), xml.getAttributeValue(null, "path")).getCanonicalFile();
                assertEquals(app.getExternalFilesDir(Environment.DIRECTORY_PICTURES).getCanonicalFile(), configured);
                assertNotEquals(app.getCacheDir().getCanonicalFile(), configured);
                assertNotEquals(app.getFilesDir().getCanonicalFile(), configured);
                assertNotEquals(Environment.getExternalStorageDirectory().getCanonicalFile(), configured);
            }
            assertEquals(1, roots);
        }
    }
}
