package com.suiren.mirea;

import android.content.pm.ApplicationInfo;
import android.content.res.XmlResourceParser;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.xmlpull.v1.XmlPullParser;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class BackupPolicyTest {
    @Test public void packagedManifestDisablesBackupAndReferencesTransferRules() throws Exception {
        ApplicationInfo app = RuntimeEnvironment.getApplication().getApplicationInfo();
        assertEquals(0, app.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        // Robolectric's package parser leaves the newer hidden ApplicationInfo
        // field at zero. Read the actual binary manifest from the test APK,
        // including its compiled resource reference, instead of that shadow.
        boolean application = false;
        String android = "http://schemas.android.com/apk/res/android";
        try (XmlResourceParser xml = RuntimeEnvironment.getApplication().getAssets().openXmlResourceParser("AndroidManifest.xml")) {
            while (xml.next() != XmlPullParser.END_DOCUMENT) {
                if (xml.getEventType() != XmlPullParser.START_TAG) continue;
                if ("manifest".equals(xml.getName())) assertEquals("com.suiren.mirea", xml.getAttributeValue(null, "package"));
                if (!"application".equals(xml.getName())) continue;
                assertFalse(xml.getAttributeBooleanValue(android, "allowBackup", true));
                assertFalse(xml.getAttributeBooleanValue(android, "fullBackupContent", true));
                assertEquals(R.xml.data_extraction_rules, xml.getAttributeResourceValue(android, "dataExtractionRules", 0));
                application = true;
                break;
            }
        }
        assertTrue("Packaged application element is required", application);
    }

    @Test public void packagedRulesExcludeEveryStorageDomainForBothTransports() throws Exception {
        Set<String> domains = Set.of("root", "file", "database", "sharedpref", "external",
            "device_root", "device_file", "device_database", "device_sharedpref");
        Map<String, Set<String>> excluded = new HashMap<>();
        String section = null;
        try (XmlResourceParser xml = RuntimeEnvironment.getApplication().getResources().getXml(R.xml.data_extraction_rules)) {
            while (xml.next() != XmlPullParser.END_DOCUMENT) {
                if (xml.getEventType() == XmlPullParser.END_TAG && xml.getName().equals(section)) { section = null; continue; }
                if (xml.getEventType() != XmlPullParser.START_TAG) continue;
                String name = xml.getName();
                if ("data-extraction-rules".equals(name)) continue;
                if ("cloud-backup".equals(name) || "device-transfer".equals(name)) {
                    assertNull(excluded.put(name, new HashSet<>())); section = name; continue;
                }
                assertEquals("exclude", name);
                assertNotNull(section);
                assertEquals(".", xml.getAttributeValue(null, "path"));
                assertTrue(excluded.get(section).add(xml.getAttributeValue(null, "domain")));
            }
        }
        assertEquals(Set.of("cloud-backup", "device-transfer"), excluded.keySet());
        for (Set<String> actual : excluded.values()) assertEquals(domains, actual);
    }
}
