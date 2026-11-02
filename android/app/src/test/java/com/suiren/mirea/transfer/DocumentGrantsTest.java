package com.suiren.mirea.transfer;

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import com.suiren.mirea.playback.PlaybackApi;
import java.util.Map;
import java.util.Collections;
import java.util.HashSet;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class DocumentGrantsTest {
    private final Context context=RuntimeEnvironment.getApplication();
    private final ContentResolver resolver=context.getContentResolver();
    private Uri tree(){return Uri.parse("content://fixture.documents/tree/"+UUID.randomUUID());}
    private boolean persisted(Uri uri){return resolver.getPersistedUriPermissions().stream().anyMatch(p->p.getUri().equals(uri)&&p.isReadPermission());}
    private TransferEngine.Job job()throws Exception{return new TransferEngine.Job("upload",new PlaybackApi("https://mirea.example.test","a".repeat(43),UUID.randomUUID().toString()),new JSONObject());}

    @Test public void sharedFolderPermissionSurvivesPickerClosureUntilEveryQueuedTransferEnds()throws Exception{
        Uri uri=tree();DocumentGrants.Lease selection=DocumentGrants.acquire(resolver,uri,true),secondSelection=DocumentGrants.acquire(resolver,uri,true);
        TransferEngine.Job first=job(),second=job();first.sources.add(selection.retain());second.sources.add(selection.retain());
        try{
            selection.close();secondSelection.close();assertTrue(persisted(uri));
            first.cancel();assertTrue(persisted(uri));
            second.cancel();assertFalse(persisted(uri));
            second.cancel();selection.close();assertFalse(persisted(uri));
        }finally{selection.close();secondSelection.close();first.cancel();second.cancel();}
    }

    @Test public void failedSelectionReleasesItsGrantWithoutRevokingAnotherSelection(){
        Uri shared=tree(),failed=tree();DocumentGrants.Lease existing=DocumentGrants.acquire(resolver,shared,true),scanShared=DocumentGrants.acquire(resolver,shared,true),scanOther=DocumentGrants.acquire(resolver,failed,true);
        try{scanShared.close();scanOther.close();assertTrue(persisted(shared));assertFalse(persisted(failed));}
        finally{existing.close();scanShared.close();scanOther.close();}
        assertFalse(persisted(shared));
    }

    @Test public void activityRecreationKeepsRunningSourcesAndReleasesAbandonedSelections()throws Exception{
        Uri running=tree(),abandoned=tree();MireaTransferPlugin plugin=new MireaTransferPlugin();
        Map<String,Uri> selected=ReflectionHelpers.getField(plugin,"selected");Map<String,DocumentGrants.Lease> grants=ReflectionHelpers.getField(plugin,"selectedGrants");
        DocumentGrants.Lease source=DocumentGrants.acquire(resolver,running,true);grants.put("running",source);selected.put("running",running);
        grants.put("abandoned",DocumentGrants.acquire(resolver,abandoned,true));selected.put("abandoned",abandoned);
        TransferEngine.Job transfer=job();transfer.sources.add(source.retain());transfer.executing=true;
        try{
            ReflectionHelpers.callInstanceMethod(plugin,"handleOnDestroy");
            assertTrue(selected.isEmpty());assertFalse(persisted(abandoned));assertTrue(persisted(running));
            transfer.cancel();assertTrue(persisted(running)); // Worker still owns its open source until finally.
            new TransferEngine(context,()->{}).run(transfer);assertFalse(persisted(running));
        }finally{transfer.releaseSources();transfer.cancel();source.close();}
    }

    @Test public void closedSelectionsCannotResurrectPersistentAccess(){
        Uri uri=tree();DocumentGrants.Lease selection=DocumentGrants.acquire(resolver,uri,true);selection.close();
        assertThrows(IllegalStateException.class,selection::retain);assertFalse(persisted(uri));
        try(DocumentGrants.Lease fresh=DocumentGrants.acquire(resolver,uri,true)){assertTrue(persisted(uri));}
        assertFalse(persisted(uri));
    }

    @Test public void processRestartReclaimsOnlyRecordedUnusedGrantsAndActivityReloadKeepsLiveOnes(){
        Uri legacy=tree(),stale=tree(),live=tree();
        resolver.takePersistableUriPermission(legacy,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        resolver.takePersistableUriPermission(stale,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.getSharedPreferences("mirea-selected-documents-v1",0).edit().putStringSet("owned",new HashSet<>(Collections.singleton(stale.toString()))).commit();
        ReflectionHelpers.setStaticField(DocumentGrants.class,"ownership",null);
        DocumentGrants.prepare(context,Collections.singleton(live));
        assertFalse(persisted(stale));assertTrue(persisted(legacy));
        DocumentGrants.Lease selection=DocumentGrants.acquire(resolver,live,true),worker=selection.retain();
        try{
            selection.close();DocumentGrants.prepare(context,Collections.emptyList());assertTrue(persisted(live));
            // Simulate loss of all in-memory selections/jobs in a killed process.
            Map<?,?> references=ReflectionHelpers.getStaticField(DocumentGrants.class,"entries");references.clear();ReflectionHelpers.setStaticField(DocumentGrants.class,"ownership",null);
            DocumentGrants.prepare(context,Collections.emptyList());assertFalse(persisted(live));assertTrue(persisted(legacy));
        }finally{worker.close();selection.close();resolver.releasePersistableUriPermission(legacy,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);}
    }

    @Test public void serviceShutdownReleasesUndispatchedSourcesButLetsRunningWorkerCloseItsOwn()throws Exception{
        Uri queued=tree(),running=tree();TransferEngine.Job waiting=job(),active=job();
        waiting.sources.add(DocumentGrants.acquire(resolver,queued,true));active.sources.add(DocumentGrants.acquire(resolver,running,true));
        waiting.executing=true;active.executing=true;active.workerStarted=true;
        String waitingId=TransferService.offer(waiting),activeId=TransferService.offer(active);
        TransferService service=org.robolectric.Robolectric.buildService(TransferService.class).get();
        try{
            service.onDestroy();assertFalse(persisted(queued));assertFalse(waiting.executing);assertTrue(persisted(running));
            assertTrue(active.cancelled);new TransferEngine(context,()->{}).run(active);assertFalse(persisted(running));
        }finally{waiting.releaseSources();active.releaseSources();TransferService.discard(waitingId);TransferService.discard(activeId);}
    }
}
