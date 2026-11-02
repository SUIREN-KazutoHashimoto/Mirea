package com.suiren.mirea.transfer;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** A selected document is readable only while a picker session or upload needs it. */
final class DocumentGrants {
    private static final Map<Uri, Entry> entries = new HashMap<>();
    private static SharedPreferences ownership;
    private static final String STORE="mirea-selected-documents-v1", KEY="owned";

    /** Called once per picker batch, before taking any persistent permission.
     * Jobs are in-memory and START_NOT_STICKY: after process death their sources
     * must be reselected. Only grants this implementation recorded are reclaimed;
     * legacy/unrelated persistent grants are left untouched. */
    static synchronized void prepare(Context context, Collection<Uri> uris) {
        if (ownership==null) {
            ownership=context.getSharedPreferences(STORE,Context.MODE_PRIVATE);
            Set<String> old=new HashSet<>(ownership.getStringSet(KEY,new HashSet<>()));
            for (String encoded:old) {
                Uri uri=Uri.parse(encoded);
                if ("content".equals(uri.getScheme())&&!entries.containsKey(uri)) {
                    try { context.getContentResolver().releasePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                    catch (SecurityException ignored) { /* Already revoked or never acquired. */ }
                }
            }
            if (!ownership.edit().remove(KEY).commit()) { ownership=null; throw new IllegalStateException("Cannot track document permissions"); }
        }
        Set<String> owned=new HashSet<>(ownership.getStringSet(KEY,new HashSet<>()));
        for (Uri uri:uris) {
            if (uri==null||!"content".equals(uri.getScheme())) throw new IllegalArgumentException();
            owned.add(uri.toString());
        }
        // A single durable write covers up to 1000 selected documents.
        if (!ownership.edit().putStringSet(KEY,owned).commit()) throw new IllegalStateException("Cannot track document permissions");
    }

    private static final class Entry {
        final ContentResolver resolver;
        final Uri uri;
        final boolean persisted;
        int references = 1;
        Entry(ContentResolver resolver, Uri uri, boolean persisted) {
            this.resolver = resolver; this.uri = uri; this.persisted = persisted;
        }
    }

    static final class Lease implements AutoCloseable {
        private final Entry entry;
        private boolean closed;
        private Lease(Entry entry) { this.entry = entry; }
        Lease retain() {
            synchronized (DocumentGrants.class) {
                if (closed) throw new IllegalStateException("Selection is no longer available");
                entry.references++;
                return new Lease(entry);
            }
        }
        @Override public void close() {
            synchronized (DocumentGrants.class) {
                if (closed) return;
                closed = true;
                if (--entry.references != 0) return;
                entries.remove(entry.uri);
                if (entry.persisted) {
                    try { entry.resolver.releasePersistableUriPermission(entry.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                    catch (SecurityException ignored) { /* The provider may already have revoked it. */ }
                }
                if (ownership!=null) {
                    Set<String> owned=new HashSet<>(ownership.getStringSet(KEY,new HashSet<>()));
                    owned.remove(entry.uri.toString());
                    // A stale record is harmless: startup only releases this
                    // app's already-unused permission, never a source file.
                    ownership.edit().putStringSet(KEY,owned).apply();
                }
            }
        }
    }

    static synchronized Lease acquire(ContentResolver resolver, Uri uri, boolean required) {
        if (uri == null || !"content".equals(uri.getScheme())) throw new IllegalArgumentException();
        Entry current = entries.get(uri);
        if (current != null) { current.references++; return new Lease(current); }
        boolean persisted = false;
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            persisted = true;
        } catch (SecurityException unavailable) {
            if (required) throw unavailable;
            // Some file providers offer only the Activity's temporary grant.
        }
        Entry entry = new Entry(resolver, uri, persisted);
        entries.put(uri, entry);
        return new Lease(entry);
    }
}
